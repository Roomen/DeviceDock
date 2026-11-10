import {mountCommands} from './quick-commands.js'
import { parseSend } from './view.js'
export function textRows(rows){return rows.map(row=>`${new Date(row.time).toISOString()} ${row.direction.toUpperCase()} ${row.text||Array.from(row.bytes,b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' ')}`).join('\n')}
export function exportRows(rows){return rows.map(row=>JSON.stringify({...row,bytes:Array.from(row.bytes)})).join('\n')}
export function importRows(text){
 if(text.length>24*1024*1024)throw Error('日志超过 24 MiB')
 const lines=text.split(/\r?\n/).filter(Boolean);if(lines.length>10000)throw Error('日志超过 10000 行')
 return lines.map((line,index)=>{const r=JSON.parse(line);if(!r||!['rx','tx','system'].includes(r.direction)||!Array.isArray(r.bytes)||r.bytes.length>4*1024*1024||r.bytes.some(b=>!Number.isInteger(b)||b<0||b>255)||!Number.isFinite(r.time)||!Number.isSafeInteger(r.generation)||r.generation<0||(r.boundary!==undefined&&r.boundary!=='datagram'))throw Error(`无效日志行 ${index+1}`);return {sequence:index+1,time:r.time,generation:r.generation,direction:r.direction,bytes:Uint8Array.from(r.bytes),text:typeof r.text==='string'?r.text:undefined,boundary:r.boundary}})
}
export function replayRows(rows,definition,lane){let parser,generation;try{return rows.map(row=>{if(row.generation!==generation){parser?.dispose?.();generation=row.generation;parser=definition?.create({lane,mode:'replay',generation})}const frames=row.direction==='rx'&&parser?(row.boundary==='datagram'&&parser.feedDatagram?parser.feedDatagram(row.bytes.slice()):parser.feed(row.bytes.slice())):undefined;return {...row,frames,views:frames?.map(f=>f.view).filter(Boolean)}})}finally{parser?.dispose?.()}}
export async function sendChunks(session,bytes,{signal,chunkSize=1024,delayMs=0}={}){
 if(!(bytes instanceof Uint8Array)||bytes.length>16*1024*1024)throw Error('文件超过 16 MiB')
 return session.transaction('host:file',async tx=>{for(let i=0;i<bytes.length;i+=chunkSize){if(tx.signal.aborted)throw Error('发送已取消');await tx.send(bytes.slice(i,i+chunkSize));if(delayMs)await delay(delayMs,tx.signal)}},{signal,timeoutMs:10*60*1000})
}
function delay(ms,signal){return new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(Error('发送已取消'))};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},ms);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()})}
export async function repeatSend(session,bytes,{intervalMs,count=0,signal}={}){
 if(!Number.isInteger(intervalMs)||intervalMs<20||intervalMs>3600000||!Number.isInteger(count)||count<0||count>100000)throw Error('循环发送参数无效')
 return session.transaction('host:repeat',async tx=>{for(let i=0;count===0||i<count;i++){if(tx.signal.aborted)throw Error('发送已取消');await tx.send(bytes);if(count===0||i+1<count)await delay(intervalMs,tx.signal)}},{signal,timeoutMs:24*60*60*1000})
}
export function sendSuffix(q){return {cr:q('.crlf').checked||q('.append-cr').checked,lf:q('.crlf').checked||q('.append-lf').checked,nul:q('.append-nul').checked}}
export function mountWorkflow({q,session,id,storage,action,status,render}){
 let task
 try{const suffix=JSON.parse(storage.getItem(`devicedock.send.${id}`)||'{}');for(const[k,selector]of Object.entries({cr:'.append-cr',lf:'.append-lf',nul:'.append-nul'}))q(selector).checked=!!suffix[k]}catch{}
 for(const selector of ['.crlf','.append-cr','.append-lf','.append-nul'])q(selector).addEventListener('change',()=>storage.setItem(`devicedock.send.${id}`,JSON.stringify(sendSuffix(q))))
 q('.stop-send').onclick=()=>task?.abort()
 q('.repeat-send').onclick=action(async()=>{if(task)throw Error('已有发送任务');task=new AbortController();try{await repeatSend(session,parseSend(q('.send-input').value,q('.send-format').value,sendSuffix(q)),{intervalMs:Number(q('.send-interval').value),count:Number(q('.send-count').value),signal:task.signal});status('循环发送完成')}finally{task=null}})
 q('.send-file').onchange=action(async()=>{const file=q('.send-file').files[0];if(!file)return;if(file.size>16*1024*1024)throw Error('文件超过 16 MiB');if(task)throw Error('已有发送任务');task=new AbortController();try{await sendChunks(session,new Uint8Array(await file.arrayBuffer()),{signal:task.signal});status('文件发送完成')}finally{task=null;q('.send-file').value=''}})
 mountCommands({q,session,id,storage,action})
 q('.save-preset').onclick=()=>{storage.setItem(`devicedock.preset.${id}`,JSON.stringify(Object.fromEntries(['baud','data-bits','stop-bits','parity','flow-control','protocol'].map(k=>[k,q('.'+k).value]))));status('参数与协议预设已保存（不包含设备）')}
 q('.load-preset').onclick=action(()=>{if(session.state!=='closed')throw Error('请先断开连接');const preset=JSON.parse(storage.getItem(`devicedock.preset.${id}`)||'null');if(!preset)throw Error('没有已保存预设');for(const [k,v]of Object.entries(preset))if(['baud','data-bits','stop-bits','parity','flow-control','protocol'].includes(k))q('.'+k).value=v;q('.protocol').dispatchEvent(new Event('change'));render()})
 q('.set-signals').onclick=action(()=>session.setSignals({dataTerminalReady:q('.dtr').checked,requestToSend:q('.rts').checked,break:q('.break').checked}))
}
