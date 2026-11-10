// Independent raw cursor history: UI clear/filter/replay never changes MCP's ring.
export class McpRing {
 constructor(session,document,{maxRows=3000,maxBytes=4*1024*1024}={}) {
  Object.assign(this,{session,document,maxRows,maxBytes});this.rows=[];this.bytes=0;this.generation=session.generation;this.evicted=0
  this.off=session.subscribe(row => {this.sync(); const copy={sequence:row.sequence,generation:row.generation,time:row.time,direction:row.direction,bytes:Array.from(row.bytes),...(row.boundary?{boundary:row.boundary}:{}),...(row.text?{text:row.text}:{})};this.rows.push(copy);this.bytes+=row.bytes.length;while(this.rows.length>maxRows || this.bytes>maxBytes){const old=this.rows.shift();this.bytes-=old.bytes.length;this.evicted=old.sequence}})
 }
 sync(){if(this.generation!==this.session.generation){this.generation=this.session.generation;this.rows=[];this.bytes=0;this.evicted=0}}
 read(cursor,limit=100){
  this.sync()
  if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('Invalid limit')
  if(cursor && (cursor.document!==this.document || cursor.lane!==this.session.lane || cursor.generation!==this.generation || !Number.isSafeInteger(cursor.sequence) || cursor.sequence<0 || cursor.sequence>this.session.sequence))throw Error('Stale or invalid cursor; inspect lane state and start a new cursor')
  const sequence=cursor?.sequence??0, rows=this.rows.filter(r=>r.sequence>sequence).slice(0,limit)
  return {truncated:sequence<this.evicted,cursor:{document:this.document,lane:this.session.lane,generation:this.generation,sequence:rows.at(-1)?.sequence??this.session.sequence},rows}
 }
 dispose(){this.off()}
}
