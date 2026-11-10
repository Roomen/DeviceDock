export const safePath = value => typeof value === 'string' && value.length < 240 && !['__bundle.json','__complete'].includes(value) && value.split('/').every(p => /^[a-zA-Z0-9_@.-]+$/.test(p) && p !== '.' && p !== '..') && !value.startsWith('/')
export function validateManifest(m, platform) {
 if (!m || m.schemaVersion !== 1 || !/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(m.id) || !/^\d+\.\d+\.\d+$/.test(m.version) || m.apiVersion !== 1 || !['protocol','plugin','transport','firmware'].includes(m.kind) || !safePath(m.entry) || !m.entry.endsWith('.js') || !Array.isArray(m.platforms) || !m.platforms.length || m.platforms.some(p => !['web','desktop','mobile'].includes(p)) || !Array.isArray(m.capabilities) || m.capabilities.some(c => typeof c !== 'string') || typeof m.license !== 'string' || !m.integrity || typeof m.integrity !== 'object') throw Error('不兼容或无效的扩展清单')
 if (platform && !m.platforms.includes(platform)) throw Error('扩展不支持当前平台')
 if (!Object.hasOwn(m.integrity, m.entry) || Object.keys(m.integrity).some(p => !safePath(p) || !/^sha256-[a-f0-9]{64}$/.test(m.integrity[p]))) throw Error('包完整性声明无效')
 return m
}
export async function digest(bytes) { return 'sha256-' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2,'0')).join('') }
