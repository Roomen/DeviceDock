// 插件落盘：plugins/<id>/<version>/ 是包内容，plugins/<id>/storage.json 是插件私有存储，
// plugins/state.json 记启用状态、来源与安装摘要。写入一律「同目录临时文件 + 原子替换」。
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use super::manifest::{self, Manifest, MAX_FILE_BYTES, MAX_TOTAL_BYTES};

pub const STATE_VERSION: u32 = 1;
const STATE_FILE: &str = "state.json";
const MANIFEST_FILE: &str = "manifest.json";
const STORAGE_FILE: &str = "storage.json";
// 插件私有存储：单个值、键名与条目数上限
pub const MAX_STORAGE_VALUE_BYTES: usize = 64 * 1024;
pub const MAX_STORAGE_KEYS: usize = 256;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub enabled: bool,
    pub repo: String,
    pub tag: String,
    pub version: String,
    pub installed_at: u64,
    pub capabilities: Vec<String>,
    pub package_sha256: String,
    // 安装事务恢复失败的原因（待修复硬门槛，写进 state.json 作为 .repair.json 的备份）
    #[serde(default)]
    pub repair: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub version: u32,
    pub plugins: BTreeMap<String, Entry>,
}

impl Default for State {
    fn default() -> Self {
        State { version: STATE_VERSION, plugins: BTreeMap::new() }
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

pub fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|_| "找不到应用数据目录".to_string())?;
    Ok(base.join("plugins"))
}

pub fn load_state(root: &Path) -> State {
    let Ok(raw) = fs::read_to_string(root.join(STATE_FILE)) else { return State::default() };
    match serde_json::from_str::<State>(&raw) {
        Ok(s) if s.version == STATE_VERSION => s,
        // 存档损坏或版本不认识时按「没有任何插件」处理：包目录还在但不会被加载，用户重装即可
        _ => State::default(),
    }
}

pub fn save_state(root: &Path, state: &State) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(state).map_err(|e| format!("插件状态序列化失败：{e}"))?;
    write_atomic(&root.join(STATE_FILE), &body)
}

// rename 之后还要把目录项刷盘，否则断电可能把「记录已写」丢掉。Windows 不能 fsync 目录句柄。
#[cfg(unix)]
fn sync_dir(dir: &Path) -> Result<(), String> {
    let f = fs::File::open(dir).map_err(|e| format!("无法同步插件目录：{e}"))?;
    f.sync_all().map_err(|e| format!("无法同步插件目录：{e}"))
}

#[cfg(windows)]
fn sync_dir(_dir: &Path) -> Result<(), String> {
    // Windows 没有目录 fd 的 fsync：rename 本身是原子替换，只做上面那步文件 fsync。
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn sync_dir(_dir: &Path) -> Result<(), String> {
    Ok(())
}

fn write_atomic(path: &Path, body: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| "路径无效".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("无法创建插件目录：{e}"))?;
    let mut suffix = [0u8; 6];
    let _ = getrandom::fill(&mut suffix);
    let name = format!(
        "{}.{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("tmp"),
        suffix.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );
    let tmp = dir.join(name);
    let mut file = fs::File::create(&tmp).map_err(|e| format!("无法写入插件目录：{e}"))?;
    let written = file.write_all(body).and_then(|_| file.flush()).and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("无法写入插件目录：{e}"));
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("无法保存插件文件：{e}"));
    }
    sync_dir(dir)
}

pub fn plugin_dir(root: &Path, id: &str) -> PathBuf {
    root.join(id)
}

pub fn version_dir(root: &Path, id: &str, version: &str) -> PathBuf {
    // 版本来自 manifest / state.json 或 URL；拼进路径前一律复核，非法版本指向一个不存在的名字
    let safe = manifest::safe_version_component(version).unwrap_or(".invalid-version");
    plugin_dir(root, id).join(safe)
}

// 落盘前的独立校验：必须是 <root>/<id>/<version> 这个单层子目录
pub fn checked_version_dir(root: &Path, id: &str, version: &str) -> Result<PathBuf, String> {
    if !manifest::valid_id(id) {
        return Err("插件 id 无效".to_string());
    }
    let safe = manifest::safe_version_component(version)
        .ok_or_else(|| format!("插件版本 {version} 不合法，不能作为目录名"))?;
    let parent = plugin_dir(root, id);
    let dir = parent.join(safe);
    if dir.parent() != Some(parent.as_path()) {
        return Err("插件版本目录越界".to_string());
    }
    Ok(dir)
}

// state.json 的读改写：load_and_save 给已经持锁的调用方（安装事务），update_state 自己加锁。
// 多窗口并发安装 / 启停 / 卸载不能各按旧快照覆盖。
pub fn load_and_save<R>(root: &Path, f: impl FnOnce(&mut State) -> R) -> Result<R, String> {
    let mut st = load_state(root);
    let out = f(&mut st);
    save_state(root, &st)?;
    Ok(out)
}

pub fn update_state<R>(root: &Path, lock: &std::sync::Mutex<()>, f: impl FnOnce(&mut State) -> R) -> Result<R, String> {
    let _guard = lock.lock().map_err(|_| "插件状态被占用".to_string())?;
    load_and_save(root, f)
}

pub fn read_manifest(dir: &Path) -> Result<Manifest, String> {
    let path = dir.join(MANIFEST_FILE);
    let meta = fs::metadata(&path).map_err(|_| "包里没有 manifest.json".to_string())?;
    if meta.len() > manifest::MAX_MANIFEST_BYTES {
        return Err("manifest.json 过大".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| format!("无法读取 manifest.json：{e}"))?;
    manifest::parse(&bytes)
}

// 逐文件校验：只认 integrity 里列出的文件，符号链接、缺失、摘要不符、超限都整包拒绝
pub fn verify_dir(dir: &Path, m: &Manifest) -> Result<u64, String> {
    let mut total: u64 = 0;
    for (rel, digest) in &m.integrity {
        let path = dir.join(rel);
        let meta = fs::symlink_metadata(&path).map_err(|_| format!("包内缺少文件：{rel}"))?;
        if meta.file_type().is_symlink() {
            return Err(format!("包内不允许符号链接：{rel}"));
        }
        if !meta.is_file() {
            return Err(format!("包内 {rel} 不是普通文件"));
        }
        if meta.len() > MAX_FILE_BYTES {
            return Err(format!("包内文件过大：{rel}"));
        }
        total = total.saturating_add(meta.len());
        if total > MAX_TOTAL_BYTES {
            return Err("包解压后超过 64 MiB".to_string());
        }
        let bytes = fs::read(&path).map_err(|e| format!("无法读取包内文件 {rel}：{e}"))?;
        let actual = sha256_hex(&bytes);
        if &actual != digest {
            return Err(format!("{rel} 的 sha256 与 manifest 不符"));
        }
    }
    Ok(total)
}

// ---------- 安装事务 ----------
// 恢复**只看实际文件系统状态**，阶段字段只用于诊断，不再作为判断依据。
//
// 记号：T = target 目录（存在? 身份=?）；B = backup 目录；S = staging 目录；
//       ST = state.json 里该插件的条目（Old / New / Unknown）；
//       oldId / newId = 记录里两个完整包目录的树摘要；prev / exp = 新旧 state 条目；
//       hasOld = oldId 非空（之前确实装过旧版）。身份用 tree_sha256 对目录**全部文件**
//       （含 manifest.json、含 integrity 未列出的文件）按相对路径排序算得。
//
// 决策表（每一行都有对应单测，见本文件 tests 模块）：
// | # | T          | B        | S   | ST       | hasOld | 动作 | 单测 |
// |---|------------|----------|-----|----------|--------|------|------|
// | 1 | 不存在     | 不存在   | 任意 | Old      | false  | 旧版完整（未安装）→ 删 S、还原 prev、删记录 | row1_prepared_no_old |
// | 2 | =oldId     | 不存在   | 任意 | Old      | true   | 旧版完整 → 保留 T、删 S、还原 prev、删记录 | row2_old_at_target |
// | 3 | 不存在     | =oldId   | 任意 | Old      | true   | 旧版完整（在备份）→ B 改回 T、删 S、还原 prev、删记录 | row3_old_in_backup |
// | 4 | =newId     | =oldId   | 任意 | New      | true   | 新版完整且 state 已是新 → 补完清理、删记录 | row4_new_with_new_state |
// | 5 | =newId     | =oldId   | 任意 | Old      | true   | 新版完整但 state 是旧 → 删 T、B 改回 T、删 S、还原 prev、删记录 | row5_new_with_old_state_rolls_back |
// | 6 | =newId     | 不存在   | 任意 | New      | false  | 首次安装已完成状态 → 补完清理、删记录 | row6_fresh_new_state |
// | 7 | =newId     | 不存在   | 任意 | Old      | false  | 首次安装但 state 旧 → 删 T、删 S、移除条目、删记录 | row7_fresh_old_state_removes |
// | 8 | 其它任意组合（T 身份不符 / T 与 B 都缺 / B 身份不符 / ST=Unknown / 路径非法） | | | | | **不删任何副本**，写 .repair.json 或 state 禁用并隔离待修复 | row8_unknown_isolates_without_deleting |
//
// S 只在 1~7 行「结论确定」时删除；第 8 行连 staging 都不动。
const TX_FILE: &str = ".tx.json";
const REPAIR_FILE: &str = ".repair.json";
const LOCK_FILE: &str = ".lock";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxStage {
    #[default]
    Prepared,
    Swapped,
    StateWritten,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxRecord {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub backup: bool,
    #[serde(default)]
    pub staging: String,
    // 三个阶段字段只用于诊断 / 展示；恢复决策不使用它们
    #[serde(default)]
    pub stage: TxStage,
    #[serde(default)]
    pub committed: bool,
    // 三个路径（相对 plugins 根目录）：target / backup / staging
    #[serde(default)]
    pub target_path: String,
    #[serde(default)]
    pub backup_path: String,
    #[serde(default)]
    pub staging_path: String,
    // 两份完整包身份（全目录树摘要），旧包不存在时 oldId 为空
    #[serde(default)]
    pub old_id: String,
    #[serde(default)]
    pub new_id: String,
    // 兼容旧格式，等价于 new_id
    #[serde(default)]
    pub tree_sha256: String,
    // 新旧 state 条目
    #[serde(default)]
    pub previous_state: Option<Entry>,
    #[serde(default)]
    pub expected_state: Option<Entry>,
}

impl TxRecord {
    fn new_id(&self) -> &str {
        if !self.new_id.is_empty() { &self.new_id } else { &self.tree_sha256 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairInfo {
    pub id: String,
    pub reason: String,
    pub stage: String,
    pub at: u64,
}

#[derive(Debug, Default)]
pub struct RecoveryOutcome {
    pub problems: Vec<RepairInfo>,
    // 修复标记与 state 写入都失败的插件：只在本次进程内存里强制不可用
    pub blocked: Vec<String>,
}

pub fn tx_path(root: &Path, id: &str) -> PathBuf {
    plugin_dir(root, id).join(TX_FILE)
}

fn repair_path(root: &Path, id: &str) -> PathBuf {
    plugin_dir(root, id).join(REPAIR_FILE)
}

fn write_tx(root: &Path, id: &str, rec: &TxRecord) -> Result<(), String> {
    let body = serde_json::to_vec(rec).map_err(|e| format!("插件事务记录序列化失败：{e}"))?;
    write_atomic(&tx_path(root, id), &body)
}

fn read_tx(path: &Path) -> Result<TxRecord, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("无法读取插件事务记录：{e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("插件事务记录损坏：{e}"))
}

pub fn read_repair(root: &Path, id: &str) -> Option<RepairInfo> {
    let raw = fs::read_to_string(repair_path(root, id)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn repair_reason(root: &Path, id: &str) -> Option<String> {
    read_repair(root, id).map(|r| r.reason)
}

// 待修复是硬门槛：.repair.json 与 state 条目两处任一可用即视为已隔离
pub fn has_repair(root: &Path, state: &State, id: &str) -> bool {
    read_repair(root, id).is_some()
        || state.plugins.get(id).and_then(|e| e.repair.as_ref()).is_some()
}

fn write_repair(root: &Path, id: &str, reason: &str, stage: TxStage) -> Result<(), String> {
    let info = RepairInfo {
        id: id.to_string(),
        reason: reason.to_string(),
        stage: format!("{stage:?}"),
        at: now_unix(),
    };
    let body = serde_json::to_vec(&info).map_err(|e| format!("修复标记序列化失败：{e}"))?;
    write_atomic(&repair_path(root, id), &body)
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn clear_repair(root: &Path, id: &str) {
    let _ = fs::remove_file(repair_path(root, id));
    let _ = load_and_save(root, |st| {
        if let Some(e) = st.plugins.get_mut(id) {
            e.repair = None;
        }
    });
}

pub fn discard_tx(root: &Path, id: &str) {
    let _ = fs::remove_file(tx_path(root, id));
}

pub fn list_repairs(root: &Path) -> Vec<RepairInfo> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else { return out };
    for e in entries.flatten() {
        if e.path().is_dir() {
            let id = e.file_name().to_string_lossy().to_string();
            if let Some(r) = read_repair(root, &id) { out.push(r) }
        }
    }
    let st = load_state(root);
    for (id, e) in &st.plugins {
        if let Some(reason) = &e.repair {
            if !out.iter().any(|r| &r.id == id) {
                out.push(RepairInfo { id: id.clone(), reason: reason.clone(), stage: "StateEntry".into(), at: now_unix() });
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub struct FileLock {
    _file: fs::File,
}

pub fn file_lock(root: &Path) -> Result<FileLock, String> {
    fs::create_dir_all(root).map_err(|e| format!("无法创建插件目录：{e}"))?;
    let file = fs::OpenOptions::new()
        .create(true).read(true).write(true)
        .open(root.join(LOCK_FILE))
        .map_err(|e| format!("无法打开插件事务锁：{e}"))?;
    fs2::FileExt::lock_exclusive(&file).map_err(|e| format!("无法取得插件事务锁：{e}"))?;
    Ok(FileLock { _file: file })
}

fn staging_name(staging: &Path) -> String {
    staging.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string()
}

fn stored_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel.contains("..") || rel.starts_with('/') || rel.contains(char::from(92)) {
        return Err("事务记录里的路径不合法".to_string());
    }
    let p = root.join(rel);
    if !p.starts_with(root) { return Err("事务记录里的路径越界".to_string()); }
    Ok(p)
}

// 目录身份：递归收集**全部文件**（含 manifest.json、含 integrity 未列出的文件），
// 按相对路径排序后把「路径 + 长度 + sha256」喂给 SHA-256。符号链接 / 特殊文件直接报错。
pub fn tree_sha256(dir: &Path) -> Result<String, String> {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    collect_files(dir, dir, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (rel, bytes) in &files {
        hasher.update(rel.as_bytes());
        hasher.update(b":");
        hasher.update(bytes.len().to_string().as_bytes());
        hasher.update(b":");
        hasher.update(sha256_hex(bytes).as_bytes());
        hasher.update(b";");
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn collect_files(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("无法读取插件目录：{e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("无法读取插件目录：{e}"))?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("无法读取插件文件：{e}"))?;
        if meta.file_type().is_symlink() { return Err("包内不允许符号链接".to_string()); }
        if meta.is_dir() { collect_files(base, &path, out)?; continue; }
        if !meta.is_file() { return Err("包内有非普通文件".to_string()); }
        let rel = path.strip_prefix(base).map_err(|e| format!("包内路径异常：{e}"))?
            .to_string_lossy().replace(char::from(92), "/");
        let bytes = fs::read(&path).map_err(|e| format!("无法读取包内文件 {rel}：{e}"))?;
        out.push((rel, bytes));
        if out.len() > manifest::MAX_FILES { return Err("包内文件过多".to_string()); }
    }
    Ok(())
}

fn identity(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() { return Ok(None); }
    let meta = fs::symlink_metadata(path).map_err(|e| format!("无法读取目录：{e}"))?;
    if !meta.is_dir() { return Err("事务路径不是目录".to_string()); }
    Ok(Some(tree_sha256(path)?))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StateClass { Old, New, Unknown }

fn normalized(e: &Entry) -> Entry {
    let mut c = e.clone();
    c.repair = None;
    c
}

fn state_class(root: &Path, id: &str, rec: &TxRecord) -> StateClass {
    let cur = load_state(root).plugins.get(id).cloned().map(|e| normalized(&e));
    if let Some(exp) = &rec.expected_state {
        if cur.as_ref().map(|e| e == exp).unwrap_or(false) { return StateClass::New; }
    }
    let old_ok = match (cur.as_ref(), rec.previous_state.as_ref()) {
        (None, None) => true,
        (Some(a), Some(b)) => a == &normalized(b),
        _ => false,
    };
    if old_ok { StateClass::Old } else { StateClass::Unknown }
}

fn cleanup_after_commit(root: &Path, id: &str, rec: &TxRecord) -> Result<(), String> {
    prune_versions(root, id, &rec.version);
    let backup = stored_path(root, &rec.backup_path)?;
    if backup.exists() { fs::remove_dir_all(&backup).map_err(|e| format!("无法删除插件旧版本备份：{e}"))?; }
    remove_staging(root, rec)
}

fn remove_staging(root: &Path, rec: &TxRecord) -> Result<(), String> {
    if !rec.staging_path.is_empty() {
        let st = stored_path(root, &rec.staging_path)?;
        if st.exists() { fs::remove_dir_all(&st).map_err(|e| format!("无法删除插件临时目录：{e}"))?; }
    }
    Ok(())
}

fn restore_state(root: &Path, id: &str, entry: Option<&Entry>) -> Result<(), String> {
    load_and_save(root, |st| match entry {
        Some(e) => { st.plugins.insert(id.to_string(), normalized(e)); }
        None => { st.plugins.remove(id); }
    })
}

// 纯决策函数：单测逐行核对决策表
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Recovery {
    RestoreOld { from_backup: bool },
    FinishNew,
    RollbackNew { has_old: bool },
    Isolate,
}

fn decide(rec: &TxRecord, t: Option<&str>, b: Option<&str>, st: StateClass) -> Recovery {
    let new_id = rec.new_id();
    let has_old = !rec.old_id.is_empty();
    let t_is_new = !new_id.is_empty() && t == Some(new_id);
    let t_is_old = has_old && t == Some(rec.old_id.as_str());
    let b_is_old = has_old && b == Some(rec.old_id.as_str());
    if st == StateClass::Old {
        if !has_old && t.is_none() && b.is_none() { return Recovery::RestoreOld { from_backup: false }; } // 1
        if has_old && t_is_old && b.is_none() { return Recovery::RestoreOld { from_backup: false }; } // 2
        if has_old && t.is_none() && b_is_old { return Recovery::RestoreOld { from_backup: true }; } // 3
    }
    if t_is_new {
        if has_old && b_is_old {
            if st == StateClass::New { return Recovery::FinishNew; } // 4
            if st == StateClass::Old { return Recovery::RollbackNew { has_old: true }; } // 5
        }
        if !has_old && b.is_none() {
            if st == StateClass::New { return Recovery::FinishNew; } // 6
            if st == StateClass::Old { return Recovery::RollbackNew { has_old: false }; } // 7
        }
    }
    Recovery::Isolate // 8
}

fn recover_one(root: &Path, id: &str, rec: &TxRecord) -> Result<(), String> {
    let target = stored_path(root, &rec.target_path)?;
    let backup = stored_path(root, &rec.backup_path)?;
    let staging = if rec.staging_path.is_empty() { None } else { Some(stored_path(root, &rec.staging_path)?) };
    let _ = staging;
    let t = identity(&target)?;
    let b = identity(&backup)?;
    let st = state_class(root, id, rec);
    match decide(rec, t.as_deref(), b.as_deref(), st) {
        Recovery::Isolate => Err("文件系统状态无法确定事务结论，保留全部副本等待修复".to_string()),
        Recovery::RestoreOld { from_backup } => {
            if from_backup && !target.exists() {
                fs::rename(&backup, &target).map_err(|e| format!("无法还原插件旧版本：{e}"))?;
            }
            remove_staging(root, rec)?;
            restore_state(root, id, rec.previous_state.as_ref())?;
            Ok(())
        }
        Recovery::FinishNew => {
            // state 已是新的，只补完清理；不删 target
            cleanup_after_commit(root, id, rec)?;
            restore_state(root, id, rec.expected_state.as_ref())?;
            Ok(())
        }
        Recovery::RollbackNew { has_old } => {
            // 已确认 target 是本次换入的新包，才允许删它
            fs::remove_dir_all(&target).map_err(|e| format!("无法移除未提交的插件版本：{e}"))?;
            if has_old {
                fs::rename(&backup, &target).map_err(|e| format!("无法还原插件旧版本：{e}"))?;
            }
            remove_staging(root, rec)?;
            restore_state(root, id, rec.previous_state.as_ref())?;
            Ok(())
        }
    }
}

// 应用启动时调用：单个插件恢复失败只隔离这个插件，绝不让客户端起不来。
// 同时清掉没有事务记录引用的残留 staging 目录（此时持跨进程锁，不会有并发安装）。
pub fn recover_transactions(root: &Path) -> RecoveryOutcome {
    let mut out = RecoveryOutcome::default();
    let Ok(entries) = fs::read_dir(root) else { return out };
    let mut active_staging = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_dir() { continue; }
        let id = entry.file_name().to_string_lossy().to_string();
        let tp = tx_path(root, &id);
        if !tp.exists() { continue; }
        let rec = match read_tx(&tp) {
            Ok(r) => r,
            Err(e) => {
                let (info, persisted) = isolate_repair(root, &id, &e, TxStage::Prepared);
                out.problems.push(info);
                if !persisted { out.blocked.push(id); }
                continue;
            }
        };
        if !rec.staging_path.is_empty() { active_staging.push(rec.staging_path.clone()); }
        match recover_one(root, &id, &rec) {
            Ok(()) => {
                let _ = fs::remove_file(&tp);
                clear_repair(root, &id);
            }
            Err(e) => {
                let (info, persisted) = isolate_repair(root, &id, &e, rec.stage);
                out.problems.push(info);
                if !persisted { out.blocked.push(id); }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(".staging-") && !active_staging.contains(&name) && entry.path().is_dir() {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    out
}

// 至少一处持久化成功：先 .repair.json，再 state.json（enabled=false + repair 字段）。
// 两处都失败时返回 persisted=false，调用方把 id 记进本次进程的内存禁用集合。
fn isolate_repair(root: &Path, id: &str, reason: &str, stage: TxStage) -> (RepairInfo, bool) {
    let marker_ok = write_repair(root, id, reason, stage).is_ok();
    let state_ok = load_and_save(root, |st| {
        let entry = st.plugins.entry(id.to_string()).or_insert_with(|| Entry {
            enabled: false,
            repo: String::new(),
            tag: String::new(),
            version: String::new(),
            installed_at: 0,
            capabilities: Vec::new(),
            package_sha256: String::new(),
            repair: None,
        });
        entry.enabled = false;
        entry.repair = Some(reason.to_string());
    }).is_ok();
    (RepairInfo {
        id: id.to_string(),
        reason: reason.to_string(),
        stage: format!("{stage:?}"),
        at: now_unix(),
    }, marker_ok || state_ok)
}

pub fn retry_recovery(root: &Path, id: &str) -> Result<(), String> {
    let tp = tx_path(root, id);
    if !tp.exists() {
        clear_repair(root, id);
        return Ok(());
    }
    let rec = read_tx(&tp)?;
    recover_one(root, id, &rec)?;
    fs::remove_file(&tp).map_err(|e| format!("无法删除插件事务记录：{e}"))?;
    clear_repair(root, id);
    Ok(())
}

pub struct InstallTx {
    root: PathBuf,
    id: String,
    target: PathBuf,
    rec: TxRecord,
}

impl InstallTx {
    #[allow(dead_code)]
    pub fn target(&self) -> &Path { &self.target }
    fn advance(&mut self, stage: TxStage) -> Result<(), String> {
        self.rec.stage = stage;
        self.rec.committed = stage == TxStage::Committed;
        write_tx(&self.root, &self.id, &self.rec)
    }
    pub fn swap(&mut self) -> Result<(), String> {
        let plugin_root = plugin_dir(&self.root, &self.id);
        let backup = plugin_root.join(format!(".old-{}", self.rec.version));
        if self.target.exists() {
            let _ = fs::remove_dir_all(&backup);
            if let Err(e) = fs::rename(&self.target, &backup) {
                let restore = fs::rename(&backup, &self.target);
                if self.target.exists() || restore.is_ok() { return Err(format!("无法替换已有插件版本：{e}")); }
                return Err(format!("无法替换已有插件版本：{e}；还原备份也失败：{restore:?}"));
            }
        }
        let staging = self.root.join(&self.rec.staging_path);
        if let Err(e) = fs::rename(&staging, &self.target) {
            let _ = fs::remove_dir_all(&staging);
            let mut restore_err = String::new();
            if backup.exists() && !self.target.exists() {
                if let Err(re) = fs::rename(&backup, &self.target) { restore_err = format!("；还原备份也失败：{re}"); }
            }
            return Err(format!("无法放置插件文件：{e}{restore_err}"));
        }
        self.advance(TxStage::Swapped)
    }
    pub fn write_state(&mut self, entry: Entry) -> Result<(), String> {
        self.rec.expected_state = Some(normalized(&entry));
        self.advance(TxStage::StateWritten)?;
        load_and_save(&self.root, |st| { st.plugins.insert(self.id.clone(), normalized(&entry)); })
    }
    pub fn commit(&mut self) -> Result<(), String> {
        self.advance(TxStage::Committed)?;
        // 先删记录再清副本：之后崩溃不再需要恢复，残留目录由下次启动清理
        fs::remove_file(tx_path(&self.root, &self.id))
            .map_err(|e| format!("无法删除插件事务记录：{e}"))?;
        cleanup_after_commit(&self.root, &self.id, &self.rec)
    }
    pub fn rollback(&mut self) -> Result<(), String> {
        // 显式回滚复用恢复决策：无法确定时保留记录并由调用方隔离
        recover_one(&self.root, &self.id, &self.rec)?;
        fs::remove_file(tx_path(&self.root, &self.id))
            .map_err(|e| format!("无法删除插件事务记录：{e}"))
    }
}

pub fn begin_install(
    root: &Path,
    id: &str,
    version: &str,
    staging: &Path,
    previous_state: Option<Entry>,
) -> Result<InstallTx, String> {
    let target = checked_version_dir(root, id, version)?;
    let plugin_root = plugin_dir(root, id);
    fs::create_dir_all(&plugin_root).map_err(|e| format!("无法创建插件目录：{e}"))?;
    let new_id = tree_sha256(staging)?;
    let old_id = match identity(&target)? { Some(v) => v, None => String::new() };
    let stage_name = staging_name(staging);
    let rec = TxRecord {
        version: version.to_string(),
        backup: !old_id.is_empty(),
        staging: stage_name.clone(),
        stage: TxStage::Prepared,
        committed: false,
        target_path: format!("{id}/{version}"),
        backup_path: format!("{id}/.old-{version}"),
        staging_path: stage_name,
        old_id,
        new_id: new_id.clone(),
        tree_sha256: new_id,
        previous_state,
        expected_state: None,
    };
    write_tx(root, id, &rec)?;
    Ok(InstallTx { root: root.to_path_buf(), id: id.to_string(), target, rec })
}

pub fn baseline_matches(existing: Option<&Entry>, version: Option<&str>, sha: Option<&str>) -> bool {
    match (existing, version, sha) {
        (None, None, None) => true,
        (Some(e), Some(v), Some(s)) => e.version == v && e.package_sha256.eq_ignore_ascii_case(s),
        _ => false,
    }
}

// 待修复插件不允许启用：修复标记、state 条目里的 repair 字段、内存禁用集合任一命中即拒绝
pub fn can_enable(state: &State, id: &str, has_marker: bool, blocked: bool) -> bool {
    if has_marker || blocked { return false; }
    match state.plugins.get(id) {
        Some(e) => e.repair.is_none(),
        None => false,
    }
}

pub fn valid_sha256(s: &str) -> bool {
    s.len() == 64
        && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || (b'A'..=b'F').contains(&b))
}

// 只保留当前版本目录：storage.json 等文件不在清理范围内
pub fn prune_versions(root: &Path, id: &str, keep: &str) {
    let plugin_root = plugin_dir(root, id);
    let Ok(entries) = fs::read_dir(&plugin_root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name == keep {
            continue;
        }
        if path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

pub fn remove_plugin(root: &Path, id: &str) -> Result<(), String> {
    let dir = plugin_dir(root, id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("无法删除插件目录：{e}"))?;
    }
    Ok(())
}

pub fn valid_storage_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 128 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == ':')
}

fn storage_path(root: &Path, id: &str) -> PathBuf {
    plugin_dir(root, id).join(STORAGE_FILE)
}

pub fn storage_load(root: &Path, id: &str) -> BTreeMap<String, Value> {
    let Ok(raw) = fs::read_to_string(storage_path(root, id)) else { return BTreeMap::new() };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn storage_save(root: &Path, id: &str, map: &BTreeMap<String, Value>) -> Result<(), String> {
    let body = serde_json::to_vec(map).map_err(|e| format!("插件存储序列化失败：{e}"))?;
    write_atomic(&storage_path(root, id), &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ddplug-store-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn manifest_for(files: &[(&str, &[u8])]) -> Manifest {
        let mut integrity = BTreeMap::new();
        for (rel, data) in files {
            integrity.insert(rel.to_string(), sha256_hex(data));
        }
        Manifest {
            schema_version: 1,
            id: "hello".to_string(),
            name: "Hello".to_string(),
            version: "1.0.0".to_string(),
            api_version: 1,
            kind: "web".to_string(),
            entry: "index.html".to_string(),
            icon: None,
            capabilities: vec!["app".to_string()],
            platforms: None,
            native: None,
            integrity,
            homepage: None,
            license: None,
        }
    }

    fn write_files(dir: &Path, files: &[(&str, &[u8])]) {
        for (rel, data) in files {
            let p = dir.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, data).unwrap();
        }
    }

    #[test]
    fn verifies_digests() {
        let dir = tmpdir("verify");
        let m = manifest_for(&[("index.html", b"<h1>x</h1>"), ("js/a.js", b"1")]);
        write_files(&dir, &[("index.html", b"<h1>x</h1>"), ("js/a.js", b"1")]);
        assert!(verify_dir(&dir, &m).unwrap() > 0);
        fs::write(dir.join("js/a.js"), b"2").unwrap();
        assert!(verify_dir(&dir, &m).unwrap_err().contains("sha256"));
        fs::remove_file(dir.join("js/a.js")).unwrap();
        assert!(verify_dir(&dir, &m).unwrap_err().contains("缺少"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn state_roundtrip_and_atomic_replace() {
        let dir = tmpdir("state");
        let mut state = State::default();
        state.plugins.insert(
            "hello".to_string(),
            Entry {
                enabled: true,
                repo: "https://github.com/o/r".to_string(),
                tag: "v1".to_string(),
                version: "1.0.0".to_string(),
                installed_at: 7,
                capabilities: vec!["app".to_string()],
                package_sha256: "a".repeat(64),
                repair: None,
            },
        );
        save_state(&dir, &state).unwrap();
        let back = load_state(&dir);
        assert!(back.plugins["hello"].enabled);
        // 损坏的存档按空处理，不 panic
        fs::write(dir.join(STATE_FILE), b"{not json").unwrap();
        assert!(load_state(&dir).plugins.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    fn write_pkg(dir: &Path, body: &str, caps: &[&str]) -> String {
        let _ = fs::remove_dir_all(dir);
        fs::create_dir_all(dir).unwrap();
        let html = format!("<p>{body}</p>").into_bytes();
        fs::write(dir.join("index.html"), &html).unwrap();
        let m = serde_json::json!({
            "schemaVersion": 1, "id": "hello", "name": "Hello", "version": "1.0.0",
            "apiVersion": 1, "kind": "web", "entry": "index.html",
            "capabilities": caps,
            "integrity": { "index.html": format!("sha256-{}", sha256_hex(&html)) }
        });
        fs::write(dir.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
        tree_sha256(dir).unwrap()
    }
    fn stage_pkg(root: &Path, tag: &str, body: &str) -> PathBuf {
        let dir = root.join(format!(".staging-{tag}"));
        write_pkg(&dir, body, &[]);
        dir
    }
    fn entry(version: &str, sha: char, enabled: bool) -> Entry {
        Entry {
            enabled,
            repo: "https://github.com/o/r".into(),
            tag: "v1".into(),
            version: version.into(),
            installed_at: 7,
            capabilities: vec![],
            package_sha256: sha.to_string().repeat(64),
            repair: None,
        }
    }
    fn seed_state(root: &Path, e: Option<Entry>) {
        let mut st = State::default();
        if let Some(e) = e { st.plugins.insert("hello".to_string(), e); }
        save_state(root, &st).unwrap();
    }
    fn rec(_root: &Path, old_id: &str, new_id: &str, prev: Option<Entry>, exp: Option<Entry>) -> TxRecord {
        TxRecord {
            version: "1.0.0".into(),
            backup: !old_id.is_empty(),
            staging: "stage".into(),
            stage: TxStage::Prepared,
            committed: false,
            target_path: "hello/1.0.0".into(),
            backup_path: "hello/.old-1.0.0".into(),
            staging_path: ".staging-x".into(),
            old_id: old_id.into(),
            new_id: new_id.into(),
            tree_sha256: new_id.into(),
            previous_state: prev,
            expected_state: exp,
        }
    }
    fn put_tx(root: &Path, r: &TxRecord) {
        write_tx(root, "hello", r).unwrap();
    }
    fn setup(tag: &str) -> PathBuf {
        let root = tmpdir(tag);
        fs::create_dir_all(plugin_dir(&root, "hello")).unwrap();
        root
    }
    fn assert_clean(root: &Path) {
        assert!(!tx_path(root, "hello").exists(), "事务记录应已删除");
        assert!(read_repair(root, "hello").is_none(), "不应留下修复标记");
    }

    // 决策表第 1 行：从未安装，记录已写但未换名 → 旧版完整（无），只清 staging
    #[test]
    fn row1_prepared_no_old() {
        let root = setup("row1");
        let staging = stage_pkg(&root, "x", "new");
        let new_id = tree_sha256(&staging).unwrap();
        fs::rename(&staging, root.join(".staging-x")).unwrap();
        seed_state(&root, None);
        put_tx(&root, &rec(&root, "", &new_id, None, None));
        let out = recover_transactions(&root);
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert!(!version_dir(&root, "hello", "1.0.0").exists());
        assert!(!root.join(".staging-x").exists());
        assert!(load_state(&root).plugins.is_empty());
        assert_clean(&root);
        fs::remove_dir_all(&root).unwrap();
    }

    // 决策表第 2 行：旧包仍在 target、备份不存在 → 旧版完整，保留 target
    #[test]
    fn row2_old_at_target() {
        let root = setup("row2");
        let old_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "old", &[]);
        let staging = stage_pkg(&root, "x", "new");
        let new_id = tree_sha256(&staging).unwrap();
        fs::rename(&staging, root.join(".staging-x")).unwrap();
        let old = entry("1.0.0", 'a', true);
        seed_state(&root, Some(old.clone()));
        put_tx(&root, &rec(&root, &old_id, &new_id, Some(old.clone()), None));
        let out = recover_transactions(&root);
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert_eq!(tree_sha256(&version_dir(&root, "hello", "1.0.0")).unwrap(), old_id);
        assert_eq!(load_state(&root).plugins.get("hello"), Some(&old));
        assert!(!root.join(".staging-x").exists());
        assert_clean(&root);
        fs::remove_dir_all(&root).unwrap();
    }

    // 决策表第 3 行：旧目录已移到备份、新包尚未就位 → 还原备份到 target
    #[test]
    fn row3_old_in_backup() {
        let root = setup("row3");
        let old_id = write_pkg(&plugin_dir(&root, "hello").join(".old-1.0.0"), "old", &[]);
        let staging = stage_pkg(&root, "x", "new");
        let new_id = tree_sha256(&staging).unwrap();
        fs::rename(&staging, root.join(".staging-x")).unwrap();
        let old = entry("1.0.0", 'a', true);
        seed_state(&root, Some(old.clone()));
        put_tx(&root, &rec(&root, &old_id, &new_id, Some(old.clone()), None));
        let out = recover_transactions(&root);
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert_eq!(tree_sha256(&version_dir(&root, "hello", "1.0.0")).unwrap(), old_id, "备份要改回 target");
        assert!(!plugin_dir(&root, "hello").join(".old-1.0.0").exists());
        assert_eq!(load_state(&root).plugins.get("hello"), Some(&old));
        assert_clean(&root);
        fs::remove_dir_all(&root).unwrap();
    }

    // 决策表第 4 行：新版完整且 state 已是新 → 补完清理
    #[test]
    fn row4_new_with_new_state() {
        let root = setup("row4");
        let old_id = write_pkg(&plugin_dir(&root, "hello").join(".old-1.0.0"), "old", &[]);
        let new_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &["app"]);
        fs::create_dir_all(root.join(".staging-x")).unwrap();
        let old = entry("1.0.0", 'a', true);
        let new = entry("1.0.0", 'b', true);
        seed_state(&root, Some(new.clone()));
        put_tx(&root, &rec(&root, &old_id, &new_id, Some(old), Some(new.clone())));
        let out = recover_transactions(&root);
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert_eq!(tree_sha256(&version_dir(&root, "hello", "1.0.0")).unwrap(), new_id);
        assert!(!plugin_dir(&root, "hello").join(".old-1.0.0").exists());
        assert!(!root.join(".staging-x").exists());
        assert_eq!(load_state(&root).plugins.get("hello"), Some(&new));
        assert_clean(&root);
        fs::remove_dir_all(&root).unwrap();
    }

    // 决策表第 5 行：新版完整但 state 是旧 → 回滚到旧版（不能让旧授权配新 manifest）
    #[test]
    fn row5_new_with_old_state_rolls_back() {
        let root = setup("row5");
        let old_id = write_pkg(&plugin_dir(&root, "hello").join(".old-1.0.0"), "old", &[]);
        write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &["app"]);
        let new_id = tree_sha256(&version_dir(&root, "hello", "1.0.0")).unwrap();
        fs::create_dir_all(root.join(".staging-x")).unwrap();
        let old = entry("1.0.0", 'a', true);
        seed_state(&root, Some(old.clone()));
        put_tx(&root, &rec(&root, &old_id, &new_id, Some(old.clone()), Some(entry("1.0.0", 'b', true))));
        let out = recover_transactions(&root);
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert_eq!(tree_sha256(&version_dir(&root, "hello", "1.0.0")).unwrap(), old_id, "必须换回旧包");
        assert_eq!(load_state(&root).plugins.get("hello"), Some(&old));
        assert!(!root.join(".staging-x").exists());
        assert_clean(&root);
        fs::remove_dir_all(&root).unwrap();
    }

    // 决策表第 6 行：首次安装（无旧版）且 state 已新 → 补完清理
    #[test]
    fn row6_fresh_new_state() {
        let root = setup("row6");
        let new_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &["app"]);
        fs::create_dir_all(root.join(".staging-x")).unwrap();
        let new = entry("1.0.0", 'b', true);
        seed_state(&root, Some(new.clone()));
        put_tx(&root, &rec(&root, "", &new_id, None, Some(new.clone())));
        let out = recover_transactions(&root);
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert_eq!(tree_sha256(&version_dir(&root, "hello", "1.0.0")).unwrap(), new_id);
        assert_eq!(load_state(&root).plugins.get("hello"), Some(&new));
        assert!(!root.join(".staging-x").exists());
        assert_clean(&root);
        fs::remove_dir_all(&root).unwrap();
    }

    // 决策表第 7 行：首次安装但 state 仍旧 → 移除新包与条目
    #[test]
    fn row7_fresh_old_state_removes() {
        let root = setup("row7");
        let new_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &["app"]);
        fs::create_dir_all(root.join(".staging-x")).unwrap();
        seed_state(&root, None);
        put_tx(&root, &rec(&root, "", &new_id, None, Some(entry("1.0.0", 'b', true))));
        let out = recover_transactions(&root);
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert!(!version_dir(&root, "hello", "1.0.0").exists(), "新包应被移除");
        assert!(load_state(&root).plugins.is_empty());
        assert!(!root.join(".staging-x").exists());
        assert_clean(&root);
        fs::remove_dir_all(&root).unwrap();
    }

    // 决策表第 8 行：身份对不上 → 不删任何副本，隔离为待修复
    #[test]
    fn row8_unknown_isolates_without_deleting() {
        let root = setup("row8");
        let old_id = write_pkg(&plugin_dir(&root, "hello").join(".old-1.0.0"), "old", &[]);
        let new_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &["app"]);
        fs::write(version_dir(&root, "hello", "1.0.0").join("index.html"), b"tampered").unwrap();
        fs::create_dir_all(root.join(".staging-x")).unwrap();
        fs::write(root.join(".staging-x/keep.txt"), b"keep").unwrap();
        let old = entry("1.0.0", 'a', true);
        seed_state(&root, Some(old));
        put_tx(&root, &rec(&root, &old_id, &new_id, None, None));
        let out = recover_transactions(&root);
        assert_eq!(out.problems.len(), 1, "{:?}", out.problems);
        assert_eq!(out.problems[0].id, "hello");
        assert!(version_dir(&root, "hello", "1.0.0").exists(), "target 不能删");
        assert!(plugin_dir(&root, "hello").join(".old-1.0.0").exists(), "backup 不能删");
        assert!(root.join(".staging-x/keep.txt").exists(), "staging 不能删");
        assert!(tx_path(&root, "hello").exists(), "事务记录要保留");
        assert!(read_repair(&root, "hello").is_some(), "写 .repair.json");
        assert_eq!(load_state(&root).plugins["hello"].enabled, false, "停用");
        assert_eq!(load_state(&root).plugins["hello"].repair.as_deref(), Some(out.problems[0].reason.as_str()));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn tree_identity_covers_manifest_and_unlisted_files() {
        let root = setup("tree-id");
        let a = root.join("a");
        let b = root.join("b");
        let id_a = write_pkg(&a, "same", &[]);
        let id_b = write_pkg(&b, "same", &["app"]);
        assert_ne!(id_a, id_b, "manifest.json 能力不同必须产生不同身份");
        fs::write(b.join("extra.txt"), b"x").unwrap();
        assert_ne!(id_b, tree_sha256(&b).unwrap(), "integrity 未列出的文件也要计入");
        assert_eq!(id_a, tree_sha256(&a).unwrap(), "身份稳定");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn has_repair_and_can_enable_are_hard_gates() {
        let root = setup("gate");
        let mut st = State::default();
        st.plugins.insert("hello".into(), entry("1.0.0", 'a', true));
        assert!(!has_repair(&root, &st, "hello"));
        assert!(can_enable(&st, "hello", false, false));
        st.plugins.get_mut("hello").unwrap().repair = Some("bad".into());
        assert!(has_repair(&root, &st, "hello"));
        assert!(!can_enable(&st, "hello", false, false));
        st.plugins.get_mut("hello").unwrap().repair = None;
        write_repair(&root, "hello", "bad", TxStage::Swapped).unwrap();
        assert!(has_repair(&root, &st, "hello"));
        assert!(!can_enable(&st, "hello", true, false));
        assert!(!can_enable(&st, "hello", false, true));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn both_isolation_writes_failing_are_remembered_in_memory() {
        let root = setup("both-fail");
        // .repair.json 是一个目录 → write_repair 失败
        fs::create_dir_all(plugin_dir(&root, "hello").join(".repair.json")).unwrap();
        // state.json 是一个目录 → save_state 失败
        fs::create_dir_all(root.join("state.json")).unwrap();
        let r = rec(&root, "old".into(), "new".into(), None, None);
        put_tx(&root, &r);
        let out = recover_transactions(&root);
        assert_eq!(out.problems.len(), 1);
        assert_eq!(out.blocked, vec!["hello".to_string()], "两处都失败要在内存里记住");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn version_paths_cannot_escape_the_plugin_dir() {
        let root = tmpdir("version-path");
        assert!(checked_version_dir(&root, "hello", "1.0.0-x/../../other").is_err());
        assert!(checked_version_dir(&root, "hello", "../evil").is_err());
        assert!(begin_install(&root, "hello", "1.0.0-x/../../other", &root.join("staging"), None).is_err());
        let dir = version_dir(&root, "hello", "1.0.0-x/../../other");
        assert_eq!(dir, plugin_dir(&root, "hello").join(".invalid-version"));
        let ok = checked_version_dir(&root, "hello", "1.0.0-beta.1+sha.7").unwrap();
        assert_eq!(ok.parent(), Some(plugin_dir(&root, "hello").as_path()));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn state_updates_are_serialized_across_threads() {
        let root = tmpdir("state-lock");
        let lock = std::sync::Mutex::new(());
        let shared = std::sync::Arc::new((root.clone(), lock));
        let mut handles = Vec::new();
        for i in 0..8 {
            let shared = shared.clone();
            handles.push(std::thread::spawn(move || {
                let (root, lock) = &*shared;
                update_state(root, lock, |st| {
                    st.plugins.insert(format!("p{i}"), entry("1.0.0", 'a', true));
                })
                .unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(load_state(&root).plugins.len(), 8, "并发写不能互相覆盖");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn baseline_and_sha256_checks() {
        assert!(valid_sha256(&"a".repeat(64)));
        assert!(valid_sha256(&"A".repeat(64)));
        assert!(!valid_sha256(""));
        assert!(!valid_sha256(&"a".repeat(63)));
        assert!(!valid_sha256(&("g".repeat(63) + "a")));
        let e = entry("1.0.0", 'b', true);
        assert!(baseline_matches(None, None, None));
        assert!(baseline_matches(Some(&e), Some("1.0.0"), Some(&"B".repeat(64))));
        assert!(!baseline_matches(Some(&e), Some("1.0.0"), Some(&"c".repeat(64))));
        assert!(!baseline_matches(Some(&e), Some("2.0.0"), Some(&"b".repeat(64))));
        assert!(!baseline_matches(Some(&e), None, None));
        assert!(!baseline_matches(None, Some("1.0.0"), Some(&"b".repeat(64))));
    }

    #[test]
    fn cross_process_file_lock_is_exclusive() {
        let root = tmpdir("file-lock");
        fs::create_dir_all(&root).unwrap();
        let _guard = file_lock(&root).unwrap();
        let second = fs::OpenOptions::new().create(true).read(true).write(true).open(root.join(".lock")).unwrap();
        assert!(fs2::FileExt::try_lock_exclusive(&second).is_err(), "第二个句柄不能同时拿到锁");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn storage_keys_are_restricted() {
        assert!(valid_storage_key("a.b_c-d:1"));
        assert!(!valid_storage_key(""));
        assert!(!valid_storage_key("../x"));
        assert!(!valid_storage_key("a/b"));
    }

    #[test]
    fn storage_roundtrip() {
        let root = tmpdir("storage");
        fs::create_dir_all(plugin_dir(&root, "hello")).unwrap();
        let mut map = BTreeMap::new();
        map.insert("count".to_string(), serde_json::json!(3));
        storage_save(&root, "hello", &map).unwrap();
        assert_eq!(storage_load(&root, "hello")["count"], serde_json::json!(3));
        fs::remove_dir_all(&root).unwrap();
    }
}
