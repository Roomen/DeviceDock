// Genuine public HTTPS source/runtime-install acceptance. No remote request interception.
import {chromium} from 'playwright-core'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import assert from 'node:assert/strict'
const port=Number(process.env.TEST_PORT||18095),server=spawn(process.execPath,['tools/serve.mjs'],{env:{...process.env,PORT:String(port),SERVE_DIST:'dist-core'},stdio:['ignore','pipe','pipe']});let browser
try{
 await once(server.stdout,'data');browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const page=await browser.newPage(),errors=[],network=[];page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>network.push({url:r.url(),error:r.failure()?.errorText}));await page.goto(`http://127.0.0.1:${port}`);await page.waitForFunction(()=>document.querySelector('.transport option'));await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}))})
 const result=await page.evaluate(async()=>{
  const {application}=await import('./src/app.js'),{SourceStore}=await import('./src/sources.js'),{Installer}=await import('./src/installer.js'),sources=new SourceStore(localStorage),installer=new Installer(localStorage,'web'),evidence=[]
  for(const[kind,repo,id]of [['protocol','DeviceDock-Protocols','org.devicedock.sek'],['plugin','DeviceDock-Plugins','org.devicedock.power']]){
   const source={kind,url:'https://github.com/Roomen/'+repo},catalog=await sources.refresh(source),entry=catalog.packages.find(p=>p.id===id);if(!entry)throw Error('Required live package missing');const installed=await installer.fromCatalog(source,entry);if(application.host.extensions.has(id))throw Error('Install executed code');await application.host.enable(installed.manifest,installed.url,true,undefined,installed.source);if(!application.host.extensions.has(id))throw Error('Live package failed to activate');evidence.push({id,version:entry.version,url:entry.url,webUrl:entry.webUrl,sha256:entry.sha256,verifiedRuntimeHash:installed.hash,toolCount:application.host.mcpTools.size});await application.host.disable(id)
  }
  return evidence
 });assert.equal(result.length,2);assert.match(result[0].url,/raw\.githubusercontent\.com/);assert.match(result[1].url,/github\.com\/Roomen\/DeviceDock-Plugins\/releases\/download/)
 await page.context().setOffline(true);await page.reload();await page.waitForFunction(()=>document.querySelector('.transport option'));const offline=await page.evaluate(async()=>{const {application}=await import('./src/app.js'),{Installer}=await import('./src/installer.js'),items=new Installer(localStorage,'web').list();for(const item of items){await application.host.enable(item.manifest,item.url,true,undefined,item.source);await application.host.disable(item.manifest.id)}return items.length});assert.equal(offline,2);assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASS',actualHttpsSourceRoutes:result,offlineReactivation:offline,browserErrors:0,remoteInterception:false}))
}catch(error){console.error(error.message);throw error}finally{await browser?.close();server.kill()}
