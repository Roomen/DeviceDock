export function renderView(model, document, depth = 0) {
 const box = document.createElement('div'); box.className = 'parse-view'
 if (!model || depth > 10) return box
 if (model.title) { const title = document.createElement('strong'); title.textContent = String(model.title); box.append(title) }
 if (model.text) { const text = document.createElement('span'); text.textContent = String(model.text); box.append(text) }
 for (const field of (model.fields || []).slice(0,200)) { const row = document.createElement('span'); row.textContent = `${field.label}: ${field.value}`; box.append(row) }
 for (const child of (model.children || []).slice(0,50)) box.append(renderView(child,document,depth + 1))
 return box
}
export function parseSend(input, format, crlf) {
 if (format === 'hex') {
  const clean = input.replace(/\s/g,'')
  if (!clean || clean.length % 2 || !/^[a-f0-9]+$/i.test(clean)) throw Error('HEX 需要完整的两位十六进制字节')
  return Uint8Array.from(clean.match(/../g),h => parseInt(h,16))
 }
 return new TextEncoder().encode(input + (crlf ? '\r\n' : ''))
}
