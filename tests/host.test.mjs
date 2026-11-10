import test from 'node:test'
import assert from 'node:assert/strict'
import { parseHTML } from 'linkedom'
import { Session } from '../src/session.js'
import { ExtensionHost } from '../src/extensions.js'
import { SourceStore, normalizeSource } from '../src/sources.js'
import { verifyPackage } from '../src/package.js'
import { digest } from '../src/manifest.js'
import { createStreamPort } from '../src/serial-adapter.js'
import { parseSend, renderView } from '../src/view.js'
const tick = () => new Promise(resolve => setTimeout(resolve,0))
const memory = () => { const map = new Map(); return {getItem:k => map.get(k) ?? null,setItem:(k,v) => map.set(k,v)} }
const manifest = {schemaVersion:1,id:'org.test.extension',name:'Test',version:'1.0.0',apiVersion:1,kind:'plugin',entry:'index.js',platforms:['web'],capabilities:[],license:'MIT',integrity:{'index.js':'sha256-' + '0'.repeat(64)}}
function hardware() {
 const writes = [], driver = { async open(_options,sink) { this.sink = sink }, async write(bytes) { writes.push([...bytes]) }, async close() {} }
 return {port:createStreamPort(driver),driver,writes}
}
function fixture() { const {document} = parseHTML('<div id="mount"></div>'); const sessions = {A:new Session('A'),B:new Session('B')}; return {document,sessions,host:new ExtensionHost({sessions,mount:document.querySelector('#mount'),storage:memory()})} }
test('zero-plugin host, physical ownership, real streams TX/RX and recoverable errors',async () => {
 const {sessions,host} = fixture(), hw = hardware(); assert.equal(host.extensions.size,0)
 await sessions.A.open(hw.port,{baudRate:9600}); await assert.rejects(sessions.B.open(hw.port,{baudRate:9600}),/占用/)
 await sessions.A.send(new Uint8Array([1,2])); hw.driver.sink.data(new Uint8Array([3])); await tick()
 assert.deepEqual(hw.writes,[[1,2]]); assert.deepEqual([...sessions.A.logs.find(r => r.direction === 'rx').bytes],[3]); assert.equal(sessions.B.logs.length,0)
 hw.driver.sink.error(Error('recoverable')); await tick(); hw.driver.sink.data(new Uint8Array([4])); await tick()
 assert.equal(sessions.A.connected,true); assert.deepEqual([...sessions.A.logs.at(-1).bytes],[4])
 await sessions.A.close(); assert.equal(sessions.A.state,'closed')
})
test('per-lane protocol and replay do not touch live state or restore across generations',async () => {
 const {sessions} = fixture(); const protocol = {id:'counter',title:'counter',create:({mode}) => { let n = 0; return {feed(bytes) { n += bytes[0]; return [{bytes,view:{text:`${mode}:${n}`}}] },reset(){n=0}} }}
 sessions.A.setProtocol(protocol); sessions.B.setProtocol(protocol)
 sessions.A.emit('rx',new Uint8Array([5])); sessions.B.emit('rx',new Uint8Array([10])); assert.equal(sessions.A.replay()[0].views[0].text,'replay:5')
 sessions.A.emit('rx',new Uint8Array([1])); assert.equal(sessions.A.logs.at(-1).views[0].text,'live:6'); assert.equal(sessions.B.logs[0].views[0].text,'live:10')
})
test('transaction cancellation retains ownership until actual callback/write drain',async () => {
 const s = new Session('A'), hw = hardware(); await s.open(hw.port,{baudRate:9600}); let finish
 const abort = new AbortController(), transaction = s.transaction('firmware',async () => new Promise(resolve => { finish = resolve }),{signal:abort.signal})
 await tick(); abort.abort(); await tick(); assert.equal(s.busy,true); await assert.rejects(s.send(new Uint8Array([1])),/独占/)
 finish(); await assert.rejects(transaction,/取消/); assert.equal(s.busy,false); await s.close()
})
test('extension trust, preflight rejection stays enabled, dedicated resources and namespaces',async () => {
 const {host} = fixture(); let api, reject = true
 const importer = async () => ({activate(context) { api = context; context.registerService('org.devicedock.power.v1',{on:true}); context.prepareDeactivate(() => { if (reject) throw Error('busy') }) }})
 await assert.rejects(host.enable(manifest,'test',false,importer),/授权/)
 await host.enable(manifest,'test',true,importer); const hw = hardware(), resource = api.resources.createSession('instrument'); await resource.open(hw.port,{baudRate:9600})
 await assert.rejects(host.disable(manifest.id),/busy/); assert.equal(host.extensions.get(manifest.id).status,'enabled'); assert.equal(api.signal.aborted,false)
 reject = false; await host.disable(manifest.id); assert.equal(host.resources.size,0); assert.equal(host.services.size,0)
})
test('disabling one extension does not cancel another extension transaction on shared lane',async () => {
 const {host,sessions} = fixture(); const hw = hardware(); await sessions.A.open(hw.port,{baudRate:9600}); let a,b,finish
 await host.enable(manifest,'a',true,async () => ({activate(h) {a = h; h.session('A').subscribe(() => {})}}))
 await host.enable({...manifest,id:'org.test.other'},'b',true,async () => ({activate(h) {b = h}}))
 const work = b.session('A').transaction('ignored',async ({signal}) => new Promise(resolve => { finish = () => { assert.equal(signal.aborted,false); resolve() } }))
 await tick(); await host.disable(manifest.id); finish(); await work; await host.disable('org.test.other'); await sessions.A.close(); assert.equal(a.signal.aborted,true)
})
test('failed cleanup retains registration and ownership; retry recovers',async () => {
 const {host,sessions} = fixture(); const hw=hardware(); await sessions.A.open(hw.port,{baudRate:9600}); let fail = true
 await host.enable(manifest,'a',true,async () => ({activate(h) { h.session('A').claim('ignored'); h.registerService('org.devicedock.power.v1',{}); return async () => {if(fail) throw Error('cleanup failed')} }}))
 await assert.rejects(host.disable(manifest.id),/cleanup failed/); assert.equal(sessions.A.busy,true); assert.equal(host.services.size,1)
 fail = false; await host.disable(manifest.id); assert.equal(sessions.A.busy,false); assert.equal(host.services.size,0); await sessions.A.close()
})
test('activation failure cleans up contributions and resources',async () => {
 const {host} = fixture(); await assert.rejects(host.enable(manifest,'a',true,async () => ({activate(h) {h.registerService('org.devicedock.power.v1',{}); throw Error('broken')} })),/broken/)
 assert.equal(host.services.size,0); assert.equal(host.extensions.size,0)
})
test('source normalization, duplicate namespaces, offline cache and failure recovery',async () => {
 const store = new SourceStore(memory()); const source = store.add('protocol',' https://github.com/Org/Repo.git/ ')
 assert.equal(source.url,'https://github.com/org/repo'); assert.throws(() => store.add('protocol','https://github.com/org/repo'),/存在/); store.add('plugin',source.url)
 for (const url of ['http://github.com/a/b','https://a:b@github.com/a/b','https://github.com/a/b?token=x','https://github.com/a/b/tree/main']) assert.throws(() => normalizeSource('plugin',url))
 const catalog = {schemaVersion:1,packages:[{id:'org.test.extension',kind:'protocol',version:'1.0.0',apiVersion:1,sha256:'0'.repeat(64),url:'https://example.org/release.json',platforms:['web']}]}
 await store.refresh(source,async () => ({ok:true,text:async () => JSON.stringify(catalog)})); await assert.rejects(store.refresh(source,async () => {throw Error('offline')}),/offline/); assert.deepEqual(store.cached(source),catalog)
 store.storage.setItem('devicedock.catalog.' + source.kind + '.' + source.url,'corrupt'); assert.equal(store.cached(source),null); store.remove(source); assert.equal(store.list().length,1)
})
test('verified package graph, tamper rejection, API/platform compatibility, no execution on verify',async () => {
 const code = 'globalThis.__mustNotRun = true; export function activate() {}', encoded = new TextEncoder().encode(code)
 const bundle = {manifest:{...manifest,integrity:{'index.js':await digest(encoded)}},files:{'index.js':btoa(code)}}
 const result = await verifyPackage(bundle,'web'); assert.equal(result.files.size,1); assert.equal(globalThis.__mustNotRun,undefined)
 await assert.rejects(verifyPackage({...bundle,files:{'index.js':btoa(code+'x')}},'web'),/完整性/)
 await assert.rejects(verifyPackage({...bundle,manifest:{...bundle.manifest,apiVersion:2}}),/不兼容/)
 await assert.rejects(verifyPackage(bundle,'mobile'),/平台/)
 const external = 'import "https://example.org/code.js";'; await assert.rejects(verifyPackage({manifest:{...manifest,integrity:{'index.js':await digest(new TextEncoder().encode(external))}},files:{'index.js':btoa(external)}}),/相对/)
})
test('strict HEX and untrusted structured views rendered as text',() => {
 assert.deepEqual([...parseSend('68 01','hex')],[0x68,1]); assert.throws(() => parseSend('6x','hex'))
 const {document} = parseHTML('<main></main>'), view = renderView({title:'<script>bad</script>',fields:[{label:'<img>',value:'<svg onload=x>'}]},document)
 assert.equal(view.querySelector('script'),null); assert.equal(view.querySelector('img'),null); assert.match(view.textContent,/<script>/)
})
test('package relative imports cannot escape the actual hashed directory',async () => {
 const files = {'index.js':'import "../shared.js";','shared.js':'export const x = 1'}, integrity = {}, encoded = {}
 for (const [path,code] of Object.entries(files)) {integrity[path] = await digest(new TextEncoder().encode(code)); encoded[path] = btoa(code)}
 await assert.rejects(verifyPackage({manifest:{...manifest,integrity},files:encoded}),/逃逸/)
})
test('disable during asynchronous activation is refused, finalizer remains owned',async () => {
 const {host} = fixture(); let ready, cleaned = false
 const enable = host.enable(manifest,'async',true,async () => ({async activate() {await new Promise(resolve => {ready=resolve}); return () => {cleaned=true}}}))
 await tick(); await assert.rejects(host.disable(manifest.id),/启用中/); ready(); await enable; await host.disable(manifest.id); assert.equal(cleaned,true)
})
test('close emits generation changes and clears old claims only after hardware release',async () => {
 const session = new Session('A'), hw = hardware(), events = []; await session.open(hw.port,{baudRate:9600}); const release = session.claim('capture'), g = session.generation
 session.subscribe(row => events.push(row)); await session.close(); assert.equal(session.owner,null); assert.ok(events.some(r => r.generation > g && r.text === 'closed'))
 await session.open(hw.port,{baudRate:9600}); const fresh = session.claim('capture'); release(); assert.equal(session.owner,'capture'); fresh(); await session.close()
})
test('hung native write keeps physical ownership and update barrier after bounded close',async () => {
 const session = new Session('A'), other = new Session('B'), hw = hardware(); let finish
 hw.driver.write = () => new Promise(resolve => {finish=resolve}); await session.open(hw.port,{baudRate:9600}); const send = session.send(new Uint8Array([1])).catch(() => {})
 await tick(); await assert.rejects(session.close({timeoutMs:10}),/占用/); assert.equal(session.state,'cleanup-needed'); await assert.rejects(other.open(hw.port,{baudRate:9600}),/占用/)
 finish(); await send; await session.actualClose; assert.equal(session.state,'closed'); await other.open(hw.port,{baudRate:9600}); await other.close()
})
test('cleanup can issue final owner-scoped device writes, diagnostics stay out of RX/TX',async () => {
 const {host,sessions} = fixture(), hw = hardware(); await sessions.A.open(hw.port,{baudRate:9600})
 await host.enable(manifest,'a',true,async () => ({activate(h) {const session=h.session('A'); session.claim('ignored'); h.log('diagnostic'); return () => session.send(new Uint8Array([9]))}}))
 const before = sessions.A.logs.length; await host.disable(manifest.id); assert.deepEqual(hw.writes,[[9]]); assert.equal(host.diagnostics[0].text,'diagnostic'); assert.equal(sessions.A.logs.length,before+1); await sessions.A.close()
})
test('version switch failure reactivates previous version; source storage stays isolated',async () => {
 const {host} = fixture(); let old
 const importer = async () => ({activate(h) {old=h;h.storage.set('setting',42)}})
 await host.enable(manifest,'old',true,importer,'source-one')
 await assert.rejects(host.replace({...manifest,version:'2.0.0'},'new',true,async () => ({activate(){throw Error('migration failed')}}),'source-two'),/已恢复旧版本/)
 assert.equal(host.extensions.get(manifest.id).manifest.version,'1.0.0'); assert.equal(old.storage.get('setting'),42)
 await host.disable(manifest.id); let second
 await host.enable(manifest,'other-source',true,async () => ({activate(h){second=h}}),'source-two'); assert.equal(second.storage.get('setting'),null); await host.disable(manifest.id)
})
test('desktop installer sends exactly the canonical verified package to native immutable cache',async () => {
 const {Installer}=await import('../src/installer.js'),code='export function activate() {}',bundle={manifest:{...manifest,platforms:['desktop'],integrity:{'index.js':await digest(new TextEncoder().encode(code))}},files:{'index.js':btoa(code)}}
 let received
 const native={async invoke(command,args){assert.equal(command,'extension_install');received=args;return {hash:args.expectedHash,baseUrl:`devicedock-extension://localhost/${args.expectedHash}/`}}}
 const storage=memory(),installer=new Installer(storage,'desktop',native),result=await installer.install(bundle,'source')
 assert.equal((await digest(new TextEncoder().encode(received.bundleJson))).slice(7),received.expectedHash);assert.ok(result.url.endsWith('/index.js'));assert.equal(installer.list().length,1)
 const bad=structuredClone(bundle);bad.files['index.js']=btoa('tampered');await assert.rejects(installer.install(bad),/完整性/)
})
test('disposers cannot remove a contribution registered later by another extension',async () => {
 const {host}=fixture();let first,second
 await host.enable(manifest,'one',true,async()=>({activate(h){first=h.registerService('org.devicedock.shared.v1',{owner:1})}}));first()
 await host.enable({...manifest,id:'org.test.second'},'two',true,async()=>({activate(h){second=h.registerService('org.devicedock.shared.v1',{owner:2})}}))
 await host.disable(manifest.id);assert.equal(host.services.get('org.devicedock.shared.v1').owner,2);second();await host.disable('org.test.second')
})
test('active transport extension cannot be disabled while any owned host session uses its port',async () => {
 const {host,sessions}=fixture(),hw=hardware()
 await host.enable(manifest,'transport',true,async()=>({activate(h){h.registerTransport({id:'fixture',title:'fixture',requestPort:async()=>hw.port})}}))
 const port=await host.transports.get('fixture').requestPort();await sessions.A.open(port,{baudRate:9600});await assert.rejects(host.disable(manifest.id),/断开/);assert.equal(host.extensions.get(manifest.id).status,'enabled');await sessions.A.close();await host.disable(manifest.id)
})
test('asset reads verify bytes and native worker uses verified blob script with tracked cleanup',async () => {
 const {packageAssets}=await import('../src/assets.js'),code='self.onmessage=e=>self.postMessage(e.data)',wasm=new Uint8Array([0,97,115,109,1,0,0,0]),files={'worker.js':new TextEncoder().encode(code),'module.wasm':wasm,'index.js':new TextEncoder().encode('export const fixture=1')},integrity={}
 for(const [key,bytes] of Object.entries(files))integrity[key]=await digest(bytes)
 const id='a'.repeat(64),disposers=[],calls=[],native={invoke:async(command,args)=>{calls.push({command,args});return [...files[args.path]]}},workers=[]
 const assets=packageAssets({...manifest,integrity},`devicedock-extension://localhost/${id}/index.js`,{native,dispose:off=>disposers.push(off),WorkerClass:class{constructor(url){this.url=url;workers.push(this)}terminate(){this.closed=true}},URLClass:{createObjectURL:()=> 'blob:verified',revokeObjectURL:url=>calls.push({revoked:url})}})
 assert.deepEqual(await assets.read('module.wasm'),wasm);const worker=await assets.createWorker('worker.js');assert.equal(worker.url,'blob:verified');assert.equal(calls[0].command,'extension_read_asset');disposers[0]();assert.equal(workers[0].closed,true)
 await assert.rejects(assets.read('../outside'),/完整性/)
 files['worker.js']=new TextEncoder().encode('tampered');await assert.rejects(assets.createWorker('worker.js'),/摘要/)
})
test('update preflights all extensions before teardown and rejects new work while checking',async () => {
 const {host,sessions}=fixture(),hw=hardware();await sessions.A.open(hw.port,{baudRate:9600});let begin,finish,api
 await host.enable(manifest,'test',true,async()=>({activate(h){api=h;h.prepareDeactivate(async()=>{begin?.();await new Promise(resolve=>{finish=resolve});throw Error('busy')})}}))
 const ready=new Promise(resolve=>{begin=resolve}),prepare=host.prepareForUpdate();await ready;await assert.rejects(sessions.A.send(new Uint8Array([1])),/更新/);assert.throws(()=>api.session('A'),/更新/);finish();await assert.rejects(prepare,/busy/);assert.equal(host.extensions.get(manifest.id).status,'enabled');assert.equal(sessions.A.frozen,false)
 // Remove intentionally busy preflight for normal fixture cleanup.
 host.extensions.get(manifest.id).preflight=[];await host.disable(manifest.id);await sessions.A.close()
})
test('completed worker termination revokes URL and removes retained host disposer immediately',async () => {
 const {packageAssets}=await import('../src/assets.js'),code='self.onmessage=e=>self.postMessage(e.data)',bytes=new TextEncoder().encode(code),integrity={'worker.js':await digest(bytes),'index.js':manifest.integrity['index.js']},disposers=new Set(),revoked=[]
 let terminations=0
 const assets=packageAssets({...manifest,integrity},'https://app.test/pkg/index.js',{fetcher:async()=>new Response(bytes),dispose:off=>{disposers.add(off);return ()=>disposers.delete(off)},WorkerClass:class{terminate(){terminations++}},URLClass:{createObjectURL:()=> 'blob:job',revokeObjectURL:url=>revoked.push(url)}})
 for(let job=0;job<4;job++){const worker=await assets.createWorker('worker.js');assert.equal(disposers.size,1);worker.terminate();worker.terminate();assert.equal(disposers.size,0)}
 assert.equal(terminations,4);assert.equal(revoked.length,4)
})
test('actual ExtensionHost disables a long-lived Worker without skipping adjacent contributions, twice',async () => {
 const previousWorker=globalThis.Worker,previousFetch=globalThis.fetch;let terminated=0
 const bytes=new TextEncoder().encode('self.onmessage=()=>{}'),m={...manifest,integrity:{...manifest.integrity,'worker.js':await digest(bytes)}}
 globalThis.Worker=class{terminate(){terminated++}};globalThis.fetch=async()=>new Response(bytes)
 const {host,sessions}=fixture(),hw=hardware();await sessions.A.open(hw.port,{baudRate:9600})
 try{
  for(let cycle=0;cycle<2;cycle++){
   await host.enable(m,'https://app.test/package/index.js',true,async()=>({async activate(h){h.session('A').claim('worker');h.session('A').subscribe(()=>{});h.registerService('plugin.org.test.extension.hold',{});h.registerTransport({id:'worker-test',title:'worker',requestPort:async()=>hw.port});h.registerProtocol({id:'worker-test',title:'worker',create:()=>({feed:()=>[],reset(){}})});await h.assets.createWorker('worker.js')}}))
   await host.disable(m.id);assert.equal(host.services.size,0);assert.equal(host.transports.size,0);assert.equal(host.protocols.size,0);assert.equal(sessions.A.owner,null);assert.equal(sessions.A.listeners.size,0)
  }
  assert.equal(terminated,2)
 }finally{globalThis.Worker=previousWorker;globalThis.fetch=previousFetch;await sessions.A.close()}
})
