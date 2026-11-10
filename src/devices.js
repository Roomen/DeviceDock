// Only strong serial identity may survive a document. VID/PID or names alone never authorize reconnect.
const supplemental=new WeakMap()
export function deviceIdentity(port){
 const i={...supplemental.get(port),...port?.getInfo?.()};if(i.transport&&i.transport!=='serial')return null
 const base={vid:i.usbVendorId??null,pid:i.usbProductId??null}
 if(i.serialNumber)return {...base,sn:String(i.serialNumber),...(i.path?{path:String(i.path)}:{})}
 if(i.path)return {...base,path:String(i.path)}
 return null
}
export function matchesDevice(a,b){if(!a||!b||a.vid!==b.vid||a.pid!==b.pid)return false;if(a.sn&&b.sn&&a.sn!==b.sn)return false;if(a.path&&b.path)return a.path===b.path;return !!a.sn&&a.sn===b.sn}
export class DeviceMemory{
 constructor(storage,runtime){Object.assign(this,{storage,runtime});this.sessionAliases=new WeakMap()}
 alias(port){const identity=deviceIdentity(port);if(!identity)return this.sessionAliases.get(port)||'';return this.aliases().find(e=>matchesDevice(e.identity,identity))?.name||''}
 aliases(){try{const a=JSON.parse(this.storage.getItem('devicedock.aliases'));return Array.isArray(a)?a:[]}catch{return[]}}
 setAlias(port,name){name=name.trim().slice(0,32);const identity=deviceIdentity(port);if(!identity){this.sessionAliases.set(port,name);return}const rows=this.aliases().filter(e=>!matchesDevice(e.identity,identity));if(name)rows.push({identity,name});this.storage.setItem('devicedock.aliases',JSON.stringify(rows))}
 remember(lane,port,options){const identity=deviceIdentity(port);if(identity)this.runtime.setItem(`devicedock.reconnect.${lane}`,JSON.stringify({identity,options}));else this.forget(lane)}
 forget(lane){this.runtime.removeItem(`devicedock.reconnect.${lane}`)}
 async candidate(lane,provider){let intent;try{intent=JSON.parse(this.runtime.getItem(`devicedock.reconnect.${lane}`))}catch{}if(!intent)return null;const ports=await provider.getPorts();const matches=ports.filter(p=>matchesDevice(intent.identity,deviceIdentity(p)));return matches.length===1?{port:matches[0],options:intent.options}:null}
}

export async function supplementUsbIdentity(provider){
 const ports=await provider.getPorts(),devices=await provider.getUsbDevices?.()||[]
 for(const port of ports){supplemental.delete(port);const info=port.getInfo?.()||{};if(info.transport&&info.transport!=='serial'||info.serialNumber||info.path)continue
  const matches=devices.filter(d=>d.vendorId===info.usbVendorId&&d.productId===info.usbProductId&&d.serialNumber),siblings=ports.filter(p=>{const i=p.getInfo?.()||{};return i.usbVendorId===info.usbVendorId&&i.usbProductId===info.usbProductId})
  if(matches.length===1&&siblings.length===1)supplemental.set(port,{serialNumber:matches[0].serialNumber,productName:matches[0].productName})
 }
 return ports
}
