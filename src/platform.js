import adapter from './serial-adapter.js'
import { createNativeSerialBackend } from './transport-native-serial.js'
export async function platformServices(root = globalThis) {
 const native = root.__TAURI__?.core
 const mobile = /Android|iPhone|iPad|iPod/.test(root.navigator?.userAgent || '') || (/Macintosh/.test(root.navigator?.userAgent || '') && root.navigator?.maxTouchPoints > 1)
 const platform = mobile ? 'mobile' : native ? 'desktop' : 'web'
 let shell = {}
 if (native) { try { shell = await native.invoke('host_capabilities') } catch {} }
 const capabilities = { serial: !!root.navigator?.serial || !!shell.serial, 'native.serial': !!shell.serial, 'native.ble': !!shell.ble, 'native.spp': !!shell.spp, 'web.bluetooth': !!root.navigator?.bluetooth }
 return { platform, mobile, native, capabilities }
}
export function serialProvider(platform, chooseNative) {
 if (!platform.native || !platform.capabilities['native.serial']) return { id: 'serial', title: '串口', requestPort: options => adapter.requestPort(options) }
 const invoke = platform.native.invoke
 const released = invoke('serial_release_owned')
 released.catch(() => {})
 const backend = createNativeSerialBackend({
  invoke: (command,args) => command === 'serial_open' ? released.then(() => invoke(command,args)) : invoke(command,args),
  Channel: platform.native.Channel, storage: globalThis.localStorage,
  choosePort: async context => { const list = context.list(), path = await chooseNative(list); return list.find(item => item.path === path) || null }
 })
 adapter.register(backend); adapter.use('native')
 globalThis.addEventListener?.('pagehide',() => { backend._stop(); invoke('serial_release_owned').catch(() => {}) },{ once: true })
 return { id: 'serial', title: '原生串口', requestPort: options => adapter.requestPort(options) }
}
