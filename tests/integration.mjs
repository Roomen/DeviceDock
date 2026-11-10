import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve,join } from 'node:path'
import { ExtensionHost } from '../src/extensions.js'
import { Session } from '../src/session.js'
import { verifyPackage } from '../src/package.js'
import { pack } from '../tools/integrate.mjs'
const root=resolve(import.meta.dirname,'..'), index=JSON.parse(await readFile(join(root,'extensions/installed.json')))
if(index.length!==12)throw Error('Integrate frozen 8 protocol + 4 plugin packages first')
const sek=index.find(e=>e.manifest.id==='org.devicedock.sek')
const { PCP, PCPMessageCode: codes } = await import(pathToFileURL(join(root,'extensions',sek.hash,'modules/packages/sek/pcp.js')))
class Element extends EventTarget {
 constructor(doc) { super(); this.ownerDocument = doc; this.children = []; this.files = []; this.value = '' }
 append(el) { this.children.push(el); el.parent = this }
 remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this) }
 setAttribute() {} replaceChildren() { this.children = [] } getContext() { return null }
}
const doc = { createElement: () => new Element(doc) }, memory = new Map()
const storage = { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) }
const host = new ExtensionHost({ sessions: { A: new Session('A'), B: new Session('B') }, mount: doc.createElement(), storage })
for (const entry of index) {
 const directory=join(root,'extensions',entry.hash), bundle=await pack(directory)
 const checked=await verifyPackage(bundle,'web');assert.equal(checked.hash,entry.hash)
 await host.enable(bundle.manifest,pathToFileURL(join(directory,bundle.manifest.entry)).href,true,undefined,entry.source)
}
assert.equal(host.protocols.size,8)
function port(write = () => {}) {
 let rx
 return { readable: null, writable: null, async open() { this.readable = new ReadableStream({ start(c) { rx = c } }); this.writable = new WritableStream({ write }) }, push(bytes) { rx.enqueue(bytes) }, async close() {} }
}
// Actual host Session close records release power capture only after physical drain.
const power = host.services.get('org.devicedock.power.v1'), instrument = port()
await power.connect(instrument); await power.start('instrument')
await host.resources.get('org.devicedock.power.instrument').close()
assert.equal(power.status().sampling, false)
await power.stop('instrument'); await power.connect(port()); await power.disconnect()
await host.disable('org.devicedock.power')
// Actual SEK parser/builders + actual host transaction, zero hardware.
assert.equal(host.services.get('org.devicedock.sek.firmware.v1').apiVersion,1)
const firmware = host.services.get('org.devicedock.firmware.v1'), sent = []
const serial = port(bytes => {
 if(bytes[0] !== 255 || bytes[1] !== 254) return
 const decoded = PCP.parseMessage(bytes); assert.equal(decoded.checksumValid, true); sent.push(decoded)
 if (decoded.messageCode === codes.QUERY_VERSION) serial.push(PCP.buildMessage(codes.QUERY_VERSION, [0, ...PCP.versionToBytes('V0')]))
 if (decoded.messageCode === codes.NEW_VERSION_NOTIFY) {
  const chunks = [PCP.buildMessage(codes.NEW_VERSION_NOTIFY, [0]), PCP.buildMessage(codes.DOWNLOAD_REQUEST, [...PCP.versionToBytes('V1.2.3'), 0, 32]), PCP.buildMessage(codes.DOWNLOAD_RESULT, [0])]
  const all = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0)); let off = 0; for (const b of chunks) { all.set(b, off); off += b.length }; serial.push(all)
 }
})
await host.sessions.A.open(serial, { baudRate: 115200 })
const command=host.services.get('plugin.org.devicedock.cjt188.commands'); await command.send('A',{id:'read',values:{addr:'AAAAAAAAAAAAAA'}})
const raw = new Uint8Array(0x4020); raw.set(new TextEncoder().encode('V1.2.3'), 0x4004)
const packageBytes = await firmware.package('origin', raw)
const result = await firmware.upgrade('A', packageBytes, { chunkSize: 512, replyDelayMs: 0 })
assert.equal(result.executed, true); assert.equal(result.verified, false)
const response = sent.find(m => m.messageCode === codes.DOWNLOAD_REQUEST); assert.equal(response.data.length, 515); assert.equal(response.data.at(-1), 255)
const cancellation = firmware.upgrade('A', packageBytes, { chunkSize: 512, replyDelayMs: 0 })
const expectedCancellation = assert.rejects(cancellation, /cancel|取消/)
await new Promise(resolve => setTimeout(resolve, 10)); firmware.cancel(); await expectedCancellation
assert.equal(host.sessions.A.busy, false)
await host.sessions.A.close(); await host.disable('org.devicedock.firmware')
// USB bridge service uses the original NDJSON ping/scan protocol over owned host session.
const bridge = host.services.get('org.devicedock.bridge.v1')
const usb = port(bytes => {
 const command = JSON.parse(new TextDecoder().decode(bytes))
 const reply = {t:'rsp',id:command.id,ok:true}
 usb.push(new TextEncoder().encode(JSON.stringify(reply) + '\n'))
 if (command.op === 'ping') usb.push(new TextEncoder().encode('{"t":"evt","e":"ready"}\n'))
 if (command.op === 'scan.start') usb.push(new TextEncoder().encode('{"t":"evt","e":"scan","state":"scanning"}\n'))
})
const bridgeId = bridge.selectPort(usb); await bridge.controller.run('open', { deviceId: bridgeId })
await bridge.controller.run('scan_start'); assert.equal(bridge.controller.state().scanning, true)
await assert.rejects(host.disable('org.devicedock.bridge'), /Stop scanning/)
await bridge.controller.run('scan_stop'); await bridge.controller.run('close')
await host.disable('org.devicedock.bridge'); await host.disable('org.devicedock.wireless')
for(const id of [...host.extensions.keys()])await host.disable(id)
assert.equal(host.extensions.size, 0); assert.equal(host.resources.size, 0); assert.equal(host.mount.children.length, 0)
console.log('PASS: actual host verifies all twelve frozen packaged bundles; real host close recovers power; real SEK PCP transfer/cancellation ownership and full lifecycle use exact SDK')
