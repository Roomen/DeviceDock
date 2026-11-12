// 插件落盘：plugins/<id>/<version>/ 是包内容，plugins/<id>/storage.json 是插件私有存储，
// plugins/state.json 记启用状态、来源与安装摘要。写入一律「同目录临时文件 + 原子替换」。
use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::fs;
use std::io::{Read, Write};
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

#[allow(dead_code)] // 单测里验证并发写串行化；命令路径改用「持锁 + load_and_save」
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
// 身份计算（tree_sha256）超限 / 读失败 → Identity::Unknown，无法匹配任何 Known 行，落到第 8 行隔离。
// 已提交残留（唯一可验证的提交证据）：commit() 先把记录改写成 stage=committed（记录里带 target 的身份
// new_id），再删 .old-* 备份，最后才删记录。启动时只有「记录 stage=committed 且当前 target 身份 == new_id」
// 才删 .old-* 与记录；身份不符 → 隔离。**没有任何事务记录的 .old-* 一律保留**（只记日志），
// 不再凭「同名 target 能算摘要」删除；事务记录损坏时本轮不删任何 staging 与 .old-*。
// 事务期间读路径：mod.rs 的 ActiveGuard 把 id 登记进 PluginsState.active，plugin_list 标 installing / enabled=false，scheme::serve_gated 返回 503；安装失败在释放锁前调用 finalize_failed_install 复用本表恢复或隔离，staging 是否删除完全由决策结果决定。
// staging 所有权：目录名带 pid + 随机后缀，内部 owner.json 记 pid/createdAt，同级 .lock 由创建进程持有到进程结束；启动清理（cleanup_staging）只删「无事务引用 + owner 可读 + 进程已不存在 + 超过 15 分钟 + 锁未被持有」的 staging，其余保留。创建与解压都在跨进程锁内。
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
    // 备份是否由**本事务**创建（swap 里把 target 改名为备份成功后才置 true 并落盘），
    // 以及那份备份的身份摘要。清理只删「本事务创建 + 身份一致」的备份。
    #[serde(default)]
    pub backup_created: bool,
    #[serde(default)]
    pub backup_identity: String,
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

// ---------- 读锁（跨进程共享） ----------
// 读路径（plugin_list / ddplugin://）在**整个读取过程**里持有同一把 .lock 的共享锁；
// 安装 / 卸载 / 启用切换持排他锁。拿不到共享锁说明有进程正在改目录，调用方按「正在安装」处理。
pub const READ_LOCK_WAIT_MS: u64 = 120;
pub const READ_LOCK_POLL_MS: u64 = 8;

fn open_lock_file(root: &Path) -> Result<fs::File, String> {
    fs::create_dir_all(root).map_err(|e| format!("无法创建插件目录：{e}"))?;
    fs::OpenOptions::new()
        .create(true).read(true).write(true)
        .open(root.join(LOCK_FILE))
        .map_err(|e| format!("无法打开插件事务锁：{e}"))
}

// 短等待后仍拿不到共享锁就返回 Err（调用方回 503 / 标 installing），绝不无限阻塞读路径
pub fn read_lock(root: &Path) -> Result<FileLock, String> {
    let file = open_lock_file(root)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(READ_LOCK_WAIT_MS);
    loop {
        match fs2::FileExt::try_lock_shared(&file) {
            Ok(()) => return Ok(FileLock { _file: file }),
            Err(e) => {
                if std::time::Instant::now() >= deadline {
                    return Err(format!("插件正在被修改，稍后重试：{e}"));
                }
                std::thread::sleep(std::time::Duration::from_millis(READ_LOCK_POLL_MS));
            }
        }
    }
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

// 目录身份：递归收集**全部文件**（含 manifest.json、含 integrity 未列出的文件），按相对路径排序。
// 逐文件用固定缓冲流式读取，文件数与总字节上限与安装包一致；超限直接报错 → 身份未知 → 决策表第 8 行。
pub fn tree_sha256(dir: &Path) -> Result<String, String> {
    tree_sha256_limited(dir, manifest::MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES)
}

// 上限可注入，便于单测覆盖文件数 / 单文件 / 总量三条上限，不必真的写 64 MiB。
fn tree_sha256_limited(dir: &Path, max_files: usize, max_file_bytes: u64, max_total_bytes: u64) -> Result<String, String> {
    let mut files: Vec<String> = Vec::new();
    collect_files(dir, dir, &mut files, max_files)?;
    files.sort();
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let mut buf = [0u8; 64 * 1024];
    for rel in &files {
        let path = dir.join(rel);
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("无法读取包内文件 {rel}：{e}"))?;
        // 便宜的前置判断（只挡明显超限，避免为超大文件读盘）
        if meta.len() > max_file_bytes { return Err(format!("包内文件过大，身份未知：{rel}")); }
        if total.saturating_add(meta.len()) > max_total_bytes {
            return Err("包内容量超限，身份未知".to_string());
        }
        // 上限按**实际读到的字节**判定：文件在读取期间增长时，metadata 的旧长度不能作数
        let (read_bytes, digest) = hash_file_limited(&path, &mut buf, max_file_bytes, total, max_total_bytes)?;
        total = total.saturating_add(read_bytes);
        hasher.update(rel.as_bytes());
        hasher.update(b":");
        hasher.update(read_bytes.to_string().as_bytes());
        hasher.update(b":");
        hasher.update(digest.as_bytes());
        hasher.update(b";");
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

// 逐文件流式读取并按**实际读到的字节**执行上限：already_total 是其它文件已计入的字节，
// 本文件读到的字节逐块累加，任一时刻超过单文件或总量上限立即返回 Err。
// 返回 (实际字节数, 内容摘要)。
fn hash_file_limited(
    path: &Path,
    buf: &mut [u8],
    max_file_bytes: u64,
    already_total: u64,
    max_total_bytes: u64,
) -> Result<(u64, String), String> {
    let rel = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut file = fs::File::open(path).map_err(|e| format!("无法打开包内文件 {rel}：{e}"))?;
    let mut fh = Sha256::new();
    let mut read_bytes: u64 = 0;
    loop {
        let got = file.read(buf).map_err(|e| format!("无法读取包内文件 {rel}：{e}"))?;
        if got == 0 { break; }
        read_bytes = read_bytes.saturating_add(got as u64);
        if read_bytes > max_file_bytes { return Err(format!("包内文件过大，身份未知：{rel}")); }
        if already_total.saturating_add(read_bytes) > max_total_bytes {
            return Err("包内容量超限，身份未知".to_string());
        }
        fh.update(&buf[..got]);
    }
    let digest = fh.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok((read_bytes, digest))
}

fn collect_files(base: &Path, dir: &Path, out: &mut Vec<String>, max_files: usize) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("无法读取插件目录：{e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("无法读取插件目录：{e}"))?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("无法读取插件文件：{e}"))?;
        if meta.file_type().is_symlink() { return Err("包内不允许符号链接".to_string()); }
        if meta.is_dir() { collect_files(base, &path, out, max_files)?; continue; }
        if !meta.is_file() { return Err("包内有非普通文件".to_string()); }
        let rel = path.strip_prefix(base).map_err(|e| format!("包内路径异常：{e}"))?
            .to_string_lossy().replace(char::from(92), "/");
        out.push(rel);
        if out.len() > max_files { return Err("包内文件过多，身份未知".to_string()); }
    }
    Ok(())
}

// 身份三态：缺失 / 已确认 / 未知（超限、非普通文件、读取失败）。Unknown 绝不参与匹配。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Identity { Missing, Known(String), Unknown }

fn identity(path: &Path) -> Identity {
    if !path.exists() { return Identity::Missing; }
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Identity::Unknown,
        Err(_) => return Identity::Unknown,
    }
    match tree_sha256(path) {
        Ok(v) => Identity::Known(v),
        Err(e) => { eprintln!("插件目录身份未知：{e}"); Identity::Unknown }
    }
}

fn id_is(i: &Identity, want: &str) -> bool {
    !want.is_empty() && matches!(i, Identity::Known(s) if s == want)
}
fn id_missing(i: &Identity) -> bool { matches!(i, Identity::Missing) }

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

// 本事务「登记在案」的副本路径：target、backup、staging，以及升级前的旧版本目录
// （旧版本只从 previous_state.version 取得，不扫目录）。清理**只**动这些路径。
fn registered_paths(root: &Path, id: &str, rec: &TxRecord) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = stored_path(root, &rec.target_path) { out.push(p); }
    // 备份只有「本事务创建」时才算登记在案的副本；别人留下的 .old-* 不进清单
    if rec.backup_created {
        if let Ok(p) = stored_path(root, &rec.backup_path) { out.push(p); }
    }
    if !rec.staging_path.is_empty() {
        if let Ok(p) = stored_path(root, &rec.staging_path) { out.push(p); }
    }
    if let Some(prev) = &rec.previous_state {
        if !prev.version.is_empty() && prev.version != rec.version && manifest::valid_version(&prev.version) {
            out.push(version_dir(root, id, &prev.version));
        }
    }
    out
}

// 提交后的清理：只删本事务登记的 backup / staging / 旧版本目录，绝不按插件 id 扫目录。
// 记录之外的孤立 .old-* 与未登记目录一律保留（report_orphan_backups 只记日志）。
// 测试探针：只用于证明「清理发生在记录已落盘为 committed 之后」。
// 仅在 cfg(test) 下存在，产品构建里没有这些静态变量与分支。
#[cfg(test)]
pub(crate) mod cleanup_probe {
    // thread_local：cargo test 默认多线程跑，探针必须按线程隔离，否则互相覆盖
    use std::cell::Cell;
    thread_local! {
        static ARM: Cell<bool> = Cell::new(false);
        static FAIL: Cell<bool> = Cell::new(false);
        static SAW_COMMITTED: Cell<bool> = Cell::new(false);
        #[allow(dead_code)]
        static SAW_BACKUP: Cell<bool> = Cell::new(false);
    }
    pub fn reset() {
        ARM.with(|c| c.set(false));
        FAIL.with(|c| c.set(false));
        SAW_COMMITTED.with(|c| c.set(false));
        SAW_BACKUP.with(|c| c.set(false));
    }
    pub fn arm(fail_cleanup: bool) {
        ARM.with(|c| c.set(true));
        FAIL.with(|c| c.set(fail_cleanup));
    }
    pub fn armed() -> bool { ARM.with(|c| c.get()) }
    pub fn should_fail() -> bool { FAIL.with(|c| c.get()) }
    pub fn saw_committed() -> bool { SAW_COMMITTED.with(|c| c.get()) }
    #[allow(dead_code)]
    pub fn saw_backup() -> bool { SAW_BACKUP.with(|c| c.get()) }
    pub fn record(committed: bool, backup_exists: bool) {
        SAW_COMMITTED.with(|c| c.set(committed));
        SAW_BACKUP.with(|c| c.set(backup_exists));
    }
}

fn cleanup_after_commit(root: &Path, id: &str, rec: &TxRecord) -> Result<(), String> {
    #[cfg(test)]
    if cleanup_probe::armed() {
        let committed = read_tx(&tx_path(root, id)).map(|r| r.stage == TxStage::Committed).unwrap_or(false);
        let backup_exists = stored_path(root, &rec.backup_path).map(|p| p.exists()).unwrap_or(false);
        cleanup_probe::record(committed, backup_exists);
        if cleanup_probe::should_fail() {
            return Err("注入的清理失败".to_string());
        }
    }
    let target = stored_path(root, &rec.target_path)?;
    let backup = stored_path(root, &rec.backup_path)?;
    for path in registered_paths(root, id, rec) {
        if path == target || !path.exists() || !path.is_dir() { continue; }
        if path == backup {
            // 只有「本事务创建」且身份仍等于记录里的 backup_identity 才删；否则保留并记日志
            if !rec.backup_created {
                eprintln!("保留非本事务创建的备份 {}", path.display());
                continue;
            }
            let same = matches!(identity(&path), Identity::Known(v) if v == rec.backup_identity);
            if !same {
                eprintln!("保留身份不一致的备份 {}（记录 {:?}）", path.display(), rec.backup_identity);
                continue;
            }
        }
        fs::remove_dir_all(&path).map_err(|e| format!("无法删除本事务登记的副本 {}：{e}", path.display()))?;
    }
    if !rec.staging_path.is_empty() {
        forget_staging_lock(&rec.staging_path);
        let _ = fs::remove_file(staging_lock_path(root, &rec.staging_path));
    }
    Ok(())
}

fn remove_staging(root: &Path, rec: &TxRecord) -> Result<(), String> {
    if !rec.staging_path.is_empty() {
        let st = stored_path(root, &rec.staging_path)?;
        if st.exists() { fs::remove_dir_all(&st).map_err(|e| format!("无法删除插件临时目录：{e}"))?; }
        forget_staging_lock(&rec.staging_path);
        let _ = fs::remove_file(staging_lock_path(root, &rec.staging_path));
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

fn decide(rec: &TxRecord, t: &Identity, b: &Identity, st: StateClass) -> Recovery {
    if matches!(t, Identity::Unknown) || matches!(b, Identity::Unknown) {
        return Recovery::Isolate; // 8：身份未知，不删任何副本
    }
    let new_id = rec.new_id();
    let has_old = !rec.old_id.is_empty();
    let t_is_new = id_is(t, new_id);
    let t_is_old = id_is(t, &rec.old_id);
    let b_is_old = id_is(b, &rec.old_id);
    if st == StateClass::Old {
        if !has_old && id_missing(t) && id_missing(b) { return Recovery::RestoreOld { from_backup: false }; } // 1
        if has_old && t_is_old && id_missing(b) { return Recovery::RestoreOld { from_backup: false }; } // 2
        if has_old && id_missing(t) && b_is_old { return Recovery::RestoreOld { from_backup: true }; } // 3
    }
    if t_is_new {
        if has_old && b_is_old {
            if st == StateClass::New { return Recovery::FinishNew; } // 4
            if st == StateClass::Old { return Recovery::RollbackNew { has_old: true }; } // 5
        }
        if !has_old && id_missing(b) {
            if st == StateClass::New { return Recovery::FinishNew; } // 6
            if st == StateClass::Old { return Recovery::RollbackNew { has_old: false }; } // 7
        }
    }
    Recovery::Isolate // 8
}

fn recover_one(root: &Path, id: &str, rec: &TxRecord) -> Result<(), String> {
    let target = stored_path(root, &rec.target_path)?;
    let t_commit = identity(&target);
    // stage=committed 是显式的提交证据：只有当前 target 身份与记录里的 new_id 一致，
    // 才能确认「要删的 .old-* 确实属于已提交的这一版」，否则隔离并保留全部副本。
    if rec.stage == TxStage::Committed {
        if !id_is(&t_commit, rec.new_id()) {
            return Err("已提交事务的 target 身份与记录不一致，保留备份等待修复".to_string());
        }
        cleanup_after_commit(root, id, rec)?;
        return Ok(());
    }
    let backup = stored_path(root, &rec.backup_path)?;
    let staging = if rec.staging_path.is_empty() { None } else { Some(stored_path(root, &rec.staging_path)?) };
    let _ = staging;
    let t = t_commit;
    let b = identity(&backup);
    let st = state_class(root, id, rec);
    match decide(rec, &t, &b, st) {
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
            // state 已是新的，按 commit() 的三步顺序补完：先把记录推进成 committed 并落盘，
            // 再做清理，最后由调用方删记录。落盘失败就返回 Err 走隔离（副本一律保留）。
            let mut committed = rec.clone();
            committed.stage = TxStage::Committed;
            committed.committed = true;
            write_tx(root, id, &committed)?;
            // 清理范围限于本记录登记的路径，孤立 .old-* 与未登记目录不碰。
            cleanup_after_commit(root, id, &committed)?;
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
    // 有事务记录损坏时无法确认它引用了哪个 staging / 备份：本轮一律不删，只隔离
    let mut corrupt = false;
    for entry in entries.flatten() {
        if !entry.path().is_dir() { continue; }
        let id = entry.file_name().to_string_lossy().to_string();
        let tp = tx_path(root, &id);
        if !tp.exists() { continue; }
        let rec = match read_tx(&tp) {
            Ok(r) => r,
            Err(e) => {
                corrupt = true;
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
    if corrupt {
        eprintln!("存在无法解析的插件事务记录：本轮不清理任何 staging 与 .old-* 备份");
    } else {
        cleanup_staging(root, &active_staging);
    }
    // 没有事务记录的 .old-* 一律保留（只记日志）；清理只发生在 committed 记录的身份复核之后
    report_orphan_backups(root);
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
            // 正常情况已在 begin_install 里拦下（不写记录）；这里只是兜底，不改任何状态。
            if backup.exists() {
                return Err(format!(
                    "存在未确认的旧备份 {}：确认不再需要后手工删除该目录，再重新安装",
                    backup.display()
                ));
            }
            if let Err(e) = fs::rename(&self.target, &backup) {
                let restore = fs::rename(&backup, &self.target);
                if self.target.exists() || restore.is_ok() { return Err(format!("无法替换已有插件版本：{e}")); }
                return Err(format!("无法替换已有插件版本：{e}；还原备份也失败：{restore:?}"));
            }
            // 把 target 改名为备份**成功之后**才认领这份备份，并记下它的身份。
            // 身份直接沿用 begin_install 时算好的 old_id（就是被移走的那个目录），
            // 避免再读一遍磁盘；落盘失败则回退这次改名，不让记录与实际不一致。
            self.rec.backup_created = true;
            self.rec.backup_identity = self.rec.old_id.clone();
            if let Err(e) = write_tx(&self.root, &self.id, &self.rec) {
                self.rec.backup_created = false;
                self.rec.backup_identity.clear();
                let restore = fs::rename(&backup, &self.target);
                if restore.is_err() {
                    // 记录没写下、改名也没退回：保留事务记录（未认领备份），交给决策表第 8 行隔离
                    let _ = write_tx(&self.root, &self.id, &self.rec);
                    return Err(format!("无法记录备份所有权：{e}；还原备份也失败：{restore:?}"));
                }
                return Err(format!("无法记录备份所有权：{e}"));
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
        // 1) 记录改写成 stage=committed，内含 target 身份 new_id（可验证的提交证据）
        self.advance(TxStage::Committed)?;
        // 2) 依据这份证据清理副本
        cleanup_after_commit(&self.root, &self.id, &self.rec)?;
        // 3) 最后才删记录：在这之前崩溃，下次启动能凭 committed + new_id 复核后再清理
        fs::remove_file(tx_path(&self.root, &self.id))
            .map_err(|e| format!("无法删除插件事务记录：{e}"))
    }
    #[allow(dead_code)] // 保留显式回滚入口；安装失败统一走 finalize_failed_install 的决策表
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
    // 冲突检查必须在写事务记录**之前**：不论 target 是否存在，只要已有同名 .old-<version>
    // 就说明有一份没有本事务提交证据的旧备份。此时不动事务记录、不写 .repair.json、
    // 不改 state、不碰 target 与备份，只让调用方释放本次 staging。
    let backup_path = plugin_root.join(format!(".old-{version}"));
    if backup_path.exists() {
        return Err(format!(
            "存在未确认的旧备份 {}：确认不再需要后手工删除该目录，再重新安装",
            backup_path.display()
        ));
    }
    let new_id = tree_sha256(staging)?;
    let old_id = match identity(&target) {
        Identity::Known(v) => v,
        Identity::Missing => String::new(),
        Identity::Unknown => return Err("现有插件目录身份未知，拒绝覆盖安装".to_string()),
    };
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
        // 备份要在 swap 真正把 target 改名成功之后才认领；这里一律 false
        backup_created: false,
        backup_identity: String::new(),
        previous_state,
        expected_state: None,
    };
    write_tx(root, id, &rec)?;
    Ok(InstallTx { root: root.to_path_buf(), id: id.to_string(), target, rec })
}


// ---------- staging 跨进程所有权 ----------
// staging 目录名带 pid + 随机后缀；所有权元数据一律放在**包目录之外**的同级兄弟文件
// <staging 名>.owner.json（记 { pid, createdAt }）与 <staging 名>.lock（由创建进程排他持有到进程结束）。
// 包目录里不写任何宿主文件：插件包自带 owner.json 时不会被覆盖，integrity 摘要安装后仍然成立。
//
// 判定「所有者进程已不存在」的判据：
// - Unix：kill(pid, 0) 返回 0 或 EPERM（权限不足）都视为存活 / 无法确认 → 保留；只有 ESRCH 才算进程已退出。
// - Windows：不实现 pid 查询，唯一判据是「同级 .lock 未被任何进程持有」（文件锁随进程退出由系统释放）。
const STAGING_OWNER_SUFFIX: &str = ".owner.json";
const STAGING_MAX_AGE_SECS: u64 = 15 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingOwner {
    pub pid: u32,
    pub created_at: u64,
}

static STAGING_LOCKS: OnceLock<std::sync::Mutex<Vec<(String, FileLock)>>> = OnceLock::new();

fn staging_locks() -> &'static std::sync::Mutex<Vec<(String, FileLock)>> {
    STAGING_LOCKS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

pub fn lock_file(path: &Path) -> Result<FileLock, String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("无法创建插件目录：{e}"))?;
    }
    let file = fs::OpenOptions::new()
        .create(true).read(true).write(true)
        .open(path)
        .map_err(|e| format!("无法打开 staging 所有权锁：{e}"))?;
    fs2::FileExt::lock_exclusive(&file).map_err(|e| format!("无法取得 staging 所有权锁：{e}"))?;
    Ok(FileLock { _file: file })
}

fn staging_lock_path(root: &Path, name: &str) -> PathBuf {
    root.join(format!("{name}.lock"))
}

fn staging_owner_path(root: &Path, name: &str) -> PathBuf {
    root.join(format!("{name}{STAGING_OWNER_SUFFIX}"))
}

// 所有权文件在包目录之外（root/<staging 名>.owner.json），包内容不会被宿主写入
pub fn read_staging_owner(root: &Path, name: &str) -> Option<StagingOwner> {
    let raw = fs::read_to_string(staging_owner_path(root, name)).ok()?;
    serde_json::from_str(&raw).ok()
}

// 必须在跨进程事务锁内调用：创建 staging、写 owner.json、进程级持有 .lock。
pub fn create_staging(root: &Path) -> Result<PathBuf, String> {
    let mut suffix = [0u8; 8];
    getrandom::fill(&mut suffix).map_err(|_| "系统熵源不可用".to_string())?;
    let name = format!(".staging-{}-{}", std::process::id(), suffix.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let dir = root.join(&name);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建临时目录：{e}"))?;
    let lock = lock_file(&staging_lock_path(root, &name))?;
    staging_locks().lock().map(|mut v| v.push((name, lock))).map_err(|_| "staging 所有权表被占用".to_string())?;
    Ok(dir)
}

// 解压与逐文件校验完成后写同级 <staging 名>.owner.json（包目录之外，不污染包内容）。
// 崩溃在写它之前时，启动清理因「归属不明」而保留该 staging，不会误删在用副本。
pub fn seal_staging(root: &Path, staging: &Path) -> Result<(), String> {
    let name = staging.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if name.is_empty() { return Err("staging 目录名无效".to_string()); }
    let owner = StagingOwner { pid: std::process::id(), created_at: now_unix() };
    let body = serde_json::to_vec(&owner).map_err(|e| format!("staging 所有权序列化失败：{e}"))?;
    write_atomic(&staging_owner_path(root, name), &body)
}

fn forget_staging_lock(name: &str) {
    if let Ok(mut v) = staging_locks().lock() { v.retain(|(n, _)| n != name); }
}

// staging 已被换名成 target 后，只释放所有权锁 / 删同级锁文件，不动目录。
pub fn release_staging(root: &Path, staging: &Path) {
    let name = staging.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
    forget_staging_lock(&name);
    let _ = fs::remove_file(staging_lock_path(root, &name));
    let _ = fs::remove_file(staging_owner_path(root, &name));
}

// 本进程主动丢弃自己的 staging（inspect / check_update / 解压失败）：释放锁并删目录与同级锁文件。
pub fn drop_staging(root: &Path, staging: &Path) {
    release_staging(root, staging);
    let _ = fs::remove_dir_all(staging);
}

// pid 判据策略：Unix 有可靠的「进程是否还在」探测，Windows 不另实现 pid 查询
// （只用同级 .lock 是否被持有 + 超过 15 分钟判定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PidPolicy {
    Unix,
    Windows,
}

fn current_pid_policy() -> PidPolicy {
    if cfg!(windows) { PidPolicy::Windows } else { PidPolicy::Unix }
}

// 纯函数（可注入，便于跨平台单测）：超过 15 分钟 + 锁未被任何进程持有，
// 且（Unix 分支）pid 已明确退出，才认为该 staging 可清理。
fn reclaimable(age_secs: u64, policy: PidPolicy, pid_gone: bool, lock_held: bool) -> bool {
    if age_secs <= STAGING_MAX_AGE_SECS { return false; }
    if lock_held { return false; }
    match policy {
        // Unix：EPERM / 其它错误都按「无法确认」= 仍活跃（pid_gone=false）→ 保留
        PidPolicy::Unix => pid_gone,
        // Windows：跳过 pid 判据，只靠锁 + 时间
        PidPolicy::Windows => true,
    }
}

// 只有明确 ESRCH（进程不存在）才返回 true；EPERM（权限不足）与其它错误都按「无法确认」= 存活处理。
#[cfg(unix)]
fn pid_definitely_gone(pid: u32) -> bool {
    if unsafe { libc::kill(pid as i32, 0) } == 0 {
        return false;
    }
    // 用 std 取 errno：macOS 是 __error()、Linux 是 __errno_location()，std 已封装
    std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn pid_definitely_gone(_pid: u32) -> bool {
    // Windows / 其它平台不做 pid 查询；判定完全交给 reclaimable 的 PidPolicy::Windows 分支
    false
}

fn lock_is_held(root: &Path, name: &str) -> bool {
    match fs::OpenOptions::new().create(true).read(true).write(true).open(staging_lock_path(root, name)) {
        Ok(f) => fs2::FileExt::try_lock_exclusive(&f).is_err(),
        Err(_) => true, // 无法确认 → 当作被持有（保留）
    }
}

// 启动清理（持跨进程锁）：只删「事务记录明确引用且决策允许」（由 recover_one 负责）
// 或「owner.json 可读 + 所有者进程已不存在 + 超过 15 分钟 + 锁未被持有」的 staging；
// 其余一律保留。损坏的事务记录无法提供 staging 名称时也不会误删在用的副本。
pub fn cleanup_staging(root: &Path, active: &[String]) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(".staging-") || !entry.path().is_dir() { continue; }
        if active.iter().any(|a| a == &name) { continue; }
        let dir = entry.path();
        let Some(owner) = read_staging_owner(root, &name) else {
            eprintln!("staging {name} 没有可确认的 <名>.owner.json，保留");
            continue;
        };
        let age = now_unix().saturating_sub(owner.created_at);
        let held = lock_is_held(root, &name);
        if !reclaimable(age, current_pid_policy(), pid_definitely_gone(owner.pid), held) { continue; }
        eprintln!("清理过期 staging {name}（pid {}，{} 秒）", owner.pid, age);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(staging_lock_path(root, &name));
        let _ = fs::remove_file(staging_owner_path(root, &name));
    }
}

// 没有事务记录的 .old-* 一律保留（只记日志）：缺少提交证据时无法证明该副本已无用，
// 尤其是「同版本重装、target 与备份身份不同」正是需要保留备份的情形。
pub fn report_orphan_backups(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        if !entry.path().is_dir() { continue; }
        let id = entry.file_name().to_string_lossy().to_string();
        if id.starts_with('.') || tx_path(root, &id).exists() { continue; }
        let Ok(sub) = fs::read_dir(entry.path()) else { continue };
        for item in sub.flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            if name.starts_with(".old-") && item.path().is_dir() {
                eprintln!("保留无事务记录的备份 {id}/{name}（缺少提交证据，需人工确认）");
            }
        }
    }
}

// 安装失败在**释放锁之前**调用：复用决策表恢复；无法确定结论就隔离，staging 是否删除由决策决定。
#[derive(Debug, Default)]
pub struct FinalizeOutcome {
    pub recovered: bool,
    pub blocked: bool,
    pub reason: Option<String>,
}

pub fn finalize_failed_install(root: &Path, id: &str) -> FinalizeOutcome {
    let tp = tx_path(root, id);
    if !tp.exists() {
        return FinalizeOutcome::default(); // 还没写事务记录，没有可恢复的目录动作
    }
    let rec = match read_tx(&tp) {
        Ok(r) => r,
        Err(e) => {
            let (_, persisted) = isolate_repair(root, id, &e, TxStage::Prepared);
            return FinalizeOutcome { blocked: !persisted, reason: Some(e), ..Default::default() };
        }
    };
    match recover_one(root, id, &rec) {
        Ok(()) => {
            let _ = fs::remove_file(&tp);
            clear_repair(root, id);
            FinalizeOutcome { recovered: true, ..Default::default() }
        }
        Err(e) => {
            let (_, persisted) = isolate_repair(root, id, &e, rec.stage);
            FinalizeOutcome { blocked: !persisted, reason: Some(e), ..Default::default() }
        }
    }
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

// 已移除「按插件 id 扫目录、删掉 keep 以外所有目录」的 prune_versions：
// 它会连不属于当前事务的孤立 .old-* 与未登记目录一起删掉。现在清理范围由
// registered_paths（记录里的 target / backup / staging / previous_state.version）决定，
// 见 cleanup_after_commit。

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
            // 测试里构造的记录默认「备份由本事务创建」且身份就是 old_id，
            // 与 swap 成功后的真实记录一致；需要反向场景的用例再单独置 false
            backup_created: !old_id.is_empty(),
            backup_identity: old_id.into(),
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

    // ---- 回修 5 · 1：失败收尾复用决策表，staging 由决策决定是否删除 ----
    #[test]
    fn finalize_failed_install_recovers_by_decision() {
        let root = setup("finalize-ok");
        let old_id = write_pkg(&plugin_dir(&root, "hello").join(".old-1.0.0"), "old", &[]);
        write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &["app"]);
        let new_id = tree_sha256(&version_dir(&root, "hello", "1.0.0")).unwrap();
        fs::create_dir_all(root.join(".staging-x")).unwrap();
        fs::write(root.join(".staging-x/keep.txt"), b"x").unwrap();
        let old = entry("1.0.0", 'a', true);
        seed_state(&root, Some(old.clone()));
        put_tx(&root, &rec(&root, &old_id, &new_id, Some(old.clone()), Some(entry("1.0.0", 'b', true))));
        let out = finalize_failed_install(&root, "hello");
        assert_eq!(out.recovered, true);
        assert_eq!(out.blocked, false);
        assert_eq!(tree_sha256(&version_dir(&root, "hello", "1.0.0")).unwrap(), old_id);
        assert!(!root.join(".staging-x").exists(), "第 5 行决策允许删 staging");
        assert_eq!(load_state(&root).plugins.get("hello"), Some(&old));
        assert!(!tx_path(&root, "hello").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn finalize_failed_install_isolates_without_deleting_copies() {
        let root = setup("finalize-isolate");
        let old_id = write_pkg(&plugin_dir(&root, "hello").join(".old-1.0.0"), "old", &[]);
        write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &["app"]);
        fs::write(version_dir(&root, "hello", "1.0.0").join("index.html"), b"tampered").unwrap();
        fs::create_dir_all(root.join(".staging-x")).unwrap();
        fs::write(root.join(".staging-x/keep.txt"), b"x").unwrap();
        seed_state(&root, Some(entry("1.0.0", 'a', true)));
        put_tx(&root, &rec(&root, &old_id, "new".into(), None, None));
        let out = finalize_failed_install(&root, "hello");
        assert_eq!(out.recovered, false);
        assert!(out.reason.is_some());
        assert!(root.join(".staging-x/keep.txt").exists(), "第 8 行不删 staging");
        assert!(version_dir(&root, "hello", "1.0.0").exists());
        assert!(plugin_dir(&root, "hello").join(".old-1.0.0").exists());
        assert!(tx_path(&root, "hello").exists());
        assert!(read_repair(&root, "hello").is_some());
        fs::remove_dir_all(&root).unwrap();
    }

    // ---- 回修 5 · 2：staging 所有权与 15 分钟启动清理 ----
    fn manual_staging(root: &Path, name: &str, owner: Option<StagingOwner>) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("keep.txt"), b"x").unwrap();
        if let Some(o) = owner {
            fs::write(staging_owner_path(root, name), serde_json::to_vec(&o).unwrap()).unwrap();
        }
        fs::write(staging_lock_path(root, name), b"").unwrap();
    }

    #[test]
    fn staging_owner_is_recorded_and_name_has_pid() {
        let root = setup("staging-owner");
        let dir = create_staging(&root).unwrap();
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with(&format!(".staging-{}-", std::process::id())));
        assert!(read_staging_owner(&root, &name).is_none(), "解压完成前不写所有权文件，避免与包内文件冲突");
        seal_staging(&root, &dir).unwrap();
        let owner = read_staging_owner(&root, &name).unwrap();
        assert!(!dir.join("owner.json").exists(), "包目录内不能出现宿主文件");
        assert_eq!(owner.pid, std::process::id());
        assert!(fs::metadata(staging_lock_path(&root, &name)).is_ok());
        drop_staging(&root, &dir);
        assert!(!dir.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn cleanup_staging_respects_owner_pid_age_and_active_tx() {
        let root = setup("staging-clean");
        let old = now_unix().saturating_sub(STAGING_MAX_AGE_SECS + 60);
        // 活 pid → 保留
        manual_staging(&root, ".staging-live-a", Some(StagingOwner { pid: std::process::id(), created_at: old }));
        // 死 pid + 超时 → 删除
        manual_staging(&root, ".staging-dead-b", Some(StagingOwner { pid: 999999, created_at: old }));
        // 死 pid 但未超时 → 保留
        manual_staging(&root, ".staging-fresh-c", Some(StagingOwner { pid: 999999, created_at: now_unix() }));
        // 无 owner.json → 保留
        manual_staging(&root, ".staging-noowner-d", None);
        // 被事务记录引用 → 保留
        manual_staging(&root, ".staging-active-e", Some(StagingOwner { pid: 999999, created_at: old }));
        cleanup_staging(&root, &[".staging-active-e".to_string()]);
        assert!(root.join(".staging-live-a").exists(), "活进程不能删");
        assert!(!root.join(".staging-dead-b").exists(), "死进程且超时才删");
        assert!(root.join(".staging-fresh-c").exists(), "未超时保留");
        assert!(root.join(".staging-noowner-d").exists(), "归属不明保留");
        assert!(root.join(".staging-active-e").exists(), "事务引用保留");
        fs::remove_dir_all(&root).unwrap();
    }

    // ---- 回修 5 · 5：流式身份摘要 + 容量上限 → Unknown → 第 8 行 ----
    #[test]
    fn tree_identity_is_streamed_and_capped() {
        let root = setup("tree-cap");
        let dir = root.join("big");
        write_pkg(&dir, "ok", &[]);
        let before = tree_sha256(&dir).unwrap();
        // 逐文件流式读取：同一内容重复计算稳定
        assert_eq!(before, tree_sha256(&dir).unwrap());
        // 单文件超限 → Err → identity=Unknown
        let huge = dir.join("huge.bin");
        let data = vec![0u8; (MAX_FILE_BYTES + 1) as usize];
        fs::write(&huge, &data).unwrap();
        assert!(tree_sha256(&dir).is_err());
        assert_eq!(identity(&dir), Identity::Unknown);
        fs::remove_file(&huge).unwrap();
        // 总量 / 文件数上限通过可注入版本覆盖（真实上限是 64 MiB / 4000 文件，不必真写那么大）
        fs::write(dir.join("a.bin"), b"1234567890").unwrap();
        fs::write(dir.join("b.bin"), b"abcdefghij").unwrap();
        assert!(tree_sha256_limited(&dir, manifest::MAX_FILES, MAX_FILE_BYTES, 16).is_err(), "总字节超限");
        assert!(tree_sha256_limited(&dir, 2, MAX_FILE_BYTES, MAX_TOTAL_BYTES).is_err(), "文件数超限");
        assert!(tree_sha256_limited(&dir, manifest::MAX_FILES, 8, MAX_TOTAL_BYTES).is_err(), "单文件超限");
        assert!(tree_sha256(&dir).is_ok(), "真实上限内仍然可用");
        // Unknown 身份在决策表里落到 Isolate
        let r = rec(&root, "old".into(), "new".into(), None, None);
        assert_eq!(decide(&r, &Identity::Unknown, &Identity::Missing, StateClass::Old), Recovery::Isolate);
        fs::remove_dir_all(&root).unwrap();
    }


    // ---- 回修 6 · 1：读路径用跨进程共享锁 ----
    #[test]
    fn exclusive_lock_blocks_shared_read_lock() {
        let root = tmpdir("rl-blocked");
        fs::create_dir_all(&root).unwrap();
        let held = file_lock(&root).unwrap();
        let started = std::time::Instant::now();
        assert!(read_lock(&root).is_err(), "持排他锁时读路径必须拿不到共享锁");
        assert!(started.elapsed() >= std::time::Duration::from_millis(READ_LOCK_WAIT_MS - 20));
        drop(held);
        assert!(read_lock(&root).is_ok(), "释放排他锁后共享锁可用");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn shared_read_lock_blocks_exclusive() {
        let root = tmpdir("rl-shared");
        fs::create_dir_all(&root).unwrap();
        let shared = read_lock(&root).unwrap();
        let probe = fs::OpenOptions::new().create(true).read(true).write(true).open(root.join(".lock")).unwrap();
        assert!(fs2::FileExt::try_lock_exclusive(&probe).is_err(), "持共享锁读取期间排他锁必须拿不到");
        drop(shared);
        assert!(fs2::FileExt::try_lock_exclusive(&probe).is_ok(), "读完之后排他锁可用");
        fs::remove_dir_all(&root).unwrap();
    }

    // ---- 回修 6 · 2：已提交残留凭 committed 记录 + 身份复核清理 ----
    #[test]
    fn committed_record_with_matching_identity_cleans_backup() {
        let root = setup("c6-commit");
        let new_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &[]);
        // 备份是真包：身份由 content 决定，记录里必须写同一个摘要才允许删
        let old_id = write_pkg(&plugin_dir(&root, "hello").join(".old-1.0.0"), "old", &[]);
        let mut r = rec(&root, &old_id, &new_id, None, None);
        r.stage = TxStage::Committed;
        put_tx(&root, &r);
        let out = recover_transactions(&root);
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert!(!plugin_dir(&root, "hello").join(".old-1.0.0").exists(), "身份一致才删备份");
        assert!(!tx_path(&root, "hello").exists(), "清记录");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn committed_record_with_mismatched_identity_keeps_backup() {
        let root = setup("c6-mismatch");
        write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &[]);
        fs::create_dir_all(plugin_dir(&root, "hello").join(".old-1.0.0")).unwrap();
        let mut r = rec(&root, "oldid", &"f".repeat(64), None, None);
        r.stage = TxStage::Committed;
        put_tx(&root, &r);
        let out = recover_transactions(&root);
        assert_eq!(out.problems.len(), 1, "身份不符要隔离");
        assert!(plugin_dir(&root, "hello").join(".old-1.0.0").exists(), "备份必须保留");
        assert!(tx_path(&root, "hello").exists(), "记录保留");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn orphan_backup_without_record_is_kept() {
        let root = setup("c6-orphan");
        write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &[]);
        fs::create_dir_all(plugin_dir(&root, "hello").join(".old-1.0.0")).unwrap();
        report_orphan_backups(&root);
        recover_transactions(&root);
        assert!(plugin_dir(&root, "hello").join(".old-1.0.0").exists(), "没有提交证据的备份一律保留");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn corrupt_record_keeps_staging_and_backup() {
        let root = setup("c6-corrupt");
        write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &[]);
        fs::create_dir_all(plugin_dir(&root, "hello").join(".old-1.0.0")).unwrap();
        let old = now_unix().saturating_sub(STAGING_MAX_AGE_SECS + 600);
        let st = root.join(".staging-dead-1");
        fs::create_dir_all(&st).unwrap();
        fs::write(root.join(".staging-dead-1.owner.json"),
            serde_json::to_vec(&StagingOwner { pid: 999999, created_at: old }).unwrap()).unwrap();
        fs::write(staging_lock_path(&root, ".staging-dead-1"), b"").unwrap();
        fs::write(tx_path(&root, "hello"), b"{not json").unwrap();
        let out = recover_transactions(&root);
        assert_eq!(out.problems.len(), 1);
        assert!(st.exists(), "记录损坏时 staging 不删");
        assert!(plugin_dir(&root, "hello").join(".old-1.0.0").exists(), "记录损坏时备份不删");
        fs::remove_dir_all(&root).unwrap();
    }

    // ---- 回修 6 · 3：所有权文件在包目录之外 ----
    #[test]
    fn owner_file_lives_outside_the_package_dir() {
        let root = setup("c6-owner");
        let dir = root.join("pkg");
        // 包内自带 owner.json 且列入 integrity
        fs::create_dir_all(&dir).unwrap();
        let html = b"<p>x</p>";
        let inner = br#"{"pid":1,"createdAt":1}"#;
        fs::write(dir.join("index.html"), html).unwrap();
        fs::write(dir.join("owner.json"), inner).unwrap();
        let m = serde_json::json!({
            "schemaVersion": 1, "id": "hello", "name": "Hello", "version": "1.0.0",
            "apiVersion": 1, "kind": "web", "entry": "index.html", "capabilities": [],
            "integrity": {
                "index.html": format!("sha256-{}", sha256_hex(html)),
                "owner.json": format!("sha256-{}", sha256_hex(inner))
            }
        });
        fs::write(dir.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
        let before = tree_sha256(&dir).unwrap();
        let staging = create_staging(&root).unwrap();
        fs::rename(&dir, &staging).ok(); // 模拟「包内容已就位」
        if !staging.join("index.html").exists() {
            // rename 到已存在的 staging 目录失败时手工搬运
            fs::copy(dir.join("index.html"), staging.join("index.html")).ok();
            fs::copy(dir.join("owner.json"), staging.join("owner.json")).ok();
            fs::copy(dir.join("manifest.json"), staging.join("manifest.json")).ok();
        }
        seal_staging(&root, &staging).unwrap();
        assert_eq!(tree_sha256(&staging).unwrap(), before, "宿主所有权文件不能写进包目录");
        assert_eq!(fs::read(staging.join("owner.json")).unwrap(), inner.to_vec(), "包内 owner.json 原样保留");
        let name = staging.file_name().unwrap().to_string_lossy().to_string();
        assert!(read_staging_owner(&root, &name).is_some(), "所有权记录在包目录之外");
        drop_staging(&root, &staging);
        fs::remove_dir_all(&root).unwrap();
    }

    // ---- 回修 6 · 4：pid 判据 ----
    #[test]
    fn pid_judgement_only_treats_esrch_as_gone() {
        assert!(!pid_definitely_gone(std::process::id()), "当前进程必须视为存活");
        assert!(pid_definitely_gone(999_999), "不存在的 pid 视为已退出");
        // EPERM / 其它错误按「无法确认」= 存活处理：reclaimable 只看 pid_gone
        assert!(!reclaimable(STAGING_MAX_AGE_SECS + 60, PidPolicy::Unix, false, false), "Unix：无法确认存活必须保留");
        assert!(reclaimable(STAGING_MAX_AGE_SECS + 60, PidPolicy::Unix, true, false), "Unix：pid 已退出且锁空闲才可清理");
    }

    // ---- 回修 6 · 6：摘要按实际读取字节计数 ----
    #[test]
    fn hash_file_limited_counts_actual_bytes_read() {
        let root = tmpdir("c6-read");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("grow.bin");
        fs::write(&path, vec![7u8; 4096]).unwrap();
        let mut buf = [0u8; 512];
        // 「其它文件」已占掉几乎全部预算：metadata 检查会放行，但实际读到 1024 字节时超限
        assert!(hash_file_limited(&path, &mut buf, 1_000_000, 900, 1024).is_err(), "实际读取字节超总量要报错");
        let (n, digest) = hash_file_limited(&path, &mut buf, 4096, 0, 8192).unwrap();
        assert_eq!(n, 4096, "返回实际读取字节数");
        assert_eq!(digest, sha256_hex(&vec![7u8; 4096]));
        assert!(hash_file_limited(&path, &mut buf, 1024, 0, 8192).is_err(), "实际字节超单文件上限要报错");
        fs::remove_dir_all(&root).unwrap();
    }


    // ---- 回修 7 · 1：只删当前事务有证据的副本 ----
    // 回修 8 · 1：冲突检查前移到 begin_install，且什么都不写（不记事务、不写 .repair.json、不改 state）
    fn assert_orphan_backup_aborts(tag: &str, with_target: bool) {
        let root = setup(tag);
        let target_html = if with_target {
            let old_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "old", &[]);
            let e = entry("1.0.0", 'a', true);
            seed_state(&root, Some(e));
            Some(old_id)
        } else {
            seed_state(&root, None);
            None
        };
        // 孤立备份（没有本事务的提交证据）
        let backup = plugin_dir(&root, "hello").join(".old-1.0.0");
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("keep.txt"), b"keep").unwrap();
        let staging = stage_pkg(&root, "x", "new");
        let err = match begin_install(&root, "hello", "1.0.0", &staging, None) {
            Err(e) => e,
            Ok(_) => panic!("已有孤立备份时必须中止安装"),
        };
        assert!(err.contains("未确认的旧备份") && err.contains(".old-1.0.0"), "{err}");
        assert!(!tx_path(&root, "hello").exists(), "不能留下事务记录");
        assert!(read_repair(&root, "hello").is_none(), "不能写修复标记");
        assert_eq!(fs::read(backup.join("keep.txt")).unwrap(), b"keep", "备份内容不变");
        if let Some(old_id) = target_html {
            assert_eq!(identity(&version_dir(&root, "hello", "1.0.0")), Identity::Known(old_id), "target 不变");
            let st = load_state(&root);
            assert_eq!(st.plugins.get("hello").map(|e| e.enabled), Some(true), "插件仍可启用");
            assert!(st.plugins.get("hello").and_then(|e| e.repair.clone()).is_none(), "state 未被改");
        } else {
            assert!(!version_dir(&root, "hello", "1.0.0").exists(), "target 不该被创建");
            assert!(load_state(&root).plugins.is_empty(), "state 未被改");
        }
        // 调用方释放 staging（模拟 plugin_install 的错误分支）
        drop_staging(&root, &staging);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn orphan_backup_aborts_install_with_existing_target() {
        assert_orphan_backup_aborts("c8-orphan-target", true);
    }

    #[test]
    fn orphan_backup_aborts_install_without_target() {
        assert_orphan_backup_aborts("c8-orphan-notarget", false);
    }

    #[test]
    fn committed_cleanup_only_deletes_registered_paths() {
        let root = setup("c7-scope");
        let new_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &[]);
        // 记录登记的备份（真包 + 身份一致 → 会被删）
        let old_id = write_pkg(&plugin_dir(&root, "hello").join(".old-1.0.0"), "old", &[]);
        // 旁边的孤立备份与未登记目录（必须保留）
        fs::create_dir_all(plugin_dir(&root, "hello").join(".old-0.9.0")).unwrap();
        fs::create_dir_all(plugin_dir(&root, "hello").join("0.8.0")).unwrap();
        fs::write(plugin_dir(&root, "hello").join("0.8.0/keep.txt"), b"x").unwrap();
        let mut r = rec(&root, &old_id, &new_id, None, None);
        r.stage = TxStage::Committed;
        put_tx(&root, &r);
        let out = recover_transactions(&root);
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert!(!plugin_dir(&root, "hello").join(".old-1.0.0").exists(), "记录登记过的备份要删");
        assert!(plugin_dir(&root, "hello").join(".old-0.9.0").exists(), "未登记的孤立备份必须保留");
        assert!(plugin_dir(&root, "hello").join("0.8.0/keep.txt").exists(), "未登记目录必须保留");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn non_committed_recovery_leaves_orphan_backups_alone() {
        let root = setup("c7-noncommitted");
        let new_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &[]);
        fs::create_dir_all(plugin_dir(&root, "hello").join(".old-0.9.0")).unwrap();
        fs::write(plugin_dir(&root, "hello").join(".old-0.9.0/keep.txt"), b"x").unwrap();
        let new = entry("1.0.0", 'b', true);
        seed_state(&root, Some(new.clone()));
        // 第 6 行（首次安装 + state 已是新）走 FinishNew → cleanup_after_commit
        let rec_row6 = rec(&root, "", &new_id, None, Some(new));
        put_tx(&root, &rec_row6);
        let out = recover_transactions(&root);
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert!(plugin_dir(&root, "hello").join(".old-0.9.0/keep.txt").exists(), "非 committed 恢复不碰孤立备份");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn upgrade_cleanup_removes_only_recorded_previous_version() {
        let root = setup("c7-upgrade");
        write_pkg(&version_dir(&root, "hello", "0.9.0"), "old", &[]);
        let new_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &[]);
        fs::create_dir_all(plugin_dir(&root, "hello").join(".old-0.8.0")).unwrap();
        let mut r = rec(&root, "oldid", &new_id, Some(entry("0.9.0", 'a', true)), Some(entry("1.0.0", 'b', true)));
        r.stage = TxStage::Committed;
        put_tx(&root, &r);
        let out = recover_transactions(&root);
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert!(!version_dir(&root, "hello", "0.9.0").exists(), "previous_state 登记的旧版本要删");
        assert!(version_dir(&root, "hello", "1.0.0").exists(), "target 保留");
        assert!(plugin_dir(&root, "hello").join(".old-0.8.0").exists(), "未登记的 .old 保留");
        fs::remove_dir_all(&root).unwrap();
    }

    // ---- 回修 7 · 3：Windows 跳过 pid 判据（纯函数可注入） ----
    #[test]
    fn reclaimable_policy_differs_for_windows() {
        let old = STAGING_MAX_AGE_SECS + 60;
        // Windows：不看 pid，只看时间 + 锁
        assert!(reclaimable(old, PidPolicy::Windows, false, false), "Windows 不依赖 pid，可清理");
        assert!(!reclaimable(old, PidPolicy::Windows, true, true), "锁被持有则保留");
        assert!(!reclaimable(STAGING_MAX_AGE_SECS, PidPolicy::Windows, true, false), "未超 15 分钟保留");
        // Unix：pid 未确认退出则保留（即便锁空闲）
        assert!(!reclaimable(old, PidPolicy::Unix, false, false), "Unix：pid 未确认退出保留");
        assert!(reclaimable(old, PidPolicy::Unix, true, false), "Unix：pid 已退出 + 锁空闲可清理");
        assert!(!reclaimable(old, PidPolicy::Unix, true, true), "锁被持有保留");
        assert_eq!(current_pid_policy(), if cfg!(windows) { PidPolicy::Windows } else { PidPolicy::Unix });
    }


    // ---- 回修 8 · 2：备份只删本事务创建且身份一致的 ----
    #[test]
    fn backup_not_created_by_this_tx_is_never_deleted() {
        let root = setup("c8-backup-not-ours");
        let new_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &[]);
        let old_id = write_pkg(&plugin_dir(&root, "hello").join(".old-1.0.0"), "old", &[]);
        let mut r = rec(&root, &old_id, &new_id, None, None);
        r.stage = TxStage::Committed;
        // 记录声称备份存在，但 backup_created=false（不是本事务创建的）
        r.backup_created = false;
        r.backup_identity = old_id.clone();
        put_tx(&root, &r);
        let out = recover_transactions(&root);
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert!(plugin_dir(&root, "hello").join(".old-1.0.0").exists(), "非本事务创建的备份必须保留");
        assert!(!tx_path(&root, "hello").exists(), "记录本身照常收尾");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn backup_identity_mismatch_is_kept() {
        let root = setup("c8-backup-id");
        let new_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &[]);
        write_pkg(&plugin_dir(&root, "hello").join(".old-1.0.0"), "old", &[]);
        let mut r = rec(&root, "a".repeat(64).as_str(), &new_id, None, None);
        r.stage = TxStage::Committed;
        r.backup_created = true;
        r.backup_identity = "f".repeat(64); // 与实际内容不符
        put_tx(&root, &r);
        let out = recover_transactions(&root);
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert!(plugin_dir(&root, "hello").join(".old-1.0.0").exists(), "身份不一致的备份必须保留");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn normal_upgrade_deletes_the_backup_this_tx_created() {
        let root = setup("c8-upgrade-ok");
        // 旧版就位
        let old_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "old", &[]);
        let old = entry("1.0.0", 'a', true);
        seed_state(&root, Some(old.clone()));
        let staging = stage_pkg(&root, "x", "new");
        let mut tx = begin_install(&root, "hello", "1.0.0", &staging, Some(old)).unwrap();
        tx.swap().unwrap();
        let rec_after_swap = read_tx(&tx_path(&root, "hello")).unwrap();
        assert_eq!(rec_after_swap.backup_created, true, "swap 成功后认领备份");
        assert_eq!(rec_after_swap.backup_identity, old_id, "备份身份就是被移走的旧 target");
        assert!(plugin_dir(&root, "hello").join(".old-1.0.0").exists());
        tx.write_state(entry("1.0.0", 'b', true)).unwrap();
        tx.commit().unwrap();
        assert!(!plugin_dir(&root, "hello").join(".old-1.0.0").exists(), "正常升级删掉本事务备份");
        assert!(!tx_path(&root, "hello").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn new_install_never_touches_backup_path() {
        let root = setup("c8-fresh");
        let staging = stage_pkg(&root, "x", "new");
        let mut tx = begin_install(&root, "hello", "1.0.0", &staging, None).unwrap();
        tx.swap().unwrap();
        let rec_after = read_tx(&tx_path(&root, "hello")).unwrap();
        assert_eq!(rec_after.backup_created, false, "没有旧版时不认领备份");
        tx.write_state(entry("1.0.0", 'b', true)).unwrap();
        tx.commit().unwrap();
        assert!(!plugin_dir(&root, "hello").join(".old-1.0.0").exists());
        fs::remove_dir_all(&root).unwrap();
    }


    // ---- 回修 9 · 1：FinishNew 先落盘 committed，再清理 ----
    #[test]
    fn finish_new_persists_committed_before_cleanup() {
        let root = setup("c9-finish-order");
        let new_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &[]);
        // 第 6 行（首次安装 + state 已是新）走 FinishNew；记录里带一个登记过的 staging 目录
        fs::create_dir_all(root.join(".staging-x")).unwrap();
        let new = entry("1.0.0", 'b', true);
        seed_state(&root, Some(new.clone()));
        let r = rec(&root, "", &new_id, None, Some(new));
        put_tx(&root, &r);
        assert_eq!(read_tx(&tx_path(&root, "hello")).unwrap().stage, TxStage::Prepared, "恢复前还是 prepared");

        cleanup_probe::reset();
        cleanup_probe::arm(false);
        let out = recover_transactions(&root);
        // 先把探针值取出来再 reset（reset 会清零）
        let saw_committed = cleanup_probe::saw_committed();
        cleanup_probe::reset();

        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert!(saw_committed, "清理入口必须看到记录已落盘为 committed");
        assert!(!tx_path(&root, "hello").exists(), "成功后记录被删除");
        assert!(!root.join(".staging-x").exists(), "登记的 staging 被清理");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn finish_new_keeps_backup_when_cleanup_fails_after_committed() {
        let root = setup("c9-finish-fail");
        let new_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &[]);
        // 备份必须是真包，否则身份 Unknown 会先落到第 8 行
        let backup = plugin_dir(&root, "hello").join(".old-1.0.0");
        let old_id = write_pkg(&backup, "old", &[]);
        let new = entry("1.0.0", 'b', true);
        seed_state(&root, Some(new.clone()));
        let mut r = rec(&root, &old_id, &new_id, None, Some(new));
        r.backup_created = true;
        r.backup_identity = old_id.clone();
        put_tx(&root, &r);

        cleanup_probe::reset();
        cleanup_probe::arm(true); // 注入：清理一定失败
        let out = recover_transactions(&root);
        let saw_committed = cleanup_probe::saw_committed();
        cleanup_probe::reset();

        assert!(saw_committed, "清理失败之前记录已落盘为 committed");
        assert_eq!(out.problems.len(), 1, "清理失败要隔离");
        assert!(backup.join("index.html").exists(), "清理失败时备份保留");
        let leftover = read_tx(&tx_path(&root, "hello")).unwrap();
        assert_eq!(leftover.stage, TxStage::Committed, "落盘的记录已是 committed");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn finish_new_keeps_everything_when_record_write_fails() {
        let root = setup("c9-finish-writefail");
        let new_id = write_pkg(&version_dir(&root, "hello", "1.0.0"), "new", &[]);
        let backup = plugin_dir(&root, "hello").join(".old-1.0.0");
        let old_id = write_pkg(&backup, "old", &[]);
        let new = entry("1.0.0", 'b', true);
        seed_state(&root, Some(new.clone()));
        let mut r = rec(&root, &old_id, &new_id, None, Some(new));
        r.backup_created = true;
        r.backup_identity = old_id.clone();
        put_tx(&root, &r);

        // 把插件子目录设成只读：write_atomic 无法在里面创建临时文件 → 推进 committed 落盘失败
        let plugin_root = plugin_dir(&root, "hello");
        let orig = fs::metadata(&plugin_root).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = orig.clone();
            perms.set_mode(0o555);
            fs::set_permissions(&plugin_root, perms).unwrap();
        }

        let out = recover_transactions(&root);

        fs::set_permissions(&plugin_root, orig).unwrap();

        assert_eq!(out.problems.len(), 1, "落盘失败要隔离");
        assert!(backup.join("index.html").exists(), "记录落盘失败时备份必须保留");
        assert!(version_dir(&root, "hello", "1.0.0").exists(), "target 不动");
        let leftover = read_tx(&tx_path(&root, "hello")).unwrap();
        assert_eq!(leftover.stage, TxStage::Prepared, "记录没被推进（落盘失败就返回 Err）");
        fs::remove_dir_all(&root).unwrap();
    }

    // ---- 回修 9 · 2：孤立备份错误文案给出完整路径 + 手工删除指引 ----
    #[test]
    fn orphan_backup_error_names_the_full_path() {
        let root = setup("c9-msg");
        let backup = plugin_dir(&root, "hello").join(".old-1.0.0");
        fs::create_dir_all(&backup).unwrap();
        let staging = stage_pkg(&root, "x", "new");
        let err = match begin_install(&root, "hello", "1.0.0", &staging, None) {
            Err(e) => e,
            Ok(_) => panic!("已有孤立备份时必须中止"),
        };
        assert!(err.contains(&backup.display().to_string()), "错误里要有完整路径：{err}");
        assert!(err.contains("手工删除该目录"), "要给出处置办法：{err}");
        assert!(err.contains("再重新安装"), "{err}");
        assert!(!err.contains("插件面板移除"), "不再提面板移除：{err}");
        fs::remove_dir_all(&root).unwrap();
    }

}
