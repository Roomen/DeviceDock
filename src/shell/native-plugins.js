// Native executable packages are distinct from JS/WASM extension packages.
export async function mountNativePlugins({platform, panel, pagesContainer, registerPage, status = () => {}, events = globalThis.__TAURI__?.event, onStage = async () => {}}) {
 const doc = panel.ownerDocument, win = doc.defaultView || globalThis
 panel.replaceChildren()
 if (!platform.native) {panel.textContent = '原生进程插件仅支持桌面版。'; return {refresh:async()=>{}, dispose:async()=>{}}}
 const invoke = (name, args) => platform.native.invoke(name, args)
 const make = (tag, text) => {const e=doc.createElement(tag); if (text) e.textContent=text; return e}
 const warning=make('p','原生插件以你的系统权限运行，可访问本机文件和网络。仅信任已核对来源及 SHA-256 的程序；安装不会执行，启动须单独授权。')
 const file=make('input');file.type='file';file.accept='.ddnative.json,application/json'
 const list=make('div'), message=make('p');panel.append(warning,file,message,list)
 const mounted=new Map(); let disposed=false, busy=false, lastRender, refreshing=Promise.resolve()
 const error=e=>{message.textContent=String(e?.message||e);status(message.textContent)}
 const unmount=hash=>{const item=mounted.get(hash);if(!item)return;win.removeEventListener('message',item.listener);item.element.removeEventListener('devicedock:page-show',item.show);item.element.removeEventListener('devicedock:page-hide',item.hide);if(typeof item.dispose==='function')item.dispose();else item.dispose?.dispose?.();item.element.remove();mounted.delete(hash)}
 const mount=async record=>{
  if(mounted.has(record.hash)||disposed)return
  const url=await invoke('native_plugin_page',{hash:record.hash});if(disposed)return
  const element=make('section');element.dataset.nativePlugin=record.hash
  const iframe=make('iframe');iframe.title=record.manifest.name;iframe.setAttribute('sandbox','allow-scripts');iframe.referrerPolicy='no-referrer';iframe.style.cssText='width:100%;height:100%;min-height:420px;border:0';iframe.src=url;element.append(iframe);pagesContainer.append(element)
  let pending=0
  const listener=async event=>{
   if(event.source!==iframe.contentWindow || event.data?.type!=='devicedock-native-call' || mounted.get(record.hash)?.element!==element)return
   const data=event.data
   if(!Number.isSafeInteger(data.id)||data.id<1)return
   const reply=payload=>{if(mounted.get(record.hash)?.element===element)iframe.contentWindow?.postMessage({type:'devicedock-native-reply',id:data.id,...payload},'*')}
   if(pending>=8 || typeof data.method!=='string' || !record.manifest.methods.includes(data.method)){reply({error:'Native method unavailable or queue full'});return}
   try {if(new TextEncoder().encode(JSON.stringify(data.params??null)).length>64000)throw Error('Native request too large')} catch {reply({error:'Invalid native parameters'});return}
   pending++
   try{reply({result:await invoke('native_plugin_call',{hash:record.hash,method:data.method,params:data.params??null})})}catch(e){reply({error:String(e?.message||e)});void refresh().catch(error)}finally{pending--}
  }
  const show=()=>iframe.contentWindow?.postMessage({type:'devicedock:page-show'},'*'),hide=()=>iframe.contentWindow?.postMessage({type:'devicedock:page-hide'},'*')
  win.addEventListener('message',listener);element.addEventListener('devicedock:page-show',show);element.addEventListener('devicedock:page-hide',hide)
  let disposer
  try{disposer=registerPage({id:`native-${record.hash}`,title:record.manifest.name,element})}catch(e){win.removeEventListener('message',listener);element.remove();throw e}
  mounted.set(record.hash,{element,listener,show,hide,dispose:disposer})
 }
 const act=fn=>async()=>{if(busy||disposed)return;busy=true;message.textContent='处理中…';try{await fn();message.textContent='';await refresh()}catch(e){error(e)}finally{busy=false}}
 const button=(text,fn,disabled=false)=>{const b=make('button',text);b.type='button';b.disabled=disabled;b.onclick=act(fn);return b}
 const refresh=()=>refreshing=refreshing.catch(()=>{}).then(async()=>{
  if(disposed)return
  const records=await invoke('native_plugin_list');if(disposed)return
  const active=new Set(records.filter(r=>r.running&&r.trusted).map(r=>r.hash));for(const hash of mounted.keys())if(!active.has(hash))unmount(hash)
  for(const record of records)if(record.running&&record.trusted)await mount(record)
  const signature=JSON.stringify(records);if(signature===lastRender)return;lastRender=signature
  list.replaceChildren()
  for(const record of records){
   const row=make('article'),title=make('h4',`${record.manifest.name} · ${record.manifest.version}`),hash=make('code',record.hash),state=make('p',`${record.manifest.target} · ${record.trusted?'已信任':'未信任'} · ${record.running?'运行中':'已停止'}${record.error?' · '+record.error:''}`)
   row.append(title,hash,state,
    button(record.trusted?'撤销信任并停止':'信任此 SHA-256 的原生程序',()=>invoke(record.trusted?'native_plugin_revoke':'native_plugin_trust',{hash:record.hash})),
    button('启动',()=>invoke('native_plugin_start',{hash:record.hash}),!record.trusted||record.running),
    button('停止',()=>invoke('native_plugin_stop',{hash:record.hash}),!record.running),
    button('卸载',()=>invoke('native_plugin_uninstall',{hash:record.hash})))
   list.append(row)
  }
  if(!records.length)list.textContent='尚未安装原生插件。导入独立构建的 .ddnative.json 包。'
 })
 file.onchange=act(async()=>{const selected=file.files?.[0];if(!selected)return;if(selected.size>44*1024*1024)throw Error('原生包过大');const bundleJson=await selected.text();const bytes=new TextEncoder().encode(bundleJson),hash=await win.crypto.subtle.digest('SHA-256',bytes);const expectedHash=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');await invoke('native_plugin_install',{bundleJson,expectedHash});file.value=''})
 await onStage('adapter-release-begin');await invoke('native_plugin_release_owned');await onStage('adapter-release-finished');await refresh();await onStage('adapter-list-finished')
 await onStage('adapter-event-listen-begin')
 const unlisten=await events?.listen('native-plugin-state',()=>{if(!disposed)void refresh().catch(error)})
 await onStage('adapter-event-listen-finished')
 const dispose=async()=>{if(disposed)return;disposed=true;unlisten?.();win.removeEventListener('pagehide',onHide);for(const hash of [...mounted.keys()])unmount(hash);await invoke('native_plugin_release_owned')}
 const onHide=()=>{void dispose().catch(()=>{})};win.addEventListener('pagehide',onHide,{once:true})
 return {refresh,dispose}
}
