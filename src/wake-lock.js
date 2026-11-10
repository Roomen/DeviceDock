// Best-effort screen wake lock while a session is open; stale requests can never attach to a new connection.
export function keepScreenAwake({wakeLock=globalThis.navigator?.wakeLock,document=globalThis.document}={}){
 let active=true,sentinel,pending
 const request=()=>{if(!active||sentinel||pending||!wakeLock?.request||document?.visibilityState==='hidden')return;pending=Promise.resolve().then(()=>wakeLock.request('screen')).then(async lock=>{if(!active){await lock.release();return}sentinel=lock;lock.addEventListener?.('release',()=>{if(sentinel===lock)sentinel=null},{once:true})}).catch(()=>{}).finally(()=>{pending=null})}
 const foreground=()=>{if(document?.visibilityState!=='hidden')request()};document?.addEventListener('visibilitychange',foreground);request()
 return {dispose(){active=false;document?.removeEventListener('visibilitychange',foreground);const lock=sentinel;sentinel=null;Promise.resolve(lock?.release()).catch(()=>{})}}
}
