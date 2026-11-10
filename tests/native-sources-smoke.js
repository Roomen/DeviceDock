;(async()=>{
 const invoke=window.__TAURI__.core.invoke
 try{
  const app=(await import('./src/app.js')).application,{SourceStore}=await import('./src/sources.js'),{Installer}=await import('./src/installer.js'),sources=new SourceStore(localStorage),installer=new Installer(localStorage,'desktop',window.__TAURI__.core),evidence=[]
  for(const[kind,repo,id]of [['protocol','DeviceDock-Protocols','org.devicedock.sek'],['plugin','DeviceDock-Plugins','org.devicedock.power']]){
   const source={kind,url:'https://github.com/Roomen/'+repo},catalog=await sources.refresh(source),entry=catalog.packages.find(p=>p.id===id);if(!entry)throw Error('Required live package absent');const installed=await installer.fromCatalog(source,entry);if(app.host.extensions.has(id))throw Error('Install unexpectedly executed code');await app.host.enable(installed.manifest,installed.url,true,undefined,installed.source);if(!app.host.extensions.has(id))throw Error('Native live module activation failed');evidence.push({id,version:entry.version,url:entry.url,sha256:entry.sha256,cacheHash:installed.hash});await app.host.disable(id)
  }
  await invoke('native_smoke_complete',{result:{pass:true,actualHttps:true,nativeRuntimeInstall:evidence,physicalDevices:false}})
 }catch(error){await invoke('native_smoke_complete',{result:{pass:false,error:String(error.message||error)}})}
})()
