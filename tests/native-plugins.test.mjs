import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import {parseHTML} from 'linkedom'
import {mountNativePlugins} from '../src/shell/native-plugins.js'
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const dom=()=>{const {document,window}=parseHTML('<main><div id="panel"></div><div id="pages"></div></main>');return {document,window,panel:document.querySelector('#panel'),pagesContainer:document.querySelector('#pages')}}
test('browser explicitly reports unavailable without native invokes',async()=>{
 const f=dom(),api=await mountNativePlugins({...f,platform:{},registerPage(){throw Error('unexpected page')}})
 assert.match(f.panel.textContent,/仅支持桌面版/);await api.refresh();await api.dispose()
})
test('native adapter registers once, keeps unchanged DOM, validates bridge source/method, removes stopped pages',async()=>{
 const f=dom(),calls=[],pages=[],replies=[];let onState,unlistened=0,removed=0
 const record={hash:'a'.repeat(64),manifest:{name:'Synthetic plugin',version:'1',target:'synthetic',methods:['echo']},running:false,trusted:true,error:null}
 const invoke=async(command,args)=>{calls.push([command,args]);if(command==='native_plugin_list')return structuredClone([record]);if(command==='native_plugin_page')return 'devicedock-native://localhost/synthetic/page';if(command==='native_plugin_call')return {echo:args.params};if(command==='native_plugin_release_owned'||command==='native_plugin_stop'||command==='native_plugin_revoke'){record.running=false;if(command==='native_plugin_revoke')record.trusted=false}}
 const api=await mountNativePlugins({...f,platform:{native:{invoke}},events:{async listen(name,fn){assert.equal(name,'native-plugin-state');onState=fn;return()=>unlistened++}},registerPage(page){pages.push(page);return()=>removed++}})
 assert.equal(calls.filter(([c])=>c==='native_plugin_list').length,1)
 const button=f.panel.querySelector('button');await api.refresh();assert.equal(f.panel.querySelector('button'),button,'unchanged refresh replaced management DOM')
 const before=calls.length;await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls.length,before,'adapter polled native state')
 record.running=true;await api.refresh();assert.equal(pages.length,1)
 const iframe=f.pagesContainer.querySelector('iframe');assert.equal(iframe.getAttribute('sandbox'),'allow-scripts')
 const source={postMessage:payload=>replies.push(payload)};Object.defineProperty(iframe,'contentWindow',{value:source})
 const send=(source,data)=>{const event=new f.window.Event('message');Object.assign(event,{source,data});f.window.dispatchEvent(event)}
 send({}, {type:'devicedock-native-call',id:1,method:'echo',params:1});await tick();assert.equal(replies.length,0)
 send(source,{type:'devicedock-native-call',id:2,method:'host.serial.open',params:{}});await tick();assert.match(replies.at(-1).error,/unavailable/);assert.equal(calls.filter(([c])=>c==='native_plugin_call').length,0)
 send(source,{type:'devicedock-native-call',id:3,method:'echo',params:'x'.repeat(65000)});await tick();assert.match(replies.at(-1).error,/Invalid/)
 send(source,{type:'devicedock-native-call',id:4,method:'echo',params:{value:7}});await tick();assert.deepEqual(replies.at(-1).result,{echo:{value:7}})
 await api.refresh();assert.equal(pages.length,1,'switch/refresh duplicated native page')
 record.running=false;record.error='Native process exited unexpectedly';onState();await api.refresh();assert.equal(f.pagesContainer.children.length,0);assert.equal(removed,1);assert.match(f.panel.textContent,/exited unexpectedly/)
 const count=calls.length;send(source,{type:'devicedock-native-call',id:5,method:'echo',params:0});await tick();assert.equal(calls.length,count,'removed iframe retained RPC bridge')
 await api.dispose();assert.equal(unlistened,1);assert.equal(calls.at(-1)[0],'native_plugin_release_owned')
})
test('bridge script correlates replies only from parent and bounds pending requests',async()=>{
 const sent=[],listeners={},timers=new Map();let nextTimer=0
 const parent={postMessage:payload=>sent.push(payload)},window={}
 const context={window,parent,Promise,Error,Map,setTimeout:fn=>{timers.set(++nextTimer,fn);return nextTimer},clearTimeout:id=>timers.delete(id),addEventListener:(name,fn)=>listeners[name]=fn}
 vm.runInNewContext(await readFile(new URL('../src/shell/native-plugin-bridge.js',import.meta.url),'utf8'),context)
 const p=window.deviceDockNative.call('echo',{value:1});const first=sent[0]
 listeners.message({source:{},data:{type:'devicedock-native-reply',id:first.id,result:99}});assert.equal(timers.size,1)
 listeners.message({source:parent,data:{type:'devicedock-native-reply',id:first.id,result:7}});assert.equal(await p,7);assert.equal(timers.size,0)
 const pending=Array.from({length:8},()=>window.deviceDockNative.call('echo',0));await assert.rejects(window.deviceDockNative.call('echo',0),/limit/)
 for(const data of sent.slice(1))listeners.message({source:parent,data:{type:'devicedock-native-reply',id:data.id,result:1}})
 assert.deepEqual(await Promise.all(pending),Array(8).fill(1));assert.equal(timers.size,0)
 const timeout=window.deviceDockNative.call('echo');[...timers.values()][0]();await assert.rejects(timeout,/timed out/)
})
