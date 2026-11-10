"""Read PE imports and query system DLL exports without invoking imported/device APIs."""
import ctypes
import glob
import json
import struct
import sys
from pathlib import Path


def imported_symbols(data):
    def u16(at): return struct.unpack_from('<H', data, at)[0]
    def u32(at): return struct.unpack_from('<I', data, at)[0]
    if data[:2] != b'MZ': raise ValueError('Not a PE file')
    pe = u32(0x3c)
    if data[pe:pe + 4] != b'PE\0\0': raise ValueError('Invalid PE signature')
    count, optional_size, optional = u16(pe + 6), u16(pe + 20), pe + 24
    magic = u16(optional)
    if magic not in (0x10b, 0x20b): raise ValueError('Unsupported PE optional header')
    width = 8 if magic == 0x20b else 4
    directory = optional + (112 if width == 8 else 96)
    import_rva = u32(directory + 8)
    sections = optional + optional_size

    def offset(rva):
        if rva < u32(optional + 60): return rva
        for n in range(count):
            at = sections + n * 40
            virtual_size, address, raw_size, raw = struct.unpack_from('<IIII', data, at + 8)
            if address <= rva < address + max(virtual_size, raw_size): return raw + rva - address
        raise ValueError('Unmapped PE RVA')

    def string(rva, hint=0):
        at = offset(rva) + hint
        return data[at:data.index(b'\0', at)].decode('ascii')

    if not import_rva: return []
    records, at = [], offset(import_rva)
    while True:
        original, stamp, forwarder, name, first = struct.unpack_from('<IIIII', data, at)
        if not any((original, stamp, forwarder, name, first)): return records
        symbols, thunk = [], offset(original or first)
        while True:
            value = struct.unpack_from('<Q' if width == 8 else '<I', data, thunk)[0]
            if not value: break
            symbols.append(value & 0xffff if value & (1 << (width * 8 - 1)) else string(value, 2))
            thunk += width
        records.append((string(name), symbols))
        at += 20


def inspect(path):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LoadLibraryExW.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_uint32]
    kernel.LoadLibraryExW.restype = ctypes.c_void_p
    kernel.GetProcAddress.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel.GetProcAddress.restype = ctypes.c_void_p
    kernel.FreeLibrary.argtypes = [ctypes.c_void_p]
    records = []
    for dll, symbols in imported_symbols(path.read_bytes()):
        handle = kernel.LoadLibraryExW(dll, None, 0x800)  # LOAD_LIBRARY_SEARCH_SYSTEM32
        if not handle:
            records.append({'dll': dll, 'loadError': ctypes.get_last_error()})
            continue
        try:
            missing = []
            for symbol in symbols:
                buffer = ctypes.create_string_buffer(symbol.encode()) if isinstance(symbol, str) else None
                address = ctypes.cast(buffer, ctypes.c_void_p) if buffer is not None else ctypes.c_void_p(symbol)
                if not kernel.GetProcAddress(handle, address): missing.append(symbol)
            record={'dll':dll,'imports':len(symbols),'missingExports':missing}
            if dll.lower()=='comctl32.dll':
                kernel.GetModuleFileNameW.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p,ctypes.c_uint32]
                path_buffer=ctypes.create_unicode_buffer(32768);kernel.GetModuleFileNameW(handle,path_buffer,len(path_buffer));record.update(importedNames=symbols,modulePath=path_buffer.value,fileVersion=file_version(path_buffer.value))
            records.append(record)
        finally:
            kernel.FreeLibrary(handle)
    return {'binary': path.name, 'dlls': records}




def pe_manifests(data):
    def u16(at): return struct.unpack_from('<H', data, at)[0]
    def u32(at): return struct.unpack_from('<I', data, at)[0]
    pe = u32(0x3c)
    optional, sections = pe + 24, pe + 24 + u16(pe + 20)
    directory = optional + (112 if u16(optional) == 0x20b else 96)
    resource_rva = u32(directory + 16)
    if not resource_rva: return []

    def offset(rva):
        if rva < u32(optional + 60): return rva
        for n in range(u16(pe + 6)):
            virtual_size, address, raw_size, raw = struct.unpack_from('<IIII', data, sections + n * 40 + 8)
            if address <= rva < address + max(virtual_size, raw_size): return raw + rva - address
        raise ValueError('Unmapped resource RVA')

    base, result = offset(resource_rva), []

    def visit(relative, ids=()):
        at = base + relative
        for n in range(u16(at + 12) + u16(at + 14)):
            name, target = struct.unpack_from('<II', data, at + 16 + n * 8)
            if not ids and name != 24: continue  # RT_MANIFEST
            path = ids + (name,)
            if target & 0x80000000:
                visit(target & 0x7fffffff, path)
            else:
                rva, size = struct.unpack_from('<II', data, base + target)
                raw = data[offset(rva):offset(rva) + size]
                text = raw.decode('utf-16' if raw[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig', errors='replace')
                result.append({'resourceIds': path, 'xml': text, 'commonControlsV6': 'Microsoft.Windows.Common-Controls' in text and '6.0.0.0' in text})
    visit(0)
    return result


def file_version(path):
    version = ctypes.WinDLL('version', use_last_error=True)
    version.GetFileVersionInfoSizeW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint32)]
    version.GetFileVersionInfoSizeW.restype = ctypes.c_uint32
    ignored = ctypes.c_uint32()
    size = version.GetFileVersionInfoSizeW(path, ctypes.byref(ignored))
    if not size: return None
    buffer = ctypes.create_string_buffer(size)
    version.GetFileVersionInfoW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    if not version.GetFileVersionInfoW(path, 0, size, buffer): return None
    fixed, length = ctypes.c_void_p(), ctypes.c_uint32()
    version.VerQueryValueW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_uint32)]
    if not version.VerQueryValueW(buffer, '\\', ctypes.byref(fixed), ctypes.byref(length)): return None
    values = ctypes.cast(fixed, ctypes.POINTER(ctypes.c_uint32))
    return '.'.join(str(v) for v in (values[2] >> 16, values[2] & 65535, values[3] >> 16, values[3] & 65535))


def activation_context_evidence(test_paths):
    import subprocess
    import tempfile
    import os
    symbols = sorted({s for path in test_paths for dll, names in imported_symbols(path.read_bytes()) if dll.lower() == 'comctl32.dll' for s in names if isinstance(s, str)})
    print(json.dumps({'comctl32ImportedNames': symbols}), flush=True)
    probe_source = r'''
use std::{ffi::{c_void,CString},ptr};
#[link(name="kernel32")]
extern "system" {
 fn LoadLibraryExW(name:*const u16,file:*mut c_void,flags:u32)->*mut c_void;
 fn GetProcAddress(module:*mut c_void,name:*const u8)->*mut c_void;
 fn GetModuleFileNameW(module:*mut c_void,name:*mut u16,size:u32)->u32;
 fn GetLastError()->u32;
 fn FreeLibrary(module:*mut c_void)->i32;
}
fn main(){unsafe{
 let name:Vec<u16>="comctl32.dll\0".encode_utf16().collect();let module=LoadLibraryExW(name.as_ptr(),ptr::null_mut(),0x800);
 if module.is_null(){println!("loadError={}",GetLastError());return}
 let mut path=[0u16;32768];let size=GetModuleFileNameW(module,path.as_mut_ptr(),path.len() as u32);println!("dllPath={}",String::from_utf16_lossy(&path[..size as usize]));
 for name in std::env::args().skip(1){let c=CString::new(name.as_str()).unwrap();println!("export:{}={}",name,!GetProcAddress(module,c.as_ptr().cast()).is_null());}FreeLibrary(module);
}}
'''
    with tempfile.TemporaryDirectory(prefix='devicedock-loader-', dir=os.environ.get('RUNNER_TEMP')) as temporary:
        temp = Path(temporary)
        source = temp / 'probe.rs'
        source.write_text(probe_source)
        manifest = temp / 'common-controls-v6.manifest'
        manifest.write_text('''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><assemblyIdentity name="DeviceDock.LoaderProbe" processorArchitecture="amd64" version="1.0.0.0" type="win32"/><dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="amd64" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency></assembly>''')
        for kind, flags in [('no-v6', []), ('explicit-v6', ['-C', 'link-arg=/MANIFEST:EMBED', '-C', 'link-arg=/MANIFESTINPUT:' + str(manifest)])]:
            executable = temp / (kind + '.exe')
            subprocess.run(['rustc', '--edition=2021', str(source), '-o', str(executable), *flags], check=True)
            output = subprocess.check_output([str(executable), *symbols], text=True)
            result = {'activationContext': kind, 'probeManifest': pe_manifests(executable.read_bytes()), 'exports': {}}
            for line in output.splitlines():
                key, value = line.split('=', 1)
                if key.startswith('export:'): result['exports'][key[7:]] = value == 'true'
                elif key == 'dllPath': result.update(dllPath=value, fileVersion=file_version(value))
                else: result[key] = value
            print(json.dumps(result), flush=True)
    for path in test_paths:
        print(json.dumps({'binary': path.name, 'embeddedManifests': pe_manifests(path.read_bytes())}), flush=True)
    # Reuse compiled dependency graph: link the ordinary desktop bin, never run it or access a device.
    subprocess.run(['cargo', 'build', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--all-features', '--bin', 'devicedock'], check=True)
    desktop = Path('desktop/src-tauri/target/debug/devicedock.exe')
    print(json.dumps({'binary': desktop.name, 'embeddedManifests': pe_manifests(desktop.read_bytes())}), flush=True)
    copied_test_manifest_probe(test_paths,desktop)


def copied_test_manifest_probe(test_paths,desktop):
    import hashlib
    import os
    import shutil
    import subprocess
    import tempfile
    import uuid
    manifests=pe_manifests(desktop.read_bytes())
    manifest=next((m['xml'] for m in manifests if m['commonControlsV6']),None)
    if manifest is None: raise RuntimeError('Normal desktop binary has no v6 manifest to use as control')
    kits=Path(os.environ['ProgramFiles(x86)'])/'Windows Kits'/'10'/'bin'
    tools=sorted(kits.glob('*/x64/mt.exe'))
    if not tools: raise RuntimeError('Installed Windows SDK mt.exe not found')
    with tempfile.TemporaryDirectory(prefix='devicedock-manifest-',dir=os.environ.get('RUNNER_TEMP')) as temporary:
        manifest_path=Path(temporary)/'desktop.manifest';manifest_path.write_text(manifest.rstrip('\x00'),encoding='utf-8')
        for original in test_paths:
            before=hashlib.sha256(original.read_bytes()).hexdigest()
            # Same directory preserves DLL search context; only the copied PE manifest is changed.
            copied=original.with_name(original.stem+'-manifest-probe-'+uuid.uuid4().hex+'.exe')
            shutil.copy2(original,copied)
            try:
                subprocess.run([str(tools[-1]),'-nologo','-manifest',str(manifest_path),'-outputresource:'+str(copied)+';#1'],check=True)
                if imported_symbols(copied.read_bytes())!=imported_symbols(original.read_bytes()): raise RuntimeError('Controlled copy import table changed')
                result=subprocess.run([str(copied),'--list'],capture_output=True,text=True,timeout=30)
                print(json.dumps({'controlledCopiedTest':original.name,'originalSha256':before,'originalUnchanged':hashlib.sha256(original.read_bytes()).hexdigest()==before,'sameDirectoryAndImports':True,'injectedDesktopManifest':True,'listExitCode':result.returncode,'testHarnessReached':result.returncode==0 and ': test' in result.stdout,'listedTests':sum(line.endswith(': test') for line in result.stdout.splitlines()),'originalSidecars':[p.name for p in [Path(str(original)+'.manifest'),Path(str(original)+'.local')] if p.exists()]}),flush=True)
            finally:
                copied.unlink(missing_ok=True)


def verify_activation_manifests(test_paths, application_paths, phase):
    if phase == 'test':
        selected = test_paths
        if not selected: raise RuntimeError('No compiled host test PE found')
    elif phase == 'application':
        selected = application_paths
        if not selected: raise RuntimeError('No release application PE found; application verification cannot be empty')
    else:
        raise ValueError('Unknown manifest verification phase')
    for path in selected:
        manifests = pe_manifests(path.read_bytes())
        if len(manifests) != 1 or not manifests[0]['commonControlsV6']:
            raise RuntimeError('Missing or duplicate Common Controls v6 manifest in '+path.name)
        print(json.dumps({'phase':phase,'binary':path.name,'singleV6Manifest':True}),flush=True)


if __name__ == '__main__':
    if sys.platform!='win32': raise SystemExit('Run on the affected Windows runner')
    paths=[Path(filename) for filename in sorted(glob.glob('desktop/src-tauri/target/debug/deps/devicedock_lib-*.exe'))[:4]]
    if '--verify-test-manifests' in sys.argv:
        verify_activation_manifests(paths, [], 'test')
        raise SystemExit(0)
    if '--verify-app-manifests' in sys.argv:
        applications=[Path(filename) for filename in glob.glob('desktop/src-tauri/target/**/release/devicedock.exe',recursive=True)]
        verify_activation_manifests([], applications, 'application')
        raise SystemExit(0)
    if not paths: raise SystemExit('No compiled host test executable found')
    for path in paths: print(json.dumps(inspect(path)),flush=True)
    print(json.dumps({'pythonExecutable':Path(sys.executable).name,'pythonManifests':pe_manifests(Path(sys.executable).read_bytes())}),flush=True)
    activation_context_evidence(paths)
