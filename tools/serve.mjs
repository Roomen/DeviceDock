import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
const root = process.env.SERVE_DIST ? resolve(process.env.SERVE_DIST) : resolve(import.meta.dirname,'..'), port = Number(process.env.PORT || 8080)
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml'}
createServer(async (req,res) => {
 try {
  const u = new URL(req.url,'http://localhost'), path = resolve(root,'.' + decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname))
  if (!path.startsWith(root + sep) || path.split(sep).some(p => p.startsWith('.')) || path.includes('/node_modules/')) throw Error('denied')
  if (!(await stat(path)).isFile()) throw Error('not file')
  res.setHeader('Content-Type',mime[extname(path)] || 'application/octet-stream'); res.setHeader('X-Content-Type-Options','nosniff'); res.end(await readFile(path))
 } catch { res.writeHead(404); res.end('Not found') }
}).listen(port,'127.0.0.1',() => console.log(`DeviceDock: http://localhost:${port}`))
