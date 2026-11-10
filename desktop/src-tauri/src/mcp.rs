//! Explicit local bearer-auth MCP. Window registrations and execution fences are document-scoped.
use std::{collections::HashMap, sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
use axum::{extract::{State as HttpState,DefaultBodyLimit},http::{HeaderMap,StatusCode},response::{IntoResponse,Response},routing::post,Json,Router};
use serde_json::{json,Value};
use tauri::{ipc::Channel,State,Webview,Emitter};
use tokio::sync::oneshot;
#[derive(Default)]
pub struct McpState(Arc<Mutex<Inner>>);
#[derive(Default)]
struct Inner {running:Option<Running>,clients:Arc<Mutex<HashMap<String,Arc<Client>>>>}
struct Client {epoch:String,channel:Channel<Value>,tools:Value}
struct Running {shared:Arc<Bridge>,shutdown:Option<oneshot::Sender<()>>,port:u16}
struct Pending {deadline:Instant,committed:Arc<AtomicBool>,reply:oneshot::Sender<Value>,label:String,client:Arc<Client>}
struct Bridge {token:Mutex<String>,port:u16,clients:Arc<Mutex<HashMap<String,Arc<Client>>>>,pending:Mutex<HashMap<String,Pending>>,stopped:AtomicBool,frozen:AtomicBool}
fn random()->Result<String,String>{let s=crate::mcp_settings::new_token();if s.is_empty(){Err("Secure randomness unavailable".into())}else{Ok(s)}}
fn error(id:Value,code:i32,message:&str)->Value{json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})}
fn failure(code:&str,committed:bool)->Value{let executed=if committed{json!("unknown")}else{json!(false)};json!({"isError":true,"structuredContent":{"code":code,"executed":executed},"content":[{"type":"text","text":if committed{"Outcome unknown after execution commit; inspect state before retry"}else{"Request not executed"}}]})}
fn authorized(h:&HeaderMap,b:&Bridge)->bool{
 let expected=format!("Bearer {}",b.token.lock().unwrap());let supplied=h.get("authorization").map(|v|v.as_bytes()).unwrap_or_default();
 let equal=supplied.len()==expected.len()&&supplied.iter().zip(expected.as_bytes()).fold(0u8,|a,(x,y)|a|(x^y))==0;
 equal&&!h.contains_key("origin")&&h.get("host").and_then(|v|v.to_str().ok()).is_some_and(|h|h==format!("127.0.0.1:{}",b.port)||h==format!("localhost:{}",b.port))
}
fn timeout(tool:&Value)->Duration{Duration::from_millis(tool["timeoutMs"].as_u64().unwrap_or(30000))}
const MAX_TOOLS:usize=512;
fn valid_catalog(tools:&Value)->bool{tools.to_string().len()<=4*1024*1024&&tools.as_array().is_some_and(|a|a.len()<=MAX_TOOLS&&a.iter().all(|t|t["name"].as_str().is_some_and(|n|!n.is_empty()&&n.len()<=128)&&t["inputSchema"]["type"]=="object"&&(t.get("timeoutMs").is_none()||t["timeoutMs"].as_u64().is_some_and(|n|(1000..=1800000).contains(&n)))))}
fn public_tools(client:&Client)->Value{Value::Array(client.tools.as_array().unwrap().iter().map(|t|{let mut t=t.clone();t.as_object_mut().unwrap().remove("timeoutMs");let props=t["inputSchema"]["properties"].as_object_mut();if let Some(p)=props{p.insert("window".into(),json!({"type":"string","description":"Explicit window id from windows_list"}));}t}).chain(std::iter::once(json!({"name":"windows_list","description":"List registered application windows; select window explicitly for multiple windows","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}))).collect())}
async fn http(HttpState(b):HttpState<Arc<Bridge>>,h:HeaderMap,body:axum::body::Bytes)->Response{
 if !authorized(&h,&b){return StatusCode::UNAUTHORIZED.into_response()}
 if b.stopped.load(Ordering::SeqCst){return StatusCode::SERVICE_UNAVAILABLE.into_response()}
 if !h.get("content-type").and_then(|v|v.to_str().ok()).is_some_and(|v|v.split(';').next()==Some("application/json")){return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response()}
 let req:Value=match serde_json::from_slice(&body){Ok(v)=>v,Err(_)=>return Json(error(Value::Null,-32700,"Parse error")).into_response()};let id=req.get("id").cloned().unwrap_or(Value::Null);
 if req["jsonrpc"]!="2.0"||!req.is_object()||!(id.is_null()||id.is_string()||id.is_number()){return Json(error(id,-32600,"Invalid request")).into_response()}
 let method=req["method"].as_str().unwrap_or("");if req.get("id").is_none(){return if method.starts_with("notifications/"){StatusCode::ACCEPTED.into_response()}else{Json(error(Value::Null,-32600,"Missing id")).into_response()}}
 let result=match method{
 "initialize"=>json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"DeviceDock","version":env!("CARGO_PKG_VERSION")}}),
 "ping"=>json!({}),
 "tools/list"|"tools/call"=>{
  let name=req["params"]["name"].as_str().unwrap_or("");
  if method=="tools/call"&&name=="windows_list"{let windows:Vec<_>=b.clients.lock().unwrap().keys().cloned().collect();let data=json!({"windows":windows});json!({"content":[{"type":"text","text":data.to_string()}],"structuredContent":data})}else{
   let mut args=req["params"].get("arguments").cloned().unwrap_or(json!({}));if !args.is_object(){return Json(error(id,-32602,"Invalid arguments")).into_response()}
   let window=args.as_object_mut().unwrap().remove("window").or_else(||req["params"].get("window").cloned());
   let target={let clients=b.clients.lock().unwrap();match window{Some(Value::String(label))=>clients.get(&label).map(|c|(label,c.clone())),None if clients.len()==1=>clients.iter().next().map(|(l,c)|(l.clone(),c.clone())),_=>None}};
   let Some((label,client))=target else{return Json(error(id,-32602,"Select explicit registered window via windows_list")).into_response()};
   if method=="tools/list"{json!({"tools":public_tools(&client)})}else{
    let Some(tool)=client.tools.as_array().unwrap().iter().find(|t|t["name"]==name)else{return Json(error(id,-32602,"Unknown tool")).into_response()};
    let duration=timeout(tool);let key=match random(){Ok(k)=>k,Err(_)=>return StatusCode::INTERNAL_SERVER_ERROR.into_response()};let(tx,rx)=oneshot::channel();let committed=Arc::new(AtomicBool::new(false));
    {let mut pending=b.pending.lock().unwrap();if b.frozen.load(Ordering::SeqCst){return Json(json!({"jsonrpc":"2.0","id":id,"result":failure("update_preparing",false)})).into_response()}if b.stopped.load(Ordering::SeqCst)||pending.len()>=32{return StatusCode::SERVICE_UNAVAILABLE.into_response()}if !b.clients.lock().unwrap().get(&label).is_some_and(|current|current.epoch==client.epoch){return Json(json!({"jsonrpc":"2.0","id":id,"result":failure("document_replaced",false)})).into_response()}pending.insert(key.clone(),Pending{deadline:Instant::now()+duration,committed:committed.clone(),reply:tx,label,client:client.clone()});}
    if client.channel.send(json!({"id":key,"name":name,"arguments":args})).is_err(){b.pending.lock().unwrap().remove(&key);failure("window_unavailable",false)}else{
     match tokio::time::timeout(duration,rx).await{Ok(Ok(result))=>result,_=>{b.pending.lock().unwrap().remove(&key);let _=client.channel.send(json!({"id":key,"cancel":true}));failure("timeout",committed.load(Ordering::SeqCst))}}
    }
   }
  }
 },_=>return Json(error(id,-32601,"Method not found")).into_response()};Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response()
}
fn router(shared:Arc<Bridge>)->Router{Router::new().route("/mcp",post(http)).layer(DefaultBodyLimit::max(64*1024)).with_state(shared)}
fn drain_locked(pending:&mut HashMap<String,Pending>,label:Option<&str>,code:&str){let ids:Vec<_>=pending.iter().filter(|(_,p)|label.is_none_or(|l|l==p.label)).map(|(k,_)|k.clone()).collect();for id in ids{let p=pending.remove(&id).unwrap();let _=p.client.channel.send(json!({"id":id,"cancel":true}));let _=p.reply.send(failure(code,p.committed.load(Ordering::SeqCst)));}}
fn drain(b:&Bridge,label:Option<&str>,code:&str){drain_locked(&mut b.pending.lock().unwrap(),label,code)}
fn register_client(inner:&Inner,label:&str,client:Arc<Client>){
 if let Some(r)=&inner.running{
  // Same-document catalog replacement must preserve calls already running on their original channel.
  // Serialize document replacement with HTTP insertion and commit so an old-epoch request cannot slip past drain.
  let mut pending=r.shared.pending.lock().unwrap();let previous=inner.clients.lock().unwrap().insert(label.into(),client.clone());
  if previous.is_some_and(|old|old.epoch!=client.epoch){drain_locked(&mut pending,Some(label),"document_replaced")}
 }else{inner.clients.lock().unwrap().insert(label.into(),client);}
}
#[tauri::command]
pub fn mcp_register(webview:Webview,state:State<'_,McpState>,epoch:String,tools:Value,channel:Channel<Value>)->Result<Value,String>{
 if !valid_catalog(&tools){return Err("Invalid tool catalog".into())}let inner=state.0.lock().unwrap();register_client(&inner,webview.label(),Arc::new(Client{epoch,tools,channel}));Ok(json!({"window":webview.label(),"running":inner.running.is_some(),"port":inner.running.as_ref().map(|r|r.port)}))
}
#[tauri::command]
pub async fn mcp_start(app:tauri::AppHandle,state:State<'_,McpState>,port:u16)->Result<Value,String>{
 if state.0.lock().unwrap().running.is_some(){return Err("Stop current MCP service first".into())}let mut settings=crate::mcp_settings::load(&app);if !crate::mcp_settings::valid_token(&settings.token){settings.token=random()?;}settings.port=if port==0{crate::mcp_settings::DEFAULT_PORT}else{port};if !crate::mcp_settings::valid_port(settings.port){return Err("Port must be 1024 or greater".into())}crate::mcp_settings::save(&app,&settings)?;
 let listener=tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST,settings.port)).await.map_err(|_|"MCP port unavailable".to_string())?;let actual=settings.port;let(tx,rx)=oneshot::channel();let mut inner=state.0.lock().unwrap();if inner.running.is_some(){return Err("Stop current MCP service first".into())}
 let shared=Arc::new(Bridge{token:Mutex::new(settings.token.clone()),port:actual,clients:inner.clients.clone(),pending:Mutex::default(),stopped:AtomicBool::new(false),frozen:AtomicBool::new(crate::updater::frozen(&app))});inner.running=Some(Running{shared:shared.clone(),shutdown:Some(tx),port:actual});tauri::async_runtime::spawn(async move{let _=axum::serve(listener,router(shared)).with_graceful_shutdown(async{let _=rx.await;}).await;});let _=app.emit("mcp-state",json!({"running":true,"port":actual}));Ok(json!({"port":actual,"token":settings.token}))
}
fn bridge(state:&McpState)->Result<Arc<Bridge>,String>{state.0.lock().unwrap().running.as_ref().map(|r|r.shared.clone()).ok_or("MCP is stopped".into())}
fn commit(b:&Bridge,label:&str,id:&str,epoch:&str)->bool{let mut pending=b.pending.lock().unwrap();if b.stopped.load(Ordering::SeqCst)||b.frozen.load(Ordering::SeqCst){return false}let Some(p)=pending.get_mut(id)else{return false};if p.label!=label||p.client.epoch!=epoch||p.deadline<=Instant::now(){return false}p.committed.store(true,Ordering::SeqCst);true}
#[tauri::command]
pub fn mcp_commit(webview:Webview,state:State<'_,McpState>,id:String,epoch:String)->bool{bridge(&state).is_ok_and(|b|commit(&b,webview.label(),&id,&epoch))}
#[tauri::command]
pub fn mcp_reply(webview:Webview,state:State<'_,McpState>,id:String,epoch:String,result:Value)->Result<(),String>{let b=bridge(&state)?;reply(&b,webview.label(),&id,&epoch,result)}
fn reply(b:&Bridge,label:&str,id:&str,epoch:&str,result:Value)->Result<(),String>{if result.to_string().len()>4*1024*1024{return Err("Tool result too large".into())}let mut pending=b.pending.lock().unwrap();if pending.get(id).is_some_and(|p|p.label==label&&p.client.epoch==epoch){let p=pending.remove(id).unwrap();let _=p.reply.send(result);}Ok(())}
#[tauri::command]
pub fn mcp_stop(app:tauri::AppHandle,state:State<'_,McpState>){let mut inner=state.0.lock().unwrap();if let Some(mut r)=inner.running.take(){r.shared.stopped.store(true,Ordering::SeqCst);drain(&r.shared,None,"service_stopped");if let Some(tx)=r.shutdown.take(){let _=tx.send(());}}let _=app.emit("mcp-state",json!({"running":false}));}
#[tauri::command]
pub fn mcp_regenerate_token(app:tauri::AppHandle,state:State<'_,McpState>)->Result<String,String>{let mut settings=crate::mcp_settings::load(&app);settings.token=random()?;crate::mcp_settings::save(&app,&settings)?;if let Ok(b)=bridge(&state){*b.token.lock().unwrap()=settings.token.clone();drain(&b,None,"token_rotated")}Ok(settings.token)}
pub fn release(state:&McpState,label:&str){let inner=state.0.lock().unwrap();inner.clients.lock().unwrap().remove(label);if let Some(r)=&inner.running{drain(&r.shared,Some(label),"window_closed")}}
pub fn quiesce(state:&McpState){if let Ok(b)=bridge(state){b.frozen.store(true,Ordering::SeqCst);drain(&b,None,"update_preparing")}}
pub fn resume(state:&McpState){if let Ok(b)=bridge(state){b.frozen.store(false,Ordering::SeqCst)}}

#[tauri::command]
pub fn mcp_reveal_token(app:tauri::AppHandle)->String{crate::mcp_settings::load(&app).token}
#[cfg(test)]
mod tests {
 use super::*;
 fn fixture()->Arc<Bridge>{Arc::new(Bridge{token:Mutex::new("fixture-token".into()),port:1234,clients:Arc::default(),pending:Mutex::default(),stopped:AtomicBool::new(false),frozen:AtomicBool::new(false)})}
 fn client()->Arc<Client>{Arc::new(Client{epoch:"new".into(),channel:Channel::new(|_|Ok(())),tools:json!([])})}
 #[test]fn complete_188_tool_catalog_fits_and_excess_catalog_rejects(){let tools=Value::Array((0..188).map(|n|json!({"name":format!("fixture.tool{n}"),"inputSchema":{"type":"object","properties":{}},"timeoutMs":30000})).collect());assert!(valid_catalog(&tools));let excessive=Value::Array((0..513).map(|n|json!({"name":format!("fixture.tool{n}"),"inputSchema":{"type":"object"}})).collect());assert!(!valid_catalog(&excessive));}
 #[test]fn schema_deadlines_are_bounded(){for n in [0,999,1800001]{assert!(!valid_catalog(&json!([{"name":"test","inputSchema":{"type":"object"},"timeoutMs":n}])))}for n in [1000,1200000,1800000]{let t=json!({"name":"test","inputSchema":{"type":"object"},"timeoutMs":n});assert!(valid_catalog(&json!([t])));assert_eq!(timeout(&t).as_millis(),n as u128)}}
 #[test]fn fences_reject_expired_wrong_window_old_document_and_frozen(){let b=fixture();let(tx,_rx)=oneshot::channel();b.pending.lock().unwrap().insert("id".into(),Pending{deadline:Instant::now()+Duration::from_secs(1),committed:Arc::new(AtomicBool::new(false)),reply:tx,label:"main".into(),client:client()});assert!(!commit(&b,"other","id","new"));assert!(!commit(&b,"main","id","old"));assert!(commit(&b,"main","id","new"));b.frozen.store(true,Ordering::SeqCst);assert!(!commit(&b,"main","id","new"));b.frozen.store(false,Ordering::SeqCst);b.pending.lock().unwrap().get_mut("id").unwrap().deadline=Instant::now();assert!(!commit(&b,"main","id","new"));b.pending.lock().unwrap().remove("id");assert!(!commit(&b,"main","id","new"))}
 #[tokio::test]async fn drain_reports_execution_state_and_preserves_service(){let b=fixture();for committed in [false,true]{let(tx,rx)=oneshot::channel();b.pending.lock().unwrap().insert("id".into(),Pending{deadline:Instant::now()+Duration::from_secs(1),committed:Arc::new(AtomicBool::new(committed)),reply:tx,label:"main".into(),client:client()});drain(&b,None,"update_preparing");let result=rx.await.unwrap();assert_eq!(result["structuredContent"]["executed"],if committed{json!("unknown")}else{json!(false)});assert!(!b.stopped.load(Ordering::SeqCst));}}
 #[tokio::test]async fn real_router_host_method_and_body_guards(){let b=fixture();let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let addr=listener.local_addr().unwrap();let task=tokio::spawn(async move{axum::serve(listener,router(b)).await.unwrap()});let http=reqwest::Client::new();let url=format!("http://{addr}/mcp");for host in ["127.0.0.1:1234","localhost:1234"]{let response=http.post(&url).header("host",host).bearer_auth("fixture-token").header("content-type","application/json").body(json!({"jsonrpc":"2.0","id":1,"method":"ping"}).to_string()).send().await.unwrap();assert_eq!(response.status(),200)}assert_eq!(http.post(&url).header("host","foreign.invalid").bearer_auth("fixture-token").body("{}").send().await.unwrap().status(),401);assert_eq!(http.get(&url).send().await.unwrap().status(),405);assert_eq!(http.post(&url).body("x".repeat(65537)).send().await.unwrap().status(),413);task.abort();}
}
#[cfg(test)]
mod multiwindow_tests{
 use super::*;
 #[tokio::test]async fn live_router_lists_new_tools_for_other_window_after_registration(){
  let client=|epoch:&str,name:&str|Arc::new(Client{epoch:epoch.into(),channel:Channel::new(|_|Ok(())),tools:json!([{"name":name,"inputSchema":{"type":"object","properties":{},"additionalProperties":false},"timeoutMs":1200000}])});
  let clients=Arc::new(Mutex::new(HashMap::from([("A".into(),client("a","core")),("B".into(),client("b","before"))])));let b=Arc::new(Bridge{token:Mutex::new("fixture-token".into()),port:1234,clients:clients.clone(),pending:Mutex::default(),stopped:AtomicBool::new(false),frozen:AtomicBool::new(false)});
  let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let addr=listener.local_addr().unwrap();let task=tokio::spawn(async move{axum::serve(listener,router(b)).await.unwrap()});
  let list=|window:&str|reqwest::Client::new().post(format!("http://{addr}/mcp")).header("host","localhost:1234").header("content-type","application/json").bearer_auth("fixture-token").body(json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"window":window}}).to_string());
  assert!(list("B").send().await.unwrap().text().await.unwrap().contains("before"));clients.lock().unwrap().insert("B".into(),client("b","plugin.enabled"));let result=list("B").send().await.unwrap().text().await.unwrap();assert!(result.contains("plugin.enabled"));assert!(!result.contains("before"));assert!(!result.contains("timeoutMs"));assert!(!list("A").send().await.unwrap().text().await.unwrap().contains("plugin.enabled"));task.abort();
 }
}

#[cfg(feature="native-smoke")]
#[tauri::command]
pub async fn native_smoke_rpc(state:State<'_,McpState>,request:Value)->Result<Value,String>{
 let b=bridge(&state)?;let token=b.token.lock().unwrap().clone();let text=reqwest::Client::new().post(format!("http://127.0.0.1:{}/mcp",b.port)).bearer_auth(token).header("content-type","application/json").body(request.to_string()).send().await.map_err(|_|"smoke HTTP request failed".to_string())?.text().await.map_err(|_|"smoke HTTP response failed".to_string())?;serde_json::from_str(&text).map_err(|_|"smoke JSON failed".into())
}
#[cfg(test)]
mod catalog_refresh_tests{
 use super::*;
 #[tokio::test]async fn same_document_catalog_keeps_committed_long_call_but_new_document_drains(){
  let(tx,mut events)=tokio::sync::mpsc::unbounded_channel::<Value>();
  let client=|epoch:&str,name:&str|{let tx=tx.clone();Arc::new(Client{epoch:epoch.into(),channel:Channel::new(move|body|{if let tauri::ipc::InvokeResponseBody::Json(text)=body{let _=tx.send(serde_json::from_str(&text).unwrap());}Ok(())}),tools:json!([{"name":name,"inputSchema":{"type":"object","properties":{}},"timeoutMs":1200000}])})};
  let clients=Arc::new(Mutex::new(HashMap::from([("A".into(),client("document-a","long"))])));let b=Arc::new(Bridge{token:Mutex::new("fixture-token".into()),port:1234,clients:clients.clone(),pending:Mutex::default(),stopped:AtomicBool::new(false),frozen:AtomicBool::new(false)});let inner=Inner{clients,running:Some(Running{shared:b.clone(),shutdown:None,port:1234})};
  let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let addr=listener.local_addr().unwrap();let bridge=b.clone();let server=tokio::spawn(async move{axum::serve(listener,router(bridge)).await.unwrap()});
  let request=|name:&str|{let body=json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":{"window":"A"}}}).to_string();tokio::spawn(async move{reqwest::Client::new().post(format!("http://{addr}/mcp")).header("host","localhost:1234").header("content-type","application/json").bearer_auth("fixture-token").body(body).send().await.unwrap().text().await.unwrap()})};
  let first=request("long");let event=events.recv().await.unwrap();let id=event["id"].as_str().unwrap();assert!(commit(&b,"A",id,"document-a"));register_client(&inner,"A",client("document-a","new-catalog"));assert!(b.pending.lock().unwrap().contains_key(id));assert!(events.try_recv().is_err());assert!(commit(&b,"A",id,"document-a"));reply(&b,"A",id,"document-a",json!({"structuredContent":{"finished":true}})).unwrap();let result:Value=serde_json::from_str(&first.await.unwrap()).unwrap();assert_eq!(result["result"]["structuredContent"]["finished"],true);
  let second=request("new-catalog");let event=events.recv().await.unwrap();let id=event["id"].as_str().unwrap();assert!(commit(&b,"A",id,"document-a"));register_client(&inner,"A",client("document-b","new-document"));let cancel=events.recv().await.unwrap();assert_eq!(cancel["cancel"],true);assert!(!commit(&b,"A",id,"document-a"));let result:Value=serde_json::from_str(&second.await.unwrap()).unwrap();assert_eq!(result["result"]["structuredContent"]["code"],"document_replaced");assert_eq!(result["result"]["structuredContent"]["executed"],"unknown");server.abort();
 }
}
