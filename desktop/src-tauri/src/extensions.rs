//! Immutable verified extension assets; no filesystem paths or native libraries from packages execute.
use std::{collections::BTreeMap, fs, path::{Path,PathBuf}, time::Duration};
use base64::{Engine,engine::general_purpose::STANDARD};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use tauri::{Manager,State};
use std::sync::Mutex;
const MAX_BYTES:usize=44*1024*1024;
#[derive(Default)]
pub struct ExtensionState(pub std::sync::Arc<Mutex<()>>);
#[derive(Deserialize)]
struct Bundle { manifest:serde_json::Value, files:BTreeMap<String,String> }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Installed {hash:String,base_url:String}
fn hash(bytes:&[u8])->String {format!("{:x}",Sha256::digest(bytes))}
fn safe_path(value:&str)->bool {
 !value.is_empty() && value.len()<240 && value.split('/').all(|part|!part.is_empty() && part!="." && part!=".." && part.bytes().all(|b|b.is_ascii_alphanumeric() || b"_@.-".contains(&b)))
}
fn valid_hash(value:&str)->bool {value.len()==64 && value.bytes().all(|c|c.is_ascii_digit() || (b'a'..=b'f').contains(&c))}
fn parse_verified(json:&str,expected:&str)->Result<(Bundle,BTreeMap<String,Vec<u8>>),String> {
 if !valid_hash(expected) || json.len()>MAX_BYTES || hash(json.as_bytes())!=expected {return Err("包整体摘要不一致".into())}
 let bundle:Bundle=serde_json::from_str(json).map_err(|_|"包 JSON 无效")?;
 let m=&bundle.manifest;
 if m["schemaVersion"]!=1 || m["apiVersion"]!=1 || !m["entry"].as_str().is_some_and(safe_path) || bundle.files.len()>500 {return Err("清单不兼容".into())}
 let integrity=m["integrity"].as_object().ok_or("缺少完整性声明")?;
 if !integrity.contains_key(m["entry"].as_str().unwrap()) {return Err("缺少入口摘要".into())}
 let mut decoded=BTreeMap::new();let mut size=0;
 for (path,value) in &bundle.files {
  if !safe_path(path) || path=="__bundle.json" || path=="__complete" {return Err("包路径无效".into())}
  let bytes=STANDARD.decode(value).map_err(|_|"包文件编码无效")?;size+=bytes.len();if size>32*1024*1024{return Err("包过大".into())}
  match integrity.get(path) {
   Some(expected) if expected.as_str()==Some(&format!("sha256-{}",hash(&bytes)))=>{},
   None if path=="LICENSE" || path=="NOTICE"=>{},
   _=>return Err("文件摘要不一致".into())
  }
  decoded.insert(path.clone(),bytes);
 }
 for path in integrity.keys() {if !safe_path(path) || !decoded.contains_key(path) {return Err("包声明文件缺失".into())}}
 Ok((bundle,decoded))
}
fn no_symlink_tree(base:&Path,path:&str)->Result<PathBuf,String> {
 let mut current=base.to_path_buf();
 if fs::symlink_metadata(&current).map_err(|e|e.to_string())?.file_type().is_symlink() {return Err("缓存符号链接被拒绝".into())}
 for part in path.split('/') {current.push(part);if fs::symlink_metadata(&current).map_err(|e|e.to_string())?.file_type().is_symlink(){return Err("缓存符号链接被拒绝".into())}}
 Ok(current)
}
fn install(root:&Path,json:&str,expected:&str)->Result<(),String> {
 let (_,files)=parse_verified(json,expected)?;fs::create_dir_all(root).map_err(|e|e.to_string())?;
 if fs::symlink_metadata(root).map_err(|e|e.to_string())?.file_type().is_symlink(){return Err("缓存根目录无效".into())}
 let destination=root.join(expected);
 if destination.exists() {
  let old=no_symlink_tree(&destination,"__bundle.json")?;
  if fs::read(old).map_err(|e|e.to_string())?==json.as_bytes() {
   for (path,bytes) in &files {if fs::read(no_symlink_tree(&destination,path)?).map_err(|e|e.to_string())?!=*bytes{return Err("已有缓存损坏，保留旧版本供恢复".into())}}
   return Ok(())
  }
  return Err("已有缓存与摘要不一致".into())
 }
 let stage=root.join(format!(".stage-{}-{}",std::process::id(),expected));
 if stage.exists(){fs::remove_dir_all(&stage).map_err(|e|e.to_string())?}fs::create_dir(&stage).map_err(|e|e.to_string())?;
 let result=(|| {
  for (path,bytes) in files {let target=stage.join(path);fs::create_dir_all(target.parent().unwrap()).map_err(|e|e.to_string())?;fs::write(target,bytes).map_err(|e|e.to_string())?;}
  fs::write(stage.join("__bundle.json"),json).map_err(|e|e.to_string())?;
  fs::rename(&stage,destination).map_err(|e|e.to_string())
 })();if result.is_err(){let _=fs::remove_dir_all(stage);}result
}
#[tauri::command]
pub async fn extension_install(app:tauri::AppHandle,state:State<'_,ExtensionState>,bundle_json:String,expected_hash:String)->Result<Installed,String> {
 let root=app.path().app_cache_dir().map_err(|e|e.to_string())?.join("extensions-v1");let gate=state.0.clone();let id=expected_hash.clone();
 tauri::async_runtime::spawn_blocking(move||{let _guard=gate.lock().map_err(|_|"缓存锁无效")?;install(&root,&bundle_json,&id)}).await.map_err(|e|e.to_string())??;
 let base_url=if cfg!(windows){format!("http://devicedock-extension.localhost/{expected_hash}/")}else{format!("devicedock-extension://localhost/{expected_hash}/")};
 Ok(Installed{hash:expected_hash,base_url})
}
#[tauri::command]
pub async fn extension_download(url:String,sha256:String)->Result<String,String> {
 use futures_util::StreamExt;
 if !valid_hash(&sha256){return Err("摘要无效".into())}
 let parsed=reqwest::Url::parse(&url).map_err(|_|"URL 无效")?;
 if parsed.scheme()!="https" || !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some(){return Err("仅允许无凭据 HTTPS 产物".into())}
 let client=reqwest::Client::builder().timeout(Duration::from_secs(30)).redirect(reqwest::redirect::Policy::custom(|attempt|{if attempt.previous().len()>5 || attempt.url().scheme()!="https" || !attempt.url().username().is_empty() || attempt.url().password().is_some(){attempt.error("不安全的产物重定向")}else{attempt.follow()}})).build().map_err(|e|e.to_string())?;
 let response=client.get(parsed).send().await.map_err(|_|"产物下载失败")?.error_for_status().map_err(|_|"产物 HTTP 错误")?;
 if response.content_length().is_some_and(|n|n>MAX_BYTES as u64){return Err("产物过大".into())}
 let mut stream=response.bytes_stream();let mut bytes=Vec::new();
 while let Some(chunk)=stream.next().await {let chunk=chunk.map_err(|_|"产物流错误")?;if bytes.len()+chunk.len()>MAX_BYTES{return Err("产物过大".into())}bytes.extend_from_slice(&chunk)}
 if hash(&bytes)!=sha256{return Err("产物摘要不一致".into())}String::from_utf8(bytes).map_err(|_|"产物不是 UTF-8 JSON".into())
}
#[tauri::command]
pub async fn extension_read_asset(app:tauri::AppHandle,hash:String,path:String)->Result<Vec<u8>,String> {
 if !valid_hash(&hash) || !safe_path(&path) {return Err("资源路径无效".into())}
 let root=app.path().app_cache_dir().map_err(|e|e.to_string())?.join("extensions-v1");
 tauri::async_runtime::spawn_blocking(move||{let response=response(&root,&format!("/{hash}/{path}"));if response.status()!=200{return Err("已验证资源不可用".into())}Ok(response.into_body())}).await.map_err(|e|e.to_string())?
}
pub fn response(root:&Path,path:&str)->tauri::http::Response<Vec<u8>> {
 let result:Result<Vec<u8>,String>=(|| {
  let path=path.strip_prefix('/').ok_or("路径无效")?;let (id,file)=path.split_once('/').ok_or("路径无效")?;
  if !valid_hash(id) || !safe_path(file) || file=="__bundle.json"{return Err("路径无效".to_string())}
  let base=root.join(id);let json=fs::read_to_string(no_symlink_tree(&base,"__bundle.json")?).map_err(|_|"缓存缺失")?;
  let (_,files)=parse_verified(&json,id)?;let expected=files.get(file).ok_or("未声明文件")?;
  let bytes=fs::read(no_symlink_tree(&base,file)?).map_err(|_|"文件缺失")?;
  if bytes!=*expected{return Err("缓存文件损坏".into())}
  Ok(bytes)
 })();
 let mime=if path.ends_with(".js") || path.ends_with(".mjs"){"text/javascript"}else if path.ends_with(".wasm"){"application/wasm"}else if path.ends_with(".json"){"application/json"}else if path.ends_with(".css"){"text/css"}else{"application/octet-stream"};
 match result {Ok(bytes)=>tauri::http::Response::builder().header("Content-Type",mime).header("Access-Control-Allow-Origin","*").header("X-Content-Type-Options","nosniff").body(bytes).unwrap(),Err(_)=>tauri::http::Response::builder().status(404).body(b"Verified extension unavailable".to_vec()).unwrap()}
}
#[cfg(test)]
mod tests {
 use super::*;
 fn fixture()->(String,String){let code=b"export function activate() {}";let value=serde_json::json!({"manifest":{"schemaVersion":1,"apiVersion":1,"entry":"index.js","integrity":{"index.js":format!("sha256-{}",hash(code))}},"files":{"index.js":STANDARD.encode(code)}}).to_string();let id=hash(value.as_bytes());(value,id)}
 #[test]fn cache_install_and_exact_bytes(){let (json,id)=fixture();let root=std::env::temp_dir().join(format!("devicedock-cache-test-{}",std::process::id()));let _=fs::remove_dir_all(&root);install(&root,&json,&id).unwrap();install(&root,&json,&id).unwrap();let result=response(&root,&format!("/{id}/index.js"));assert_eq!(result.status(),200);assert_eq!(result.body(),b"export function activate() {}");assert_eq!(response(&root,&format!("/{id}/../index.js")).status(),404);fs::write(root.join(&id).join("index.js"),b"tamper").unwrap();assert_eq!(response(&root,&format!("/{id}/index.js")).status(),404);assert!(install(&root,&json,&id).is_err());fs::remove_dir_all(root).unwrap();}
 #[test]fn js_canonical_package_vector(){let json=include_str!("../../../tests/fixtures/trusted-package.json");let id=include_str!("../../../tests/fixtures/trusted-package.sha256");assert!(parse_verified(json,id).is_ok());}
 #[test]fn rejects_paths_and_tamper(){let (json,id)=fixture();assert!(parse_verified(&(json+" "),&id).is_err());for path in ["../a","a/../../b","/a","a//b","a/%2e%2e/b","a\\b"]{assert!(!safe_path(path))}}
}
