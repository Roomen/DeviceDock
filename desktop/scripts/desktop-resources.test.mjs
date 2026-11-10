import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
const root=resolve(import.meta.dirname,'../..'),config=JSON.parse(readFileSync(join(root,'desktop/src-tauri/tauri.conf.json')))
test('desktop platform icons exist and contain valid Windows/macOS resource frames',()=>{
 for(const icon of config.bundle.icon)assert(existsSync(join(root,'desktop/src-tauri',icon)),`Missing configured icon ${icon}`)
 const ico=readFileSync(join(root,'desktop/src-tauri/icons/icon.ico'));assert.equal(ico.readUInt16LE(0),0);assert.equal(ico.readUInt16LE(2),1);const count=ico.readUInt16LE(4);assert(count>0);const sizes=[];for(let n=0;n<count;n++){const at=6+n*16,size=ico.readUInt32LE(at+8),offset=ico.readUInt32LE(at+12);assert(size>0&&offset>=6+count*16&&offset+size<=ico.length);sizes.push(ico[at]||256)}assert(sizes.includes(32));assert(sizes.includes(256));
 const icns=readFileSync(join(root,'desktop/src-tauri/icons/icon.icns'));assert.equal(icns.subarray(0,4).toString(),'icns');assert.equal(icns.readUInt32BE(4),icns.length);let offset=8;while(offset<icns.length){const length=icns.readUInt32BE(offset+4);assert(length>=8&&offset+length<=icns.length);offset+=length}assert.equal(offset,icns.length)
})
function cargoPackageVersion(text){const section=text.replace(/\r\n/g,'\n').split(/^\[\[package\]\]$/m).find(part=>/^name = "devicedock"$/m.test(part));return /^version = "([^"]+)"$/m.exec(section||'')?.[1]}
test('Cargo package version reads both LF and CRLF lockfiles',()=>{for(const newline of ['\n','\r\n']){const text=['[[package]]','name = "another"','version = "9.0.0"','','[[package]]','name = "devicedock"','version = "0.1.1"',''].join(newline);assert.equal(cargoPackageVersion(text),'0.1.1')}})
test('release version agrees across source manifests, locks and displayed version',()=>{
 const version=JSON.parse(readFileSync(join(root,'package.json'))).version,lock=JSON.parse(readFileSync(join(root,'package-lock.json')));assert.equal(config.version,version);assert.equal(lock.version,version);assert.equal(lock.packages[''].version,version);assert(readFileSync(join(root,'desktop/src-tauri/Cargo.toml'),'utf8').includes(`version = "${version}"`));assert.equal(cargoPackageVersion(readFileSync(join(root,'desktop/src-tauri/Cargo.lock'),'utf8')),version);assert(readFileSync(join(root,'index.html'),'utf8').includes(`class="version">v${version}`))
})
