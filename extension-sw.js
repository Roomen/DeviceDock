import { verifyPackage, mime } from './src/package.js'
let installation = Promise.resolve()
const prefix = new URL('__extensions/', self.registration.scope).pathname
const shellCache = 'devicedock-shell-v0.1.0'
self.addEventListener('install', event => event.waitUntil((async () => {
 const response = await fetch(new URL('offline-assets.json',self.registration.scope))
 if (response.ok) {
  const assets = await response.json()
  if (!Array.isArray(assets) || assets.length > 3000 || assets.some(path => !/^\.\/[a-zA-Z0-9_@./-]+$/.test(path) || path.includes('..'))) throw Error('Invalid offline asset list')
  const cache=await caches.open(shellCache); await cache.addAll(assets.map(path=>new URL(path,self.registration.scope)))
  // Navigation uses scope URL; same index bytes as the explicit index.html URL.
  await cache.put(self.registration.scope,await cache.match(new URL('index.html',self.registration.scope)))
 }
 await self.skipWaiting()
})()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('message', event => {
 if (event.data?.type !== 'install' || !event.ports[0]) return
 const task = installation.then(async () => {
  let cacheName, created = false
  try {
   const verified = await verifyPackage(event.data.bundle)
   cacheName = 'devicedock-package-' + verified.hash
   const cache = await caches.open(cacheName)
   if (await cache.match(new URL(prefix + verified.hash + '/__complete',self.location.origin))) { event.ports[0].postMessage({ hash:verified.hash }); return }
   created = true
   for (const [path,bytes] of verified.files) await cache.put(new URL(prefix + verified.hash + '/' + path,self.location.origin),new Response(bytes,{ headers: { 'Content-Type': mime(path), 'X-Content-Type-Options': 'nosniff' } }))
   // Marker written last. Fetch never serves an incompletely staged package.
   await cache.put(new URL(prefix + verified.hash + '/__complete',self.location.origin),new Response('verified'))
   event.ports[0].postMessage({ hash: verified.hash })
  } catch (e) { if (created && cacheName) await caches.delete(cacheName); event.ports[0].postMessage({ error: String(e.message) }) }
 })
 installation = task.catch(() => {})
 event.waitUntil(task)
})
self.addEventListener('fetch', event => {
 const u = new URL(event.request.url)
 if (u.origin !== self.location.origin) return
 if (!u.pathname.startsWith(prefix)) {
  if(event.request.method !== 'GET') return
  event.respondWith((async () => {
   const cache=await caches.open(shellCache)
   try { const response=await fetch(event.request); if(response.ok && await cache.match(event.request,{ignoreSearch:true})) await cache.put(event.request,response.clone()); return response }
   catch { return await cache.match(event.request,{ignoreSearch:true}) || new Response('Offline resource unavailable',{status:503}) }
  })())
  return
 }
 event.respondWith((async () => {
  const hash = u.pathname.slice(prefix.length).split('/')[0]
  if (!/^[a-f0-9]{64}$/.test(hash) || u.search) return new Response('Invalid package path',{ status: 400 })
  const cache = await caches.open('devicedock-package-' + hash)
  if (!await cache.match(new URL(prefix + hash + '/__complete',self.location.origin))) return new Response('Package unavailable',{ status: 404 })
  return await cache.match(event.request) || new Response('Unlisted package file',{ status: 404 })
 })())
})
