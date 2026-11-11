import {createMcpTools,startMcpBridge,registerMcpBridge} from '../mcp.js'
import {exportRows,importRows} from '../workbench.js'
export async function mountShell({platform,host,sessions,serial,status,action,$,hooks}){
 if(!platform.native){$('#native-controls').querySelectorAll('button,input').forEach(e=>e.disabled=true);return}
 const native=platform.native, event=globalThis.__TAURI__.event
 $('#shell-info').textContent='MCP 默认关闭；持久令牌仅保存在本机应用配置。更新使用客户端内置公钥与通道。'
 let tools=createMcpTools({host,sessions,serial}),version,running=false
 const show=state=>{running=state.running;$('#mcp-state').textContent=running?`已启动 · http://127.0.0.1:${state.port}/mcp`:'已停止'}
 show(await registerMcpBridge(native,tools))
 const stop=async()=>{try{await native.invoke('mcp_stop')}finally{running=false;$('#mcp-token').value='';$('#mcp-state').textContent='已停止'}}
 $('#mcp-start').onclick=action(async()=>{
  if(running)throw Error('请先停止当前服务')
  const port=Number($('#mcp-port').value);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('端口须为 1024 至 65535')
  await syncCatalog();tools.refreshCatalog()
  const config=await startMcpBridge(native,tools,port);$('#mcp-token').value=config.token;show({running:true,...config})
 })
 $('#mcp-stop').onclick=action(stop)
 $('#mcp-reveal').onclick=action(async()=>{if($('#mcp-token').type==='password'){$('#mcp-token').value=await native.invoke('mcp_reveal_token');$('#mcp-token').type='text'}else{$('#mcp-token').type='password'}})
 $('#mcp-regenerate').onclick=action(async()=>{$('#mcp-token').value=await native.invoke('mcp_regenerate_token');status('令牌已重新生成，请更新 agent 配置')})
 let catalogSync=Promise.resolve()
 const syncCatalog=()=>catalogSync=catalogSync.catch(()=>{}).then(async()=>{if(tools.isStale()){tools.refreshCatalog();show(await registerMcpBridge(native,tools))}})
 const previousChanged=host.changed;host.changed=()=>{previousChanged();void syncCatalog().catch(e=>status(`MCP 工具目录同步失败：${e.message}`))}
 $('#update-check').onclick=action(async()=>{const info=await native.invoke('app_update_check');version=info?.version;$('#update-install').disabled=!version;$('#update-state').textContent=info?`可更新至 ${info.version} · ${info.body||''}`:'当前已是最新版本'})
 $('#update-install').onclick=action(async()=>{if(!version)throw Error('请先检查更新');$('#update-install').disabled=true;try{await native.invoke('app_update_install',{version})}finally{$('#update-install').disabled=false}})
 $('#new-window').onclick=action(()=>native.invoke('host_new_window'))
 // One-time per-window handoff is injected before modules execute by the native shell.
 try{const saved=JSON.parse(sessionStorage.getItem('devicedock.runtime')||'null');sessionStorage.removeItem('devicedock.runtime');if(saved){for(const[id,rows]of Object.entries(saved.logs||{})){const s=sessions[id];if(!s)continue;const imported=importRows(rows);s.logs=imported.slice(-3000);s.logBytes=s.logs.reduce((n,r)=>n+r.bytes.length,0);s.sequence=Math.max(0,...s.logs.map(r=>r.sequence));s.generation=Math.max(0,...s.logs.map(r=>r.generation))+1;s.onLog()}if(saved.dual&&sessions.B){$('#dual').checked=true;$('#dual').dispatchEvent(new Event('change'))}}}catch{status('更新前日志恢复失败，可重新导入已导出的日志')}
 if(event){
  await event.listen('mcp-state',({payload})=>{show(payload)})
  await event.listen('app-update-prepare',async({payload})=>{
   let ready=false,session
   try{
    // Save only runtime state in the private one-time native handoff, never shared localStorage.
    const runtime={dual:$('#dual').checked,logs:Object.fromEntries(Object.entries(sessions).map(([id,s])=>[id,exportRows(s.logs)]))}
    session={'devicedock.runtime':JSON.stringify(runtime)}
    if(new TextEncoder().encode(session['devicedock.runtime']).length>25*1024*1024)throw Error('日志过大，请先导出')
    for(const hook of hooks?.beforeUpdate||[])await hook()
    await host.prepareForUpdate();ready=true
   }catch(e){status(e.message||e)}
   await native.invoke('app_update_ack',{operationId:payload.operationId,ready,session})
  })
  await event.listen('app-update-finished',({payload})=>{if(!payload.success){host.updating=false;for(const s of host.allSessions())s.frozen=false;status('应用更新未完成，设备已释放；可重新启用扩展后重试')}})
  await event.listen('app-update-progress',({payload:p})=>{$('#update-state').textContent=`${p.state} · ${p.downloaded}${p.total?' / '+p.total:''}`})
 }
 const result=await native.invoke('app_update_result');if(result&&!result.success)status(result.message)
 globalThis.addEventListener('pagehide',()=>{tools?.dispose()},{once:true})
}
