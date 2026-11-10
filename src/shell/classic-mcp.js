import {validateSchema,validateArguments} from '../schema.js'
// Native SPP is a compiled shell capability. Only the original eight explicit tools are exposed.
export function classicTools(host,service){
 const definitions=[
  ['state',{},[],30000],['devices',{},[],30000],['read',{cursor:{type:'string',maxLength:300}},[],30000],
  ['discover',{},[],120000],['pair',{},[],120000],['connect',{deviceId:{type:'string',minLength:1,maxLength:128}},['deviceId'],30000],
  ['close',{},[],30000],['write',{generation:{type:'integer',minimum:0},hex:{type:'string',minLength:2,maxLength:131072,pattern:'^\\s*(?:[0-9a-fA-F]{2}\\s*)+$'}},['generation','hex'],30000]
 ],tools=[]
 for(const[action,properties,required,timeoutMs]of definitions){
  const definition={name:'classic_'+action,description:`Native Classic SPP ${action}; system pairing always requires local user interaction.`,timeoutMs,inputSchema:{type:'object',properties,required,additionalProperties:false}};validateSchema(definition.inputSchema)
  const call=async(args,context)=>{
   validateArguments(args,definition.inputSchema);context.signal.throwIfAborted();if(host.updating)throw Error('Application update in progress')
   if(action==='state')return service.state();if(action==='devices')return {devices:service.devices()};if(action==='read')return service.read(args)
   const state=service.state();if(state.laneOwned)throw Error('SPP is owned by a core lane; use serial tools');const generation=state.generation;if(action==='connect'&&!service.devices().some(d=>d.deviceId===args.deviceId&&d.paired))throw Error('Select a paired SPP device first');if(action==='write'&&args.generation!==generation)throw Error('Stale SPP connection generation')
   const step=()=>context.signal.aborted?{code:'cancelled',message:'Native SPP request cancelled'}:host.updating?{code:'update_preparing',message:'Application update in progress'}:null
   const guard={step,async start(){const denied=step();if(denied)return denied;if(service.state().generation!==generation||service.state().laneOwned)throw Error('SPP connection changed');if(action==='connect'&&!service.devices().some(d=>d.deviceId===args.deviceId&&d.paired))throw Error('Selected SPP device changed');await context.commit();const after=step();if(after)return after;if(service.state().generation!==generation||service.state().laneOwned)throw Error('SPP connection changed');return null}}
   return service.run(action,args,guard)
  }
  tools.push({definition,call})
 }
 return tools
}
