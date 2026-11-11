export function mountShellCommands({$,action,platform,status}){
 let lane=document.querySelector('.lane'),theme=localStorage.getItem('devicedock.theme')||'auto'
 const setTheme=value=>{theme=value;localStorage.setItem('devicedock.theme',theme);document.documentElement.dataset.theme=theme;try{document.dispatchEvent(new CustomEvent('devicedock:theme',{detail:theme}))}catch{}}
 setTheme(theme)
 document.addEventListener('focusin',event=>{lane=event.target.closest('.lane')||lane})
 const click=selector=>lane?.querySelector(selector)?.click(),page=id=>$(`[data-page="${id}"]`)?.click(),settings=group=>{page('settings');$(`[data-settings="${group}"]`)?.click()}
 const commands={
  'new-window':()=>platform.native?platform.native.invoke('host_new_window'):window.open(location.href,'_blank','noopener'),
  'save-log':()=>click('.export'),'find-log':()=>{page('workbench');lane?.querySelector('.log-search').focus()},'toggle-connect':()=>click('.connect'),send:()=>lane?.querySelector('.send-form').requestSubmit(),'clear-log':()=>click('.clear'),
  'auto-scroll':()=>click('.auto-scroll'),'view-serial':()=>page('workbench'),'view-extensions':()=>page('extensions'),'view-settings':()=>page('settings'),'view-services':()=>settings('services'),'view-sources':()=>settings('sources'),
  'theme-auto':()=>setTheme('auto'),'theme-light':()=>setTheme('light'),'theme-dark':()=>setTheme('dark'),
  'command-palette':()=>{const dialog=$('#command-dialog');if(!dialog.open)dialog.showModal()}
 }
 let lastPageCommand
 const run=id=>{if(document.querySelector('dialog[open]')&&id!=='command-palette')return;return commands[id]?.()}
 const box=$('#command-list');for(const[id,title]of Object.entries({'new-window':'新建窗口','save-log':'导出所选日志','find-log':'查找日志','toggle-connect':'连接 / 断开','send':'发送','clear-log':'清空日志','view-extensions':'扩展管理','view-settings':'设置','view-services':'客户端服务（设置）','view-sources':'插件与来源（设置）','theme-auto':'跟随系统','theme-light':'浅色','theme-dark':'深色'})){const b=document.createElement('button');b.textContent=title;b.onclick=action(async()=>{$('#command-dialog').close();await run(id)});box.append(b)}
 $('#command-search').oninput=()=>{for(const b of box.children)b.hidden=!b.textContent.includes($('#command-search').value)}
 $('#open-commands').onclick=()=>run('command-palette')
 document.addEventListener('keydown',event=>{if(!(event.metaKey||event.ctrlKey)||event.altKey||document.querySelector('dialog[open]'))return;const id=event.key.toLowerCase()==='k'?(event.shiftKey?'clear-log':'command-palette'):!event.shiftKey?({s:'save-log',f:'find-log',o:'toggle-connect',n:'new-window',Enter:'send'})[event.key]:null;if(id){lastPageCommand={id,time:Date.now()};event.preventDefault();action(()=>run(id))()}})
 if(platform.native&&globalThis.__TAURI__.event){globalThis.__TAURI__.event.listen('app-menu',({payload})=>{if(lastPageCommand?.id===payload&&Date.now()-lastPageCommand.time<200)return;action(()=>run(payload))()});globalThis.__TAURI__.event.listen('app-download',({payload})=>status(payload.success?'文件已保存到下载目录':'文件保存失败'))}
}
