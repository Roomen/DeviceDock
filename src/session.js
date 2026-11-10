import {keepScreenAwake} from './wake-lock.js'
const ports = new WeakMap()
export class Session {
 constructor(lane, onLog = () => {}) {
  this.lane = lane; this.generation = 0; this.state = 'closed'; this.logs = []; this.listeners = new Set(); this.onLog = onLog; this.queue = Promise.resolve(); this.sequence = 0; this.transactions = new Set(); this.pending = new Set(); this.writes = new Set(); this.claimEpoch = 0; this.parser = null; this.protocol = null; this.logBytes = 0
 }
 get messageBoundary() { return this.port?.messageBoundary === 'datagram' ? 'datagram' : undefined }
 get connected() { return this.state === 'open' }
 get deviceInfo() { return this.port?.getInfo?.() || null }
 get busy() { return this.writes.size > 0 || this.state === 'opening' || this.state === 'closing' || this.state === 'cleanup-needed' || !!this.owner || this.transactions.size > 0 }
 async drainOwner(owner) {
  await Promise.allSettled([...this.pending, ...this.writes].filter(p => p.owner === owner))
 }
 subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
 emit(direction, bytes = new Uint8Array(), text) {
  const record = { sequence: ++this.sequence, lane: this.lane, generation: this.generation, time: Date.now(), direction, ...(this.port?.messageBoundary === 'datagram' ? {boundary:'datagram'} : {}), bytes: bytes.slice(), text }
  if (direction === 'rx' && this.parser) {
   try { record.frames = record.boundary === 'datagram' && this.parser.feedDatagram ? this.parser.feedDatagram(bytes.slice()) : this.parser.feed(bytes.slice()); record.views = record.frames.map(f => f.view).filter(Boolean) } catch (e) { record.text = `解析失败：${e.message}` }
  }
  this.logs.push(record); this.logBytes += record.bytes.length
  while (this.logs.length > (this.maxLogRows || 10000) || this.logBytes > 4 * 1024 * 1024) this.logBytes -= this.logs.shift().bytes.length
  for (const fn of [...this.listeners]) { try { fn({ ...record, bytes: record.bytes.slice() }) } catch {} }
  this.onLog(record); return record
 }
 setProtocol(definition) {
  const next = definition?.create({ lane: this.lane, mode: 'live', generation: this.generation }) || null
  this.parser?.dispose?.(); this.protocol = definition; this.parser = next
 }
 replay() {
  let parser, generation
  try { return this.logs.map(row => {
   if (generation !== row.generation) { parser?.dispose?.(); parser = this.protocol?.create({lane:this.lane,mode:'replay',generation:row.generation}); generation = row.generation }
   const frames = row.direction === 'rx' && parser ? (row.boundary === 'datagram' && parser.feedDatagram ? parser.feedDatagram(row.bytes.slice()) : parser.feed(row.bytes.slice())) : row.frames
   return { ...row, frames, views: frames ? frames.map(f => f.view).filter(Boolean) : row.views }
  }) } finally { parser?.dispose?.() }
 }

 async open(port, options) {
  if (this.frozen) throw Error('应用正在准备更新')
  if (this.state !== 'closed') throw Error('连接正在使用或等待清理')
  if (ports.has(port)) throw Error('此端口已被其他路占用')
  ports.set(port, this); this.port = port; this.state = 'opening'; ++this.generation
  try {
   await port.open(options)
   this.setProtocol(this.protocol); this.state = 'open';this.wake=keepScreenAwake(); this.emit('system', undefined, 'connected'); this.reader = null
   this.readTask = this.readLoop(this.generation)
  } catch (e) { this.state = 'closed'; this.port = null; ports.delete(port); throw e }
 }
 async readLoop(generation) {
  try {
   while (generation === this.generation && this.port?.readable) {
    const stream = this.port.readable
    const reader = this.reader || stream.getReader(); this.reader = reader
    let failed = false
    try {
     while (generation === this.generation) {
      const { done, value } = await reader.read()
      if (done) break
      if (generation === this.generation) this.emit('rx', value)
     }
    } catch (e) { failed = true; if (generation === this.generation) this.emit('system', undefined, `接收失败：${e.message}`) }
    finally { reader.releaseLock(); if (this.reader === reader) this.reader = null }
    if (generation !== this.generation || this.port?.readable === stream || (!failed && !this.port?.readable)) break
    // Recoverable Web Serial errors replace readable. Continue only with a new stream.
   }
  } finally {
   if (generation === this.generation && this.state === 'open') queueMicrotask(() => this.close().catch(e => this.emit('system', undefined, e.message)))
  }
 }

 claim(owner) {
  if (this.state !== 'open') throw Error('尚未连接或连接正在关闭')
  if (!owner || (this.owner && this.owner !== owner)) throw Error('连接被其他任务独占')
  const epoch = this.claimEpoch
  this.owner = owner; this.claims = (this.claims || 0) + 1; let active = true
  return () => { if (active) { active = false; if (this.claimEpoch === epoch && this.owner === owner && --this.claims === 0) this.owner = null } }
 }
 send(bytes, { owner, generation = this.generation, beforeWrite } = {}) {
  const data = bytes.slice()
  const work = this.queue.then(async () => {
   if (this.frozen && !owner) throw Error('应用正在准备更新')
   if (generation !== this.generation || this.state !== 'open') throw Error('连接已改变')
   if (this.owner && this.owner !== owner) throw Error('连接被任务独占')
   await beforeWrite?.()
   if (generation !== this.generation || this.state !== 'open' || (this.owner && this.owner !== owner)) throw Error('连接或所有权已改变')
   const writer = this.port.writable.getWriter(); this.writer = writer
   try { await writer.write(data); if (generation !== this.generation) throw Error('连接已改变'); this.emit('tx', data) }
   finally { writer.releaseLock(); if (this.writer === writer) this.writer = null }
  })
  work.owner = owner; this.writes.add(work); work.then(() => this.writes.delete(work), () => this.writes.delete(work))
  this.queue = work.catch(() => {}); return work
 }
 async transaction(owner, run, { timeoutMs = 10000, signal } = {}) {
  if (this.state !== 'open') throw Error('尚未连接')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('无效事务超时')
  if (signal?.aborted) throw Error('任务已取消')
  if (this.transactions.size) throw Error('已有事务正在执行')
  const release = this.claim(owner), controller = new AbortController(), generation = this.generation, subscriptions = []
  controller.owner = owner; this.transactions.add(controller)
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  let rejectAbort
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(Error('任务取消、超时或连接已改变')); controller.signal.addEventListener('abort', rejectAbort, { once: true }) })
  const operation = Promise.resolve().then(() => run({ signal: controller.signal,
    send: (bytes, options = {}) => { if (controller.signal.aborted) return Promise.reject(Error('任务已取消')); return this.send(bytes, { owner, generation, beforeWrite: options.beforeWrite }) },
    subscribe: fn => { const off = this.subscribe(row => { if (!controller.signal.aborted && row.generation === generation) fn(row) }); subscriptions.push(off); return off }
   }))
  const tracked = operation.catch(() => {}); tracked.owner = owner; this.pending.add(tracked)
  try { return await Promise.race([aborted, operation])
  } finally { controller.abort(); await operation.catch(() => {}); await Promise.allSettled([...this.writes].filter(p => p.owner === owner)); clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); controller.signal.removeEventListener('abort', rejectAbort); subscriptions.forEach(off => off()); this.transactions.delete(controller); this.pending.delete(tracked); release() }
 }
 async close({ timeoutMs = 5000 } = {}) {
  if (this.state === 'opening') throw Error('正在打开，请稍候')
  if (this.state === 'closing') return this.closeTask
  if (this.state === 'closed') return
  if (this.actualClose && this.state === 'cleanup-needed' && !this.closeFailed) return this.actualClose
  this.wake?.dispose();this.wake=null;this.closeFailed = false; this.state = 'closing'; ++this.generation; this.transactions.forEach(c => c.abort()); this.parser?.reset(); this.emit('system', undefined, 'closing')
  const actualClose = (async () => {
   try {
    await this.reader?.cancel(); await this.readTask; await Promise.all([...this.pending || []]); await this.queue; await this.port.close()
    ports.delete(this.port); this.port = null; this.owner = null; this.claims = 0; ++this.claimEpoch; this.state = 'closed'; this.emit('system', undefined, 'closed')
   } catch (e) { this.state = 'cleanup-needed'; this.closeFailed = true; throw e }
  })()
  // Abort requests may themselves wait on native I/O. Never release before actual close settles.
  this.writer?.abort(Error('connection closing')).catch(() => {})
  let timer
  this.closeTask = Promise.race([actualClose, new Promise((_,reject) => { timer = setTimeout(() => { if (this.state !== 'closed') this.state = 'cleanup-needed'; reject(Error('设备操作仍未完成，保留资源占用')) },timeoutMs) })]).finally(() => clearTimeout(timer))
  this.actualClose = actualClose
  return this.closeTask
 }
 async setSignals(signals,{beforeWrite,owner}={}){
  if((this.frozen&&!owner)||this.state!=='open'||(!owner&&this.busy)||(this.owner&&this.owner!==owner))throw Error('连接忙碌或未打开')
  if(!signals||typeof signals!=='object'||Array.isArray(signals)||!Object.keys(signals).length||Object.entries(signals).some(([k,v])=>!['dataTerminalReady','requestToSend','break'].includes(k)||typeof v!=='boolean'))throw Error('无效串口信号')
  if(!this.port.setSignals)throw Error('当前传输不支持串口信号')
  const signalOwner=owner||'host:signals',release=this.claim(signalOwner),generation=this.generation
  const check=()=>{if(this.generation!==generation||this.state!=='open'||this.owner!==signalOwner)throw Error('连接或所有权已改变')}
  const work=this.queue.then(async()=>{check();await beforeWrite?.();check();return this.port.setSignals(signals)});work.owner=signalOwner;this.writes.add(work);this.queue=work.catch(()=>{})
  try{return await work}finally{this.writes.delete(work);release()}
 }

 clear() { this.logs = []; this.logBytes = 0 }
}
