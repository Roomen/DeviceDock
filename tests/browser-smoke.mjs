import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {readFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {pack} from '../tools/integrate.mjs'
const port = Number(process.env.TEST_PORT || 18089), server = spawn(process.execPath,['tools/serve.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']})
const servedRoot=resolve(process.env.SERVE_DIST||'.'),expectedPackages=JSON.parse(await readFile(join(servedRoot,'extensions/index.json')))
let browser
try {
 await once(server.stdout,'data')
 browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true})
 const page = await browser.newPage(), errors = []
 page.on('pageerror',error => errors.push(error.message))
 await page.addInitScript(() => {
  const devices = []
  function device() {
   let input
   const writes = []
   return {writes,readable:null,writable:null,getInfo:() => ({usbVendorId:1}),async open() {this.readable = new ReadableStream({start(c){input=c}}); this.writable = new WritableStream({write(bytes){writes.push([...bytes])}})},async close() {this.readable=null; this.writable=null},push(bytes){input.enqueue(Uint8Array.from(bytes))}}
  }
  Object.defineProperty(navigator,'serial',{value:{requestPort:async () => {const port=device();devices.push(port);return port},getPorts:async () => devices,addEventListener(){}}})
  window.testDevices=devices
 })
 await page.goto(`http://localhost:${port}`); await page.waitForFunction(() => document.querySelector('.transport option'));await page.evaluate(async()=>{window.testApplication=(await import('./src/app.js')).application})
 await page.locator('.connect').first().click(); await page.locator('.send-input').first().fill('68 01 16'); await page.locator('.send-form button').first().click()
 await page.waitForFunction(() => window.testDevices[0]?.writes.length === 1)
 await page.evaluate(() => window.testDevices[0].push([0x68,0x02,0x16])); await page.waitForFunction(() => document.querySelector('.logs').textContent.includes('68 02 16'))
 assert.deepEqual(await page.evaluate(() => testDevices[0].writes[0]),[0x68,1,0x16])
 await page.locator('#dual').check(); await page.locator('.connect').nth(1).click(); await page.evaluate(() => testDevices[1].push([0xAB])); await page.waitForFunction(() => document.querySelectorAll('.logs')[1].textContent.includes('AB'))
 assert.ok(!(await page.locator('.logs').first().textContent()).includes(' AB'))
 await page.locator('.connect').first().click(); await page.locator('.connect').nth(1).click()
 await page.locator('[data-page="extensions"]').click(); const count = await page.locator('.package-row').count();assert.equal(count,expectedPackages.length)
 await page.locator('#trust').check()
 for (let i = 0; i < count; i++) {
  await page.locator('.package-row').nth(i).getByRole('button',{name:'启用此版本',exact:true}).click()
  await page.waitForFunction(expected => [...window.testApplication.host.extensions.values()].filter(e=>e.status==='enabled').length===expected,i+1)
 }
 const enabled = await page.evaluate(async () => {const {application} = await import('./src/app.js'); return {extensions:application.host.extensions.size,protocols:application.host.protocols.size,services:[...application.host.services.keys()],states:[...application.host.extensions].map(([id,state])=>({id,status:state.status,url:state.url,disposers:state.disposers.length}))}})
 assert.equal(enabled.extensions,count,`Some extensions failed activation: ${await page.locator('#status').textContent()}`)
 if (count) {assert.equal(enabled.protocols,expectedPackages.filter(p=>p.manifest.kind==='protocol').length);assert.ok(enabled.services.includes('org.devicedock.bridge.v1'),'Bridge must be fully activated: '+JSON.stringify(enabled))}
 if(count) await page.evaluate(async()=>{const {application}=await import('./src/app.js'),patch=application.host.services.get('org.devicedock.firmware.patch.v1');if(!patch)throw Error('Patch provider absent');const before=application.host.extensions.get('org.devicedock.patch').disposers.length,old=new Uint8Array(4096).fill(1),nw=old.slice();nw[88]=2;const result=await patch.createPatch(old,nw);if(!result.length)throw Error('Empty patch');if(application.host.extensions.get('org.devicedock.patch').disposers.length!==before)throw Error('Worker disposer retained')})
 if(count) await page.evaluate(async()=>{
  const {application}=await import('./src/app.js'),response=await fetch('./extensions/index.json'),entries=await response.json(),entry=entries.find(p=>p.manifest.id==='org.devicedock.patch'),manifest={...entry.manifest,id:'org.test.long-lived'},url=new URL(entry.url,location.href).href
  await application.sessions.A.open(window.testDevices[0],{baudRate:9600})
  for(let cycle=0;cycle<2;cycle++){
   await application.host.enable(manifest,url,true,async()=>({async activate(h){h.session('A').claim('worker');h.session('A').subscribe(()=>{});h.registerService('plugin.org.test.long-lived.hold',{});h.registerProtocol({id:'worker-test',title:'worker test',create:()=>({feed:()=>[],reset(){}})});h.registerTransport({id:'worker-test',title:'worker test',requestPort:async()=>{throw Error('unused')}});await h.assets.createWorker('patch/worker.js')}}))
   await application.host.disable(manifest.id)
   if(application.host.services.has('plugin.org.test.long-lived.hold')||application.host.protocols.has('worker-test')||application.host.transports.has('worker-test')||application.sessions.A.owner)throw Error('Live Worker disable skipped cleanup')
  }
  await application.sessions.A.close()
 })
 const workerReady = await page.evaluate(async () => { await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true})); return !!navigator.serviceWorker.controller })
 assert.ok(workerReady)
 for (let i = count-1; i >= 0; i--) await page.locator('.package-row').nth(i).getByRole('button',{name:'停用',exact:true}).click()
 if(count) {
  const root=resolve(import.meta.dirname,'..'),index=JSON.parse(await readFile(join(root,'extensions/installed.json'))),item=index.find(e=>e.manifest.id==='org.devicedock.cjt188'),bundle=await pack(join(root,'extensions',item.hash)),body=JSON.stringify(bundle)
  const catalog={schemaVersion:1,packages:[{id:bundle.manifest.id,version:bundle.manifest.version,apiVersion:1,kind:'protocol',platforms:bundle.manifest.platforms,sha256:createHash('sha256').update(body).digest('hex'),url:'https://packages.test/cjt.json'}]}
  await page.route('https://raw.githubusercontent.com/test/extensions/HEAD/catalog.json',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(catalog)}))
  await page.route('https://packages.test/cjt.json',route=>route.fulfill({status:200,contentType:'application/json',body}))
  await page.locator('[data-page="sources"]').click();await page.locator('#source-url').fill('https://github.com/test/extensions');await page.locator('#source-form button').click();await page.getByRole('button',{name:'刷新目录',exact:true}).click();await page.getByRole('button',{name:'下载并安装',exact:true}).waitFor();await page.getByRole('button',{name:'下载并安装',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已安装'))
  const runtime=await page.evaluate(async bundle=>{
   const {Installer}=await import('./src/installer.js'),{application}=await import('./src/app.js'),installer=new Installer(localStorage,'web')
   const before=application.host.extensions.size,local=await installer.install(bundle);await installer.install(bundle)
   if(application.host.extensions.size!==before)throw Error('Install executed code')
   await application.host.enable(local.manifest,local.url,true,undefined,local.source)
   const protocol=application.host.protocols.has('cjt188');await application.host.disable(local.manifest.id)
   const bad=structuredClone(bundle);bad.files[bad.manifest.entry]=btoa('tampered');let rejected=false
   try{await installer.install(bad)}catch{rejected=true}
   return {protocol,rejected,installed:installer.list().length}
  },bundle)
  assert.equal(runtime.protocol,true);assert.equal(runtime.rejected,true);assert.equal(runtime.installed,2)
 }
 await page.context().setOffline(true);await page.reload();await page.waitForFunction(()=>document.querySelector('.transport option'))
 if(count) await page.evaluate(async()=>{const {Installer}=await import('./src/installer.js'),{application}=await import('./src/app.js'),item=new Installer(localStorage,'web').list().find(p=>p.source==='local');await application.host.enable(item.manifest,item.url,true);await application.host.disable(item.manifest.id)})
 await page.context().setOffline(false)
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({status:'PASS',serial:'mock streams TX/RX two lanes',packages:count,...enabled,browserErrors:errors.length}))
} finally {await browser?.close();server.kill()}
