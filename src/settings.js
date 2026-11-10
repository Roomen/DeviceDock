import config from './presets.js'
import {importCommands,downloadText} from './quick-commands.js'
const parse=value=>typeof value==='string'?JSON.parse(value):value
export const settingKeys=['devicedock.theme','devicedock.presets',...['A','B'].flatMap(id=>['lane','display','quick-groups','protocol','send'].map(k=>`devicedock.${k}.${id}`))]
export function importSettings(raw){
 const data=parse(raw);if(!data||typeof data!=='object'||Array.isArray(data))throw Error('参数文件无效')
 if(data.schemaVersion===1&&data.settings){const result={};for(const key of settingKeys)if(Object.hasOwn(data.settings,key)){if(typeof data.settings[key]!=='string'||data.settings[key].length>1024*1024)throw Error('参数值无效');result[key]=data.settings[key]}return result}
 const result={},lanes=config.migrateLaneOptions(data.serialOptionsDualLanes,data.serialOptionsDual||data.serialOptions),protocols=config.migrateLaneProtocols(data.serialProtocolDual,'sek')
 for(const id of ['A','B']){const options=id==='A'&&!data.serialOptionsDual?config.normalizeOptions(parse(data.serialOptions||'null')):lanes[id];result[`devicedock.lane.${id}`]=JSON.stringify(options);result[`devicedock.protocol.${id}`]=JSON.stringify(protocols[id]);const display=parse(data.toolOptionsDual||data.toolOptions||'null');if(display){const format=String(display.logType||'hex');result[`devicedock.display.${id}`]=JSON.stringify({display:format==='term'?'term':format==='text'?'text':format.includes('hex')&&format.includes('text')?'both':format.includes('parse')?'hexparse':'hex','split-mode':display.splitMode==='line'?'line':'time','split-time':Math.max(0,Math.min(60000,parseInt(display.timeOut)||200)),'max-rows':Math.max(100,Math.min(100000,parseInt(display.maxLogRows)||10000))});result[`devicedock.send.${id}`]=JSON.stringify({cr:!!display.addCR,lf:!!display.addLF,nul:!!display.addNUL})}}
 if(data.quickSendList){const groups=parse(data.quickSendList);if(!Array.isArray(groups)||groups.length>50)throw Error('快捷分组无效');const converted=groups.map(g=>({name:String(g.name||'导入分组').slice(0,60),commands:importCommands(g.list)}));for(const id of ['A','B'])result[`devicedock.quick-groups.${id}`]=JSON.stringify(converted)}
 if(!['serialOptions','serialOptionsDual','quickSendList','toolOptions','serialOptionsDualLanes'].some(k=>Object.hasOwn(data,k)))throw Error('无法识别参数文件')
 return result
}
export function mountSettings({$,sessions,storage,action,status}){
 $('#settings-export').onclick=()=>downloadText('devicedock-settings.json',JSON.stringify({schemaVersion:1,settings:Object.fromEntries(settingKeys.map(k=>[k,storage.getItem(k)]).filter(([,v])=>v!==null))},null,2))
 $('#settings-import').onchange=action(async()=>{if(Object.values(sessions).some(s=>s.state!=='closed'))throw Error('请先断开全部连接');const f=$('#settings-import').files[0];if(!f)return;if(f.size>2*1024*1024)throw Error('参数文件超过 2 MiB');const data=importSettings(await f.text());for(const[k,v]of Object.entries(data))storage.setItem(k,v);status('参数已导入；刷新页面应用配置，扩展仍需明确启用')})
 $('#settings-reset').onclick=action(()=>{if(Object.values(sessions).some(s=>s.state!=='closed'))throw Error('请先断开全部连接');for(const key of settingKeys)storage.removeItem(key);status('核心参数已重置；刷新页面应用')})
}
