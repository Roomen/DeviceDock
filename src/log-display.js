// Presentation grouping never changes raw session/MCP rows or protocol message boundaries.
export function displayRows(rows,{mode='chunk',timeoutMs=200}={}){
 if(!['chunk','time','line'].includes(mode)||!Number.isInteger(timeoutMs)||timeoutMs<0||timeoutMs>60000)throw Error('Invalid display splitting')
 if(mode==='chunk')return rows
 const result=[];let current
 const flush=()=>{if(current){current.bytes=Uint8Array.from(current.data);delete current.data;result.push(current);current=null}}
 for(const row of rows){
  if(row.direction!=='rx'||row.boundary||!row.bytes.length){flush();result.push(row);continue}
  if(current&&(current.generation!==row.generation||row.time-current.lastTime>timeoutMs||current.data.length+row.bytes.length>65536))flush()
  for(const byte of row.bytes){if(!current)current={...row,data:[],frames:[],views:[],sourceSequences:[],lastTime:row.time};if(!current.sourceSequences.includes(row.sequence))current.sourceSequences.push(row.sequence);current.data.push(byte);current.lastTime=row.time;if(mode==='line'&&byte===10)flush()}
  const target=current||result.at(-1);if(target?.frames){target.frames.push(...row.frames||[]);target.views.push(...row.views||[])}
 }
 flush();return result
}
export function mountTerminal({q,session,action}){
 const terminal=new globalThis.Terminal({convertEol:true,scrollback:3000,disableStdin:false,theme:{background:'#10151f',foreground:'#e7edf7'}})
 terminal.open(q('.terminal'));const fit=new globalThis.FitAddon.FitAddon();terminal.loadAddon(fit)
 let generation=session.generation
 for(const row of session.logs){if(row.generation!==generation){terminal.reset();generation=row.generation}if(row.direction==='rx')terminal.write(row.bytes)}
 terminal.onData(text=>{action(()=>session.send(new TextEncoder().encode(text)))()})
 const off=session.subscribe(row=>{if(row.generation!==generation){terminal.reset();generation=row.generation}if(row.direction==='rx')terminal.write(row.bytes)})
 const observer=new ResizeObserver(()=>{if(q('.display').value==='term')fit.fit()});observer.observe(q('.terminal'))
 const visible=()=>q('.display').value==='term'
 // A hidden page has zero layout, so the terminal must re-fit once its page is
 // shown again instead of keeping the size it had before being hidden.
 const refit=()=>{if(!visible())return;fit.fit();requestAnimationFrame(()=>{if(visible())fit.fit()})}
 const show=()=>{q('.terminal').hidden=!visible();q('.logs').hidden=visible();if(visible())refit()}
 const view=q('.terminal').ownerDocument?.defaultView
 view?.addEventListener?.('devicedock:page-resize',refit)
 q('.display').addEventListener('change',show);show()
 return {getText:()=>{const lines=[];for(let i=0;i<terminal.buffer.active.length;i++)lines.push(terminal.buffer.active.getLine(i)?.translateToString(true)||'');return lines.join('\n').trimEnd()},clear:()=>terminal.clear(),dispose:()=>{off();view?.removeEventListener?.('devicedock:page-resize',refit);observer.disconnect();terminal.dispose()}}
}
