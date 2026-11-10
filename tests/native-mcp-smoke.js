;(async()=>{
 const native=window.__TAURI__.core,invoke=native.invoke
 const assert=(value,message)=>{if(!value)throw Error(message)},pause=ms=>new Promise(r=>setTimeout(r,ms))
 try{
  const app=(await import('./src/app.js')).application,{createStreamPort}=await import('./src/serial-adapter.js'),writes=[],signals=[]
  const port=createStreamPort({async open(){},async write(bytes){writes.push(Array.from(bytes))},async close(){},async setSignals(value){signals.push(value)}})
  app.serial.getPorts=async()=>[port]
  const bundled=await fetch('./extensions/index.json').then(r=>r.json());for(const item of bundled)await app.host.enable(item.manifest,new URL(item.url,location.href).href,true,undefined,item.source)
  const businessToolCount=app.host.mcpTools.size;assert(bundled.length===0||bundled.length===13,'unexpected packaged extension set')
  const rpc=async(method,params={})=>{const data=await invoke('native_smoke_rpc',{request:{jsonrpc:'2.0',id:1,method,params}});if(data.error)throw Error(data.error.message);return data.result}
  const call=async(name,args={},window='main')=>{const result=await rpc('tools/call',{name,arguments:{...args,window}});if(result.isError)throw Error(result.content[0].text);return result.structuredContent}
  document.querySelector('#mcp-port').value='18099';await document.querySelector('#mcp-start').onclick();const firstToken=await invoke('mcp_reveal_token');assert(firstToken.length===64,'persistent auth unavailable')
  if(bundled.length&&app.host.capabilities['native.spp']){const catalog=await rpc('tools/list',{window:'main'});assert(catalog.tools.some(t=>t.name==='classic_state'),'enabled wireless lacks Classic aliases');assert((await call('classic_state')).phase==='idle','unexpected native Classic initial state')}
  const listed=await call('serial_ports');await call('serial_open',{lane:'A',deviceId:listed.value[0].deviceId});await call('serial_write',{lane:'A',data:'01 02'});assert(JSON.stringify(writes)==='[[1,2]]','native channel execution/write fence failed')
  await invoke('host_new_window');let windows;for(let n=0;n<100;n++){windows=await call('windows_list');if(windows.windows.includes('main-2'))break;await pause(30)}assert(windows.windows.includes('main-2'),'second window registration missing')
  await invoke('native_smoke_window_tool',{enabled:true});let catalog;for(let n=0;n<100;n++){catalog=await rpc('tools/list',{window:'main-2'});if(catalog.tools.some(t=>t.name==='org.test.window.tool'))break;await pause(30)}assert(catalog.tools.some(t=>t.name==='org.test.window.tool'),'second window changed catalog stale');assert((await call('org.test.window.tool',{},'main-2')).ok,'second window dispatch failed')
  await invoke('native_smoke_window_tool',{enabled:false});for(let n=0;n<100;n++){catalog=await rpc('tools/list',{window:'main-2'});if(!catalog.tools.some(t=>t.name==='org.test.window.tool'))break;await pause(30)}assert(!catalog.tools.some(t=>t.name==='org.test.window.tool'),'removed second window tool remains listed')
  assert(await invoke('mcp_commit',{id:'absent',epoch:'old-document'})===false,'stale renderer commit allowed')
  await invoke('native_smoke_update_cycle');await pause(80);assert(app.sessions.A.state==='closed'&&!app.host.updating,'failed update did not release/unfreeze');assert((await call('host_state')).lanes.length===2,'MCP not usable after failed update')
  await document.querySelector('#mcp-stop').onclick();await document.querySelector('#mcp-start').onclick();assert(firstToken===await invoke('mcp_reveal_token'),'token changed across restart');await document.querySelector('#mcp-stop').onclick()
  await invoke('native_smoke_complete',{result:{pass:true,nativeHttpChannel:true,structuredFence:true,multiwindowCatalog:true,failedUpdateResume:true,persistentToken:true,packagedExtensions:bundled.length,registeredBusinessTools:businessToolCount,physicalDevices:false}})
 }catch(error){await invoke('native_smoke_complete',{result:{pass:false,error:String(error.message||error)}})}
})()
