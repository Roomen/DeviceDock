export function mountSendHistory({q,id,storage}){
 const key=`devicedock.history.${id}`,input=q('.send-input'),select=q('.send-history');let history=[],index=-1,draft=''
 try{const a=JSON.parse(storage.getItem(key));if(Array.isArray(a))history=a.filter(v=>typeof v==='string'&&v.length<=8192).slice(0,30)}catch{}
 const draw=()=>{select.replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent='发送历史';select.append(blank);history.forEach((v,i)=>{const o=document.createElement('option');o.value=i;o.textContent=v.slice(0,60);select.append(o)})}
 const pick=v=>{input.value=v;input.dispatchEvent(new Event('change'))}
 select.onchange=()=>{if(select.value!=='')pick(history[Number(select.value)]);select.value=''}
 q('.clear-history').onclick=()=>{history=[];storage.setItem(key,'[]');draw()}
 input.addEventListener('input',()=>{index=-1})
 input.addEventListener('keydown',e=>{if(e.altKey||e.ctrlKey||e.metaKey||e.shiftKey)return;if(e.key==='ArrowUp'&&input.selectionStart===0&&history.length&&index<history.length-1){e.preventDefault();if(index===-1)draft=input.value;pick(history[++index]);input.setSelectionRange(0,0)}else if(e.key==='ArrowDown'&&input.selectionEnd===input.value.length&&index!==-1){e.preventDefault();index--;pick(index===-1?draft:history[index]);input.setSelectionRange(input.value.length,input.value.length)}})
 draw();return {push(value){index=-1;if(!value||value.length>8192||history[0]===value)return;history=[value,...history.filter(v=>v!==value)].slice(0,30);storage.setItem(key,JSON.stringify(history));draw()}}
}
