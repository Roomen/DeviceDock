import config from './presets.js'
import {downloadText} from './quick-commands.js'
export function mountPresets({$,laneUI,sessions,host,action,status,storage}){
 const key='devicedock.presets';let presets=config.normalizePresets(storage.getItem(key))
 const read=id=>{const q=laneUI.get(id).q;return{options:{baudRate:Number(q('.baud').value),dataBits:Number(q('.data-bits').value),stopBits:Number(q('.stop-bits').value),parity:q('.parity').value,flowControl:q('.flow-control').value,bufferSize:Number(q('.buffer-size').value)},protocol:q('.protocol').value||'raw',label:q('.lane-label').value}}
 const draw=()=>{const select=$('#preset-list');select.replaceChildren();for(const p of presets){if(!sessions.B&&!config.isSinglePreset(p))continue;const o=document.createElement('option');o.value=p.name;o.textContent=`${p.name} · ${config.isSinglePreset(p)?'单路':'双路'}`;select.append(o)}}
 const save=()=>{storage.setItem(key,config.serializePresets(presets));draw()}
 $('#preset-save').onclick=action(()=>{const name=$('#preset-name').value;const preset=$('#dual').checked&&sessions.B?config.makePreset(name,{A:read('A'),B:read('B')}):config.makeSinglePreset(name,read('A'));presets=config.upsertPreset(presets,preset).list;save();$('#preset-list').value=preset.name})
 $('#preset-rename').onclick=action(()=>{presets=config.renamePreset(presets,$('#preset-list').value,$('#preset-name').value);save()})
 $('#preset-delete').onclick=()=>{presets=config.removePreset(presets,$('#preset-list').value);save()}
 $('#preset-apply').onclick=action(()=>{
  const p=presets.find(p=>p.name===$('#preset-list').value);if(!p)throw Error('请选择预设');if(Object.values(sessions).some(s=>s.state!=='closed'))throw Error('套用参数前请先断开连接')
  if(!config.isSinglePreset(p)&&!sessions.B)throw Error('移动端不支持双路预设')
  const current={A:read('A'),...(sessions.B?{B:read('B')}:{})};current.S=current.A
  const plan=config.planApply(p,current,id=>id==='raw'||host.protocols.has(id));for(const[id,lane]of Object.entries(plan.lanes)){const q=laneUI.get(id==='S'?'A':id).q;for(const[k,selector]of Object.entries({baudRate:'.baud',dataBits:'.data-bits',stopBits:'.stop-bits',parity:'.parity',flowControl:'.flow-control',bufferSize:'.buffer-size'})){q(selector).value=lane.options[k];q(selector).dispatchEvent(new Event('change'))}q('.protocol').value=lane.protocol==='raw'?'':lane.protocol;q('.protocol').dispatchEvent(new Event('change'));if(id!=='S'){q('.lane-label').value=lane.label;q('.lane-label').dispatchEvent(new Event('change'))}}
  if(sessions.B){$('#dual').checked=!config.isSinglePreset(p);$('#dual').dispatchEvent(new Event('change'))}status(plan.unknownProtocols.length?'已套用参数；未安装协议保留当前选择：'+plan.unknownProtocols.join(', '):'预设已套用；设备由本窗口独立选择')
 })
 $('#preset-export').onclick=()=>downloadText('devicedock-presets.json',config.serializePresets(presets))
 $('#preset-import').onchange=action(async()=>{const f=$('#preset-import').files[0];if(!f)return;if(f.size>1024*1024)throw Error('预设超过 1 MiB');const incoming=config.normalizePresets(await f.text());if(!incoming.length)throw Error('没有有效预设');let next=presets;for(const p of incoming)next=config.upsertPreset(next,p).list;presets=next;save();$('#preset-import').value=''})
 draw()
}
