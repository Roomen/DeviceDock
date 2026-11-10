import { readFile, readdir, lstat, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { resolve, relative, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { verifyPackage } from '../src/package.js'
const root = resolve(import.meta.dirname,'..')
export async function pack(directory) {
 const base = resolve(directory); if((await lstat(base)).isSymbolicLink()) throw Error('Package root symlink rejected'); const manifest = JSON.parse(await readFile(join(base,'manifest.json'),'utf8')), files = {}
 async function walk(dir) { for (const entry of await readdir(dir,{withFileTypes:true})) {
  if (dir === base && entry.name === 'manifest.json') continue
  const path = join(dir,entry.name), stat = await lstat(path)
  if (stat.isSymbolicLink()) throw Error('符号链接不允许进入扩展包')
  if (stat.isDirectory()) await walk(path)
  else if (stat.isFile()) files[relative(base,path).split('\\').join('/')] = (await readFile(path)).toString('base64')
  else throw Error('包只允许普通文件')
 } }
 await walk(base); const bundle = {manifest,files}; await verifyPackage(bundle); return bundle
}
export async function integrate(directory) {
 const bundle = await pack(directory), verified = await verifyPackage(bundle), extensionRoot = join(root,'extensions'), stage = join(extensionRoot,'.stage-' + randomUUID()), destination = join(extensionRoot,verified.hash)
 await mkdir(stage,{recursive:true})
 try {
  for (const [path,bytes] of verified.files) { const target = join(stage,path); await mkdir(resolve(target,'..'),{recursive:true}); await writeFile(target,bytes) }
  await writeFile(join(stage,'manifest.json'),JSON.stringify(bundle.manifest,null,2))
  try { await rename(stage,destination) } catch (e) { if (!['EEXIST','ENOTEMPTY'].includes(e.code)) throw e; if((await verifyPackage(await pack(destination))).hash !== verified.hash) throw Error('Existing content cache mismatch'); await rm(stage,{recursive:true,force:true}) }
  let index = []; try { index = JSON.parse(await readFile(join(extensionRoot,'installed.json'),'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const entry = {manifest:bundle.manifest,hash:verified.hash,source:'bundled',url:`./extensions/${verified.hash}/${bundle.manifest.entry}`}
  index = index.filter(item => item.hash !== entry.hash); index.push(entry)
  const temporary = join(extensionRoot,'.index-' + randomUUID()); await writeFile(temporary,JSON.stringify(index,null,2)); await rename(temporary,join(extensionRoot,'installed.json'))
  return entry
 } catch(e) { await rm(stage,{recursive:true,force:true}); throw e }
}
if (process.argv[1] === import.meta.filename) {
 const [command, directory, output] = process.argv.slice(2)
 if (command === 'pack' && directory && output) { const bundle = await pack(directory); await writeFile(output,JSON.stringify(bundle)); console.log('Verified package written') }
 else if (command === 'install' && directory) { const item = await integrate(directory); console.log(`${item.manifest.id}@${item.manifest.version} installed (not enabled)`) }
 else { console.error('Usage: node tools/integrate.mjs pack <directory> <output.json> | install <directory>'); process.exitCode = 1 }
}
