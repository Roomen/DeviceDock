import { validateArguments } from './schema.js'
import { McpRing } from './mcp-ring.js'
import { parseSend } from './view.js'
const object = value => value && typeof value === 'object' && !Array.isArray(value)
export function createMcpTools({host,sessions,serial},document = globalThis.crypto.randomUUID()) {
 const rings = new Map(Object.entries(sessions).map(([id,s]) => [id,new McpRing(s,document)]))
 const definitions = [
  ['host_state','Inspect capabilities, lanes and enabled extensions',{}],
  ['serial_ports','List already authorized ports; does not show a chooser',{}],
  ['serial_open','Open an explicitly selected authorized serial port',{lane:{type:'string'},deviceId:{type:'string'},sn:{type:'string'},options:{type:'object'}}],
  ['serial_select','Select an authorized device without opening',{lane:{type:'string'},deviceId:{type:'string'},sn:{type:'string'}}],
  ['serial_configure','Configure lane parameters, reopening an idle connection',{lane:{type:'string'},options:{type:'object'}}],
  ['serial_close','Close the selected lane',{lane:{type:'string'}}],
  ['serial_write','Send HEX or text through the same session ownership checks',{lane:{type:'string'},data:{type:'string',maxLength:8192},format:{type:'string',enum:['hex','text']},encoding:{type:'string',enum:['hex','text']},append_crlf:{type:'boolean'}}],
  ['serial_read','Read bounded logs after a sequence cursor; truncated signals eviction',{lane:{type:'string'},cursor:{type:'object'},limit:{type:'integer',minimum:1,maximum:500},waitMs:{type:'integer',minimum:0,maximum:30000}}],
  ['serial_signals','Set serial control signals',{lane:{type:'string'},signals:{type:'object'}}]

 ].map(([name,description,properties]) => ({name,description,timeoutMs:name==='serial_read'?35000:30000,inputSchema:{type:'object',properties,additionalProperties:false}}))
 const selected=new Map(),configurations=new Map();const ports = new Map(), identifiers = new WeakMap()
 const idFor = p => {if(!identifiers.has(p))identifiers.set(p,globalThis.crypto.randomUUID());const id=identifiers.get(p);ports.set(id,p);return id}
 const pluginTools = new Map(host.mcpTools || [])
 for (const tool of pluginTools.values()) definitions.push(tool.definition)
 for(const [alias,target] of [['serial_ports_list','serial_ports'],['serial_state','host_state']])definitions.push({...definitions.find(d=>d.name===target),name:alias})
 const aliases=new Map(host.mcpAliases||[])
 for(const[name,{target}]of aliases){const source=pluginTools.get(target);if(source)definitions.push({...source.definition,name})}
 const toolMap = new Map(definitions.map(d => [d.name,d]))

 async function call(name,args = {},context = {signal:new AbortController().signal,commit:async()=>{}}) {
  const definition = toolMap.get(name)
  if (!definition) throw Error('Unknown tool')
  validateArguments(args,definition.inputSchema)
  if (host.updating) throw Error('Application update in progress')
  if(aliases.has(name)){if(host.mcpAliases?.get(name)!==aliases.get(name))throw Error('Tool catalog changed; refresh MCP');name=aliases.get(name).target}
  if (pluginTools.has(name)) {if (host.mcpTools?.get(name)!==pluginTools.get(name))throw Error('Tool catalog changed; restart MCP');return pluginTools.get(name).call(args,context)}
  const check = () => {if(context.signal.aborted) throw Error('Request cancelled')}
  const commit = async () => {check();await context.commit();check()}
  const lane = () => { if(args.lane==='S'&&sessions.A)args={...args,lane:'A'};if (typeof args.lane !== 'string' || !Object.hasOwn(sessions,args.lane)) throw Error('Explicit valid lane required'); return sessions[args.lane] }
  name=({serial_ports_list:'serial_ports',serial_state:'host_state'})[name] || name
  switch(name) {
   case 'host_state': return {platform:host.platform,capabilities:host.capabilities,lanes:Object.values(sessions).map(s => ({lane:s.lane,state:s.state,generation:s.generation,busy:s.busy,sequence:s.sequence})),extensions:[...host.extensions].map(([id,e]) => ({id,status:e.status,version:e.manifest.version}))}
   case 'serial_ports': return (await serial.getPorts()).map(p => ({deviceId:idFor(p),info:p.getInfo?.() || {}}))
   case 'serial_select':
   case 'serial_open': {
    const s=lane(),generation=s.generation;if(s.busy||s.state!=='closed')throw Error('Lane must be idle and closed')
    if(args.deviceId&&args.sn)throw Error('Select exactly one deviceId or serial number')
    const present=await serial.getPorts();let port=args.deviceId?ports.get(args.deviceId):selected.get(s.lane)
    if(args.sn){const matches=present.filter(p=>(p.getInfo?.()||{}).serialNumber===args.sn);if(matches.length!==1)throw Error('Serial number is absent or ambiguous');port=matches[0]}
    if(!port||!present.includes(port))throw Error('Select a currently authorized deviceId first')
    const o=serialOptions({...host.laneSettings?.get(s.lane)?.get(),...configurations.get(s.lane),...args.options})
    await commit();if(s.generation!==generation||s.state!=='closed')throw Error('Connection changed')
    if(!(await serial.getPorts()).includes(port))throw Error('Selected device disconnected')
    check();if(s.generation!==generation||s.state!=='closed')throw Error('Connection changed')
    selected.set(s.lane,port);if(name==='serial_select')return {selected:true,lane:s.lane,deviceId:idFor(port)}
    await s.open(port,o);return {state:s.state,generation:s.generation}
   }
   case 'serial_configure':{
    const s=lane(),generation=s.generation;if(s.busy||!['open','closed'].includes(s.state))throw Error('Lane owned by an active operation')
    const o=serialOptions({...host.laneSettings?.get(s.lane)?.get(),...configurations.get(s.lane),...args.options}),port=s.port
    if(port?.getInfo?.().transport&&port.getInfo().transport!=='serial')throw Error('Wireless transport has no serial parameters')
    await commit();if(s.generation!==generation)throw Error('Connection changed');configurations.set(s.lane,o);host.laneSettings?.get(s.lane)?.set(o)
    if(port){await s.close();check();await s.open(port,o)}return {options:o,reopened:!!port}
   }
   case 'serial_close': {const s=lane(),generation=s.generation;if(s.busy||s.owner)throw Error('Lane owned by an active operation');await commit();if(s.generation!==generation)throw Error('Connection changed');await s.close();return {state:s.state}}
   case 'serial_write': args={...args,format:args.format||args.encoding||'hex'};if (typeof args.data !== 'string' || args.data.length > 8192 || !['hex','text'].includes(args.format)) throw Error('Invalid data/format'); await lane().send(parseSend(args.data,args.format,!!args.append_crlf),{beforeWrite:commit}); return {sent:true}
   case 'serial_read': {
    const s = lane(), generation=s.generation, ring=rings.get(s.lane), end=Date.now()+(args.waitMs||0);let result;do{check();if(s.generation!==generation)throw Error('Connection changed');result=ring.read(args.cursor,args.limit);if(result.rows.length||Date.now()>=end)break;await new Promise(resolve=>setTimeout(resolve,Math.min(25,end-Date.now())))}while(true);return result
   }
   case 'serial_signals': await lane().setSignals(args.signals,{beforeWrite:commit}); return {set:true}

  }
 }
 return {definitions,call,document,sessions,refreshCatalog:()=>{for(let i=definitions.length-1;i>=0;i--)if(pluginTools.has(definitions[i].name)||aliases.has(definitions[i].name))definitions.splice(i,1);pluginTools.clear();for(const[k,v]of host.mcpTools){pluginTools.set(k,v);definitions.push(v.definition)}aliases.clear();for(const[k,v]of host.mcpAliases||[]){aliases.set(k,v);const source=pluginTools.get(v.target);if(source)definitions.push({...source.definition,name:k})}toolMap.clear();for(const d of definitions)toolMap.set(d.name,d)},isStale:()=>aliases.size!==(host.mcpAliases?.size||0)||[...aliases].some(([k,v])=>host.mcpAliases?.get(k)!==v)||pluginTools.size!==host.mcpTools.size || [...pluginTools].some(([k,v])=>host.mcpTools.get(k)!==v),dispose:()=>rings.forEach(r=>r.dispose())}
}
export async function registerMcpBridge(native,tools) {
 const channel = new native.Channel(), active = new Map(), epoch = tools.document
 channel.onmessage = async request => {
  if(request.cancel) {active.get(request.id)?.abort();return}
  const controller = new AbortController(); active.set(request.id,controller)
  let result, committed, didCommit=false
  const commit = () => committed ||= native.invoke('mcp_commit',{id:request.id,epoch}).then(ok => {if(!ok)throw Error('Request expired before execution');didCommit=true})
  const snapshot = {document:epoch,lanes:Object.fromEntries(Object.entries(tools.sessions || {}).map(([id,s])=>[id,{generation:s.generation,state:s.state}]))}
  try { const data = await tools.call(request.name,request.arguments,{signal:controller.signal,commit,snapshot}); result = {content:[{type:'text',text:JSON.stringify(data??null)}],structuredContent:object(data)?data:{value:data??null},isError:false} }
  catch(e) { result = {content:[{type:'text',text:String(e.message || e)}],structuredContent:{code:controller.signal.aborted?'cancelled':'tool_error',executed:didCommit?'unknown':false},isError:true} }
  finally {active.delete(request.id)}
  await native.invoke('mcp_reply',{id:request.id,epoch,result}).catch(() => {})
 }
 return native.invoke('mcp_register',{epoch,tools:tools.definitions,channel})
}

export async function startMcpBridge(native,tools,port=32123){await registerMcpBridge(native,tools);return native.invoke('mcp_start',{port})}

function serialOptions(patch={}){
 if(!object(patch))throw Error('Invalid serial options')
 const o={baudRate:115200,dataBits:8,stopBits:1,parity:'none',flowControl:'none',bufferSize:1024,...patch}
 if(Object.keys(o).some(k=>!['baudRate','bufferSize','dataBits','stopBits','parity','flowControl'].includes(k))||!Number.isInteger(o.baudRate)||o.baudRate<1||o.baudRate>4000000||!Number.isInteger(o.bufferSize)||o.bufferSize<1||o.bufferSize>16777216||![7,8].includes(o.dataBits)||![1,2].includes(o.stopBits)||!['none','even','odd'].includes(o.parity)||!['none','hardware'].includes(o.flowControl))throw Error('Invalid serial options')
 return o
}
