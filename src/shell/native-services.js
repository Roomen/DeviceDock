// Shell capability providers. Native drivers are compiled into the app, never downloaded.
import { create as createBle, mapping } from './native-ble.js'
import { create as createClassic } from './native-classic.js'
import { createStreamPort } from '../serial-adapter.js'
export function nativeProviders(platform, host, doc = document) {
 const deps = {invoke:platform.native.invoke,Channel:platform.native.Channel,createStreamPort,toBytes:bytes => bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Uint8Array.from(bytes),blocked:() => host.updating,boundPorts:() => host.allSessions().map(s => s.port).filter(Boolean),isPinned:() => host.allSessions().some(s => s.busy)}
 const result = []
 if (platform.capabilities['native.ble']) {
  const service = createBle(deps); let picking = false
  const provider = {id:'native-ble',title:'电脑 BLE',release:() => service.release(),isBusy:() => service.isBusyForUpdate(),async requestPort() {
   if (picking || !service.canSelect()) throw Error('请先关闭现有 BLE 连接或完成设备选择')
   picking = true; let record, selected
   const dialog = doc.createElement('dialog'), title = doc.createElement('h2'), devices = doc.createElement('select'), next = doc.createElement('button'), cancel = doc.createElement('button'), message = doc.createElement('p')
   title.textContent = '选择 BLE 设备'; next.textContent = '读取 GATT 服务'; cancel.textContent = '取消'; message.textContent = '正在扫描附近设备…'; dialog.append(title,devices,message,next,cancel); doc.body.append(dialog)
   const choose = controls => new Promise(resolve => {
    next.onclick = () => resolve(true); cancel.onclick = () => resolve(false); dialog.oncancel = e => {e.preventDefault();resolve(false)}; controls?.()
   })
   dialog.showModal()
   let scanError
   const scanning = service.scan(device => {
    let option = [...devices.options].find(o => o.value === device.deviceId)
    if (!option) {option=doc.createElement('option');option.value=device.deviceId;devices.append(option)}
    option.textContent = `${device.name} · ${device.rssi ?? '?'} dBm`
   }).catch(e => {scanError=e;message.textContent=e.message})
   try {
    if (!await choose()) throw Error('已取消 BLE 选择')
    await service.stopScan(); await scanning; if (scanError) throw scanError
    const device = service.devices().find(d => d.deviceId === devices.value); if (!device) throw Error('请选择扫描到的 BLE 设备')
    message.textContent = '正在发现 GATT 服务…'; next.disabled = true
    record = await service.inspect(device)
    const tx=doc.createElement('select'),rx=doc.createElement('select'),response=doc.createElement('input'),label=doc.createElement('label'); response.type='checkbox'; response.checked=true; label.append(response,doc.createTextNode('写入等待响应'))
    for (const c of record.chars) {
     const text = `${c.service} / ${c.characteristic} [${c.id}]`
     if (c.props & 12) {const o=doc.createElement('option');o.value=c.id;o.textContent='TX '+text;tx.append(o)}
     if (c.props & 48) {const o=doc.createElement('option');o.value=c.id;o.textContent='RX '+text;rx.append(o)}
    }
    dialog.insertBefore(tx,message); dialog.insertBefore(rx,message); dialog.insertBefore(label,message); devices.hidden=true
    title.textContent='选择收发特征'; message.textContent='请确认 TX/RX、写入模式与设备协议匹配。';next.textContent='使用此连接';next.disabled=false
    if (!await choose()) throw Error('已取消 GATT 选择')
    const profile = mapping(record.chars,Number(tx.value),Number(rx.value),response.checked)
    selected=service.createPort(record,profile,Number(tx.value),Number(rx.value)); return selected.port
   } finally {
    try { await service.stopScan(); await scanning; if (!selected && record) await service.close(record) }
    finally { dialog.close();dialog.remove();picking=false }
   }
  }}
  result.push(['org.devicedock.native.ble.v1',provider])
 }
 if (platform.capabilities['native.spp']) {
  const service=createClassic(deps)
  const provider={id:'native-spp',title:'经典蓝牙 SPP',release:() => service.release(),isBusy:() => service.isBusyForUpdate(),async requestPort() {
   const selected=await service.run('pair'), device=service.devices().find(d => d.deviceId===selected.selectedDeviceId && d.paired)
   if (!device) throw Error('请先在系统选择器中配对并选择 SPP 设备')
   return service.createPort(device.deviceId)
  }}
  result.push(['org.devicedock.native.spp.v1',provider])
 }
 globalThis.addEventListener?.('pagehide',() => {for(const [,provider] of result) provider.release().catch(() => {})},{once:true})
 return result
}
