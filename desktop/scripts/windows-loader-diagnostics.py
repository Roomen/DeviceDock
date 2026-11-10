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
            records.append({'dll': dll, 'imports': len(symbols), 'missingExports': missing})
        finally:
            kernel.FreeLibrary(handle)
    return {'binary': path.name, 'dlls': records}


if __name__ == '__main__':
    if sys.platform != 'win32': raise SystemExit('Run on the affected Windows runner')
    paths = sorted(glob.glob('desktop/src-tauri/target/debug/deps/devicedock_lib-*.exe'))
    if not paths: raise SystemExit('No compiled host test executable found')
    for filename in paths[:4]:
        print(json.dumps(inspect(Path(filename))), flush=True)
