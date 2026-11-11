import {spawnSync} from 'node:child_process'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
const here=fileURLToPath(new URL('.',import.meta.url)),out=resolve(process.argv[2]||join(here,'build'))
const os=({darwin:'macos',win32:'windows',linux:'linux'})[process.platform]
const arch=({arm64:'aarch64',x64:'x86_64'})[process.arch]
if(!os||!arch)throw Error('Unsupported platform')
const target=`${os}-${arch}`
await mkdir(out,{recursive:true});const name=os==='windows'?'devicedock-native-example.exe':'devicedock-native-example'
const buildDir=join(out,'cargo'),binary=join(buildDir,'release',name)
const built=spawnSync('cargo',['build','--locked','--release','--manifest-path',join(here,'Cargo.toml'),'--target-dir',buildDir],{cwd:here,stdio:'inherit'});if(built.status!==0)process.exit(built.status||1)
const hash=b=>createHash('sha256').update(b).digest('hex'),files={},integrity={}
for(const [path,bytes]of [[`bin/${name}`,await readFile(binary)],['ui.html',await readFile(join(here,'ui.html'))]]){files[path]=bytes.toString('base64');integrity[path]=`sha256-${hash(bytes)}`}
const manifest={schemaVersion:1,kind:'native-process',id:'org.devicedock.example.native',name:'Native Echo & Sum',version:'1.0.0',target,executable:`bin/${name}`,page:'ui.html',methods:['echo','sum'],integrity}
const raw=JSON.stringify({manifest,files}),path=join(out,'example.ddnative.json');await writeFile(path,raw);await writeFile(`${path}.sha256`,hash(raw)+'\n');console.log(`Built native example for ${target}; package: ${path}`)
