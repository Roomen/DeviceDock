// Public compiler metadata only. Never include signing variables in cache keys.
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {appendFileSync} from 'node:fs'
const metadata=['rustc','cargo'].map(tool=>{const result=spawnSync(tool,[tool==='rustc'?'-Vv':'-V'],{encoding:'utf8'});if(result.status!==0)throw Error(`Cannot inspect ${tool}`);return result.stdout.trim()}).join('\n')
const rust=createHash('sha256').update(metadata).digest('hex').slice(0,20)
if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`rust=${rust}\n`)
console.log(`Public Rust/Cargo cache fingerprint: ${rust}`)
