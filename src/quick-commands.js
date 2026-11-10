import {parseSend} from './view.js'
export function importCommands(raw){
 const data=typeof raw==='string'?JSON.parse(raw):raw
 if(!Array.isArray(data)||data.length>100)throw Error('快捷指令最多 100 条')
 return data.map(c=>{const command={name:String(c.name||'').slice(0,60),data:c.data??c.content,format:c.format||(c.hex?'hex':'text'),crlf:!!c.crlf};if(!command.name||typeof command.data!=='string'||command.data.length>8192||!['text','hex'].includes(command.format))throw Error('快捷指令格式无效');parseSend(command.data,command.format,command.crlf);return command})
}
export function downloadText(name,text){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type:'application/json'}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
export function mountCommands({q,session,id,storage,action}){
 const key=`devicedock.quick-groups.${id}`;let groups,selected=0
 try{groups=JSON.parse(storage.getItem(key));if(!Array.isArray(groups)||!groups.length||groups.length>50)throw Error();groups=groups.map(g=>({name:String(g.name).slice(0,60),commands:importCommands(g.commands)}))}catch{let old=[];try{old=importCommands(JSON.parse(storage.getItem(`devicedock.quick.${id}`))||[])}catch{}groups=[{name:'默认分组',commands:old}]}
 const current=()=>groups[selected],button=(name,fn)=>{const b=document.createElement('button');b.textContent=name;b.onclick=action(fn);return b}
 const save=()=>{storage.setItem(key,JSON.stringify(groups));draw()}
 const draw=()=>{const select=q('.quick-group');select.replaceChildren();groups.forEach((g,i)=>{const o=document.createElement('option');o.value=i;o.textContent=g.name;select.append(o)});select.value=selected;const box=q('.quick-list');box.replaceChildren();current().commands.forEach((c,i)=>{const row=document.createElement('div');row.className='actions';const name=document.createElement('input');name.value=c.name;name.setAttribute('aria-label','指令名称');const data=document.createElement('input');data.value=c.data;data.setAttribute('aria-label','指令内容');const format=document.createElement('select');for(const f of ['hex','text']){const o=document.createElement('option');o.value=f;o.textContent=f.toUpperCase();format.append(o)}format.value=c.format;const crlf=document.createElement('input');crlf.type='checkbox';crlf.checked=c.crlf;crlf.setAttribute('aria-label','CRLF');row.append(name,data,format,crlf,button('保存',()=>{current().commands[i]=importCommands([{name:name.value,data:data.value,format:format.value,crlf:crlf.checked}])[0];save()}),button('发送',()=>session.send(parseSend(data.value,format.value,crlf.checked))),button('↑',()=>{if(i){[current().commands[i-1],current().commands[i]]=[current().commands[i],current().commands[i-1]];save()}}),button('↓',()=>{if(i+1<current().commands.length){[current().commands[i+1],current().commands[i]]=[current().commands[i],current().commands[i+1]];save()}}),button('删除',()=>{current().commands.splice(i,1);save()}));box.append(row)})}
 q('.quick-group').onchange=()=>{selected=Number(q('.quick-group').value);draw()}
 q('.quick-group-add').onclick=action(()=>{const name=q('.quick-group-name').value.trim();if(!name||groups.length>=50)throw Error('请填写分组名称，最多 50 组');groups.push({name:name.slice(0,60),commands:[]});selected=groups.length-1;save()})
 q('.quick-group-rename').onclick=action(()=>{const name=q('.quick-group-name').value.trim();if(!name)throw Error('请填写分组名称');current().name=name.slice(0,60);save()})
 q('.quick-group-delete').onclick=action(()=>{if(groups.length===1)throw Error('至少保留一个分组');groups.splice(selected,1);selected=0;save()})
 q('.quick-add').onclick=action(()=>{const c=importCommands([{name:q('.quick-name').value,data:q('.send-input').value,format:q('.send-format').value,crlf:q('.crlf').checked}])[0];if(current().commands.length>=100)throw Error('最多 100 条');current().commands.push(c);save()})
 q('.quick-export').onclick=()=>downloadText(`${current().name}.json`,JSON.stringify(current().commands,null,2))
 q('.quick-import').onchange=action(async()=>{const f=q('.quick-import').files[0];if(!f)return;if(f.size>1024*1024)throw Error('文件超过 1 MiB');const imported=importCommands(await f.text());if(current().commands.length+imported.length>100)throw Error('合计超过 100 条');current().commands.push(...imported);save();q('.quick-import').value=''})
 draw()
}
