import { cp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { pack } from './integrate.mjs'
const root = resolve(import.meta.dirname,'..'), core = process.argv.includes('--core'), dist = join(root,core ? 'dist-core' : 'dist')
let index = []
if (!core) { try { index = JSON.parse(await readFile(join(root,'extensions/installed.json'),'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e } }
for (const entry of index) await pack(join(root,'extensions',entry.hash))
await rm(dist,{recursive:true,force:true}); await mkdir(dist)
for (const path of ['index.html','style.css','src','sdk','vendor','extension-sw.js']) await cp(join(root,path),join(dist,path),{recursive:true})
await mkdir(join(dist,'extensions'))
for (const entry of index) await cp(join(root,'extensions',entry.hash),join(dist,'extensions',entry.hash),{recursive:true})
await writeFile(join(dist,'extensions/index.json'),JSON.stringify(index,null,2))
await writeFile(join(dist,'build.json'),JSON.stringify({ name:'DeviceDock',version:JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,extensions:index.map(e => ({id:e.manifest.id,version:e.manifest.version,hash:e.hash})) },null,2))
const offline = []
async function enumerate(directory, prefix = '') { for (const item of await readdir(directory,{withFileTypes:true})) { const path = prefix + item.name; if(item.isDirectory()) await enumerate(join(directory,item.name),path + '/'); else if(path !== 'offline-assets.json') offline.push('./' + path) } }
await enumerate(dist); await writeFile(join(dist,'offline-assets.json'),JSON.stringify(offline))
console.log(`Built standalone web assets with ${index.length} verified extensions`)
