;(async () => {
 const invoke=window.__TAURI__.core.invoke
 try {
  const json=__FIXTURE_JSON__,hash=__FIXTURE_HASH__,bundle=JSON.parse(json)
  const installed=await invoke('extension_install',{bundleJson:json,expectedHash:hash})
  const module=await import(installed.baseUrl+bundle.manifest.entry)
  if(bundle.manifest.id==='org.devicedock.patch'){
   const {packageAssets}=await import('./src/assets.js'),pending=new Set(),services=new Map(),controller=new AbortController(),assets=packageAssets(bundle.manifest,installed.baseUrl+bundle.manifest.entry,{native:{invoke},dispose:off=>{pending.add(off);return ()=>pending.delete(off)}})
   const response=await fetch(installed.baseUrl+'patch/hdiffi.wasm');if(response.headers.get('Content-Type')!=='application/wasm')throw Error('Native patch WASM MIME failure')
   const cleanup=module.activate({apiVersion:1,assets,signal:controller.signal,prepareDeactivate:()=>()=>{},registerService:(id,value)=>{services.set(id,value);return ()=>services.delete(id)}}),provider=services.get('org.devicedock.firmware.patch.v1'),old=new Uint8Array(4096).fill(1),nw=old.slice();nw[88]=2
   const patch=await provider.createPatch(old,nw);if(!patch.length||pending.size)throw Error('Patch output or Worker lifecycle failure');cleanup()
   await invoke('native_smoke_complete',{result:{pass:true,packagedHPatch:true,patchBytes:patch.length,wasmMime:true,retainedWorkers:pending.size}});return
  }
  if(module.activate()!=='native-extension')throw Error('Native ESM bytes mismatch')
  const response=await fetch(installed.baseUrl+'add.wasm')
  if(!response.ok||response.headers.get('Content-Type')!=='application/wasm')throw Error('Native WASM MIME/CORS failure')
  const {packageAssets}=await import('./src/assets.js'),cleanup=[]
  const assets=packageAssets(bundle.manifest,installed.baseUrl+'index.js',{native:{invoke},dispose:off=>cleanup.push(off)})
  const worker=await assets.createWorker('worker.js'),wasm=await assets.read('add.wasm')
  const result=await new Promise((resolve,reject)=>{setTimeout(()=>reject(Error('Native worker timeout')),10000);worker.onmessage=e=>resolve(e.data);worker.onerror=e=>reject(Error(e.message));worker.postMessage(wasm.buffer,[wasm.buffer])})
  cleanup.forEach(off=>off())
  if(result.value!==5)throw Error(result.error||'Native Worker/WASM result mismatch')
  await invoke('native_smoke_complete',{result:{pass:true,esm:true,wasmMime:true,blobWorkerWasm:5,transport:'native-cache-command+verified-custom-uri'}})
 } catch(error) {await invoke('native_smoke_complete',{result:{pass:false,error:String(error.message||error)}})}
})()
