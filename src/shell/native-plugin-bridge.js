// Injected only into a verified opaque-origin native plugin iframe.
(() => {
 const pending = new Map(); let sequence = 0
 window.deviceDockNative = Object.freeze({call(method, params = null) {
  if (typeof method !== 'string' || pending.size >= 8) return Promise.reject(Error('Native RPC limit'))
  const id = ++sequence
  return new Promise((resolve, reject) => {
   const timer = setTimeout(() => {pending.delete(id); reject(Error('Native RPC timed out'))}, 15000)
   pending.set(id, {resolve, reject, timer})
   parent.postMessage({type:'devicedock-native-call', id, method, params}, '*')
  })
 }})
 addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'devicedock-native-reply') return
  const item = pending.get(event.data.id); if (!item) return
  pending.delete(event.data.id); clearTimeout(item.timer)
  if (event.data.error) item.reject(Error(event.data.error)); else item.resolve(event.data.result)
 })
})()
