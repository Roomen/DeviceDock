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
// 分阶段记录，每个换名 / 写 state 动作之后立刻推进阶段（记录本身用临时文件 + fsync 文件 +
// rename + fsync 目录落盘）。恢复按阶段决定「什么都没动 / 还原目录与 state / 补完提交 / 补做清理」。
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
    #[serde(default)]
    pub stage: TxStage,
    // 兼容旧格式的 committed 布尔值；新记录以 stage 为准
    #[serde(default)]
    pub committed: bool,
    // 新包目录的树摘要：恢复时用它核对「当前目录确实是本次换入的新包」，不凭假设删目录
    #[serde(default)]
    pub tree_sha256: String,
    // 旧 state 条目：回滚时把 state.json 一起还原
    #[serde(default)]
    pub previous_state: Option<Entry>,
    // 新 state 条目：state_written 阶段用来补完提交
    #[serde(default)]
    pub expected_state: Option<Entry>,
}

impl TxRecord {
    fn effective_stage(&self) -> TxStage {
        if self.committed && self.stage == TxStage::Prepared {
            TxStage::Committed
        } else {
            self.stage
        }
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

fn write_repair(root: &Path, id: &str, reason: &str, stage: TxStage) -> Result<(), String> {
    let info = RepairInfo {
        id: id.to_string(),
        reason: reason.to_string(),
        stage: format!("{stage:?}"),
        at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };
    let body = serde_json::to_vec(&info).map_err(|e| format!("修复标记序列化失败：{e}"))?;
    write_atomic(&repair_path(root, id), &body)
}

pub fn clear_repair(root: &Path, id: &str) {
    let _ = fs::remove_file(repair_path(root, id));
}

pub fn discard_tx(root: &Path, id: &str) {
    let _ = fs::remove_file(tx_path(root, id));
}

pub fn list_repairs(root: &Path) -> Vec<RepairInfo> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return out;
    };
    for e in entries.flatten() {
        if e.path().is_dir() {
            let id = e.file_name().to_string_lossy().to_string();
            if let Some(r) = read_repair(root, &id) {
                out.push(r);
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

// 跨进程文件锁：同一台机器上多个客户端实例也要串行进入安装 / 启停 / 卸载事务
pub struct FileLock {
    _file: fs::File,
}

pub fn file_lock(root: &Path) -> Result<FileLock, String> {
    fs::create_dir_all(root).map_err(|e| format!("无法创建插件目录：{e}"))?;
    let file = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(root.join(LOCK_FILE))
        .map_err(|e| format!("无法打开插件事务锁：{e}"))?;
    fs2::FileExt::lock_exclusive(&file).map_err(|e| format!("无法取得插件事务锁：{e}"))?;
    Ok(FileLock { _file: file })
}

fn staging_name(staging: &Path) -> String {
    staging.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string()
}

// 新包目录的树摘要：按 manifest.integrity 的顺序把「路径 + 文件内容摘要」喂给 SHA-256。
// 恢复时重算一次，只有对得上才允许删目录（避免把仍是旧版的目录误当成新包删掉）。
pub fn tree_sha256(dir: &Path) -> Result<String, String> {
    let m = read_manifest(dir)?;
    let mut hasher = Sha256::new();
    for (rel, _) in &m.integrity {
        let bytes = fs::read(dir.join(rel)).map_err(|e| format!("无法读取包内文件 {rel}：{e}"))?;
        hasher.update(rel.as_bytes());
        hasher.update(b":");
        hasher.update(sha256_hex(&bytes).as_bytes());
        hasher.update(b";");
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn cleanup_after_commit(root: &Path, id: &str, rec: &TxRecord) -> Result<(), String> {
    prune_versions(root, id, &rec.version);
    if rec.backup {
        let backup = plugin_dir(root, id).join(format!(".old-{}", rec.version));
        if backup.exists() {
            fs::remove_dir_all(&backup).map_err(|e| format!("无法删除插件旧版本备份：{e}"))?;
        }
    }
    remove_staging(root, rec)
}

fn remove_staging(root: &Path, rec: &TxRecord) -> Result<(), String> {
    if !rec.staging.is_empty() {
        let st = root.join(&rec.staging);
        if st.exists() {
            fs::remove_dir_all(&st).map_err(|e| format!("无法删除插件临时目录：{e}"))?;
        }
    }
    Ok(())
}

fn restore_state(root: &Path, id: &str, previous: Option<&Entry>) -> Result<(), String> {
    load_and_save(root, |st| match previous {
        Some(e) => {
            st.plugins.insert(id.to_string(), e.clone());
        }
        None => {
            st.plugins.remove(id);
        }
    })
}

// 回滚 / 未提交的恢复：目录与 state.json 一起还原。
// 只有「当前目录确实是本次换入的新包（树摘要对得上）」且备份存在时才删目录；
// 任何一步失败都冒泡，调用方保留 .tx.json 让下一次可以继续处理。
fn abort_install(root: &Path, id: &str, rec: &TxRecord) -> Result<(), String> {
    if rec.effective_stage() == TxStage::Prepared {
        // 记录已写但还没换名：目标目录仍是旧版，绝不能删
        return remove_staging(root, rec);
    }
    let target = checked_version_dir(root, id, &rec.version)?;
    let backup = plugin_dir(root, id).join(format!(".old-{}", rec.version));
    if rec.backup && !backup.exists() {
        return Err("事务备份目录不存在，无法自动还原".to_string());
    }
    if target.exists() {
        if rec.tree_sha256.is_empty() {
            return Err("事务记录缺少包树摘要，不能确认目标目录是新包，拒绝删除".to_string());
        }
        let actual = tree_sha256(&target).unwrap_or_default();
        if actual != rec.tree_sha256 {
            return Err("目标目录内容与事务记录里的新包摘要不符，拒绝删除".to_string());
        }
        fs::remove_dir_all(&target).map_err(|e| format!("无法移除未提交的插件版本：{e}"))?;
    }
    if !rec.staging.is_empty() {
        remove_staging(root, rec)?;
    }
    if backup.exists() && !target.exists() {
        fs::rename(&backup, &target).map_err(|e| format!("无法还原插件旧版本：{e}"))?;
    }
    restore_state(root, id, rec.previous_state.as_ref())
}

// state_written 阶段：新包与状态意图都已落盘，补完提交而不是回滚。
fn finish_state_written(root: &Path, id: &str, rec: &TxRecord) -> Result<(), String> {
    let target = checked_version_dir(root, id, &rec.version)?;
    if target.exists() {
        if rec.tree_sha256.is_empty() {
            return Err("事务记录缺少包树摘要，不能确认目标目录是新包".to_string());
        }
        let actual = tree_sha256(&target).unwrap_or_default();
        if actual != rec.tree_sha256 {
            return Err("目标目录内容与事务记录里的新包摘要不符，不能补完提交".to_string());
        }
    }
    if let Some(entry) = &rec.expected_state {
        load_and_save(root, |st| {
            if !st.plugins.get(id).map(|e| e == entry).unwrap_or(false) {
                st.plugins.insert(id.to_string(), entry.clone());
            }
        })?;
    }
    cleanup_after_commit(root, id, rec)
}

fn recover_one(root: &Path, id: &str, rec: &TxRecord) -> Result<(), String> {
    match rec.effective_stage() {
        TxStage::Prepared => remove_staging(root, rec),
        TxStage::Swapped => abort_install(root, id, rec),
        TxStage::StateWritten => finish_state_written(root, id, rec),
        TxStage::Committed => cleanup_after_commit(root, id, rec),
    }
}

// 应用启动时调用。单个插件恢复失败只隔离这个插件（写 .repair.json、停用），
// 返回问题清单，绝不让整个客户端起不来。
pub fn recover_transactions(root: &Path) -> Vec<RepairInfo> {
    let mut problems = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return problems;
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let tp = tx_path(root, &id);
        if !tp.exists() {
            continue;
        }
        let rec = match read_tx(&tp) {
            Ok(r) => r,
            Err(e) => {
                problems.push(isolate_repair(root, &id, &e, TxStage::Prepared));
                continue;
            }
        };
        match recover_one(root, &id, &rec) {
            Ok(()) => {
                let _ = fs::remove_file(&tp);
                clear_repair(root, &id);
            }
            Err(e) => problems.push(isolate_repair(root, &id, &e, rec.effective_stage())),
        }
    }
    problems
}

fn isolate_repair(root: &Path, id: &str, reason: &str, stage: TxStage) -> RepairInfo {
    let _ = write_repair(root, id, reason, stage);
    // 停用这个插件，避免 ddplugin:// 继续提供状态不确定的包
    let _ = load_and_save(root, |st| {
        if let Some(e) = st.plugins.get_mut(id) {
            e.enabled = false;
        }
    });
    RepairInfo {
        id: id.to_string(),
        reason: reason.to_string(),
        stage: format!("{stage:?}"),
        at: 0,
    }
}

pub fn retry_recovery(root: &Path, id: &str) -> Result<(), String> {
    let tp = tx_path(root, id);
    if !tp.exists() {
        // 没有事务记录（可能已被手工清掉）：清掉修复标记即可
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
    #[allow(dead_code)] // 单测里核对目标目录
    pub fn target(&self) -> &Path {
        &self.target
    }
    fn advance(&mut self, stage: TxStage) -> Result<(), String> {
        self.rec.stage = stage;
        self.rec.committed = stage == TxStage::Committed;
        write_tx(&self.root, &self.id, &self.rec)
    }
    // prepared → swapped：先换名，成功后才推进阶段；失败尝试还原且保留记录
    pub fn swap(&mut self) -> Result<(), String> {
        let plugin_root = plugin_dir(&self.root, &self.id);
        let backup = plugin_root.join(format!(".old-{}", self.rec.version));
        if self.target.exists() {
            let _ = fs::remove_dir_all(&backup);
            if let Err(e) = fs::rename(&self.target, &backup) {
                // 换名失败：还原错误也要冒泡，事务记录绝不删
                let restore = fs::rename(&backup, &self.target);
                if self.target.exists() || restore.is_ok() {
                    return Err(format!("无法替换已有插件版本：{e}"));
                }
                return Err(format!("无法替换已有插件版本：{e}；还原备份也失败：{restore:?}"));
            }
        }
        let staging = self.root.join(&self.rec.staging);
        if let Err(e) = fs::rename(&staging, &self.target) {
            let _ = fs::remove_dir_all(&staging);
            let mut restore_err = String::new();
            if backup.exists() && !self.target.exists() {
                if let Err(re) = fs::rename(&backup, &self.target) {
                    restore_err = format!("；还原备份也失败：{re}");
                }
            }
            return Err(format!("无法放置插件文件：{e}{restore_err}"));
        }
        self.advance(TxStage::Swapped)
    }
    // swapped → state_written：先把「准备写哪条 state」记进事务，再写 state.json
    pub fn write_state(&mut self, entry: Entry) -> Result<(), String> {
        self.rec.expected_state = Some(entry.clone());
        self.advance(TxStage::StateWritten)?;
        load_and_save(&self.root, |st| {
            st.plugins.insert(self.id.clone(), entry);
        })
    }
    pub fn commit(&mut self) -> Result<(), String> {
        self.advance(TxStage::Committed)?;
        cleanup_after_commit(&self.root, &self.id, &self.rec)?;
        fs::remove_file(tx_path(&self.root, &self.id))
            .map_err(|e| format!("无法删除插件事务记录：{e}"))
    }
    pub fn rollback(&mut self) -> Result<(), String> {
        abort_install(&self.root, &self.id, &self.rec)?;
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
    let tree = tree_sha256(staging)?;
    let rec = TxRecord {
        version: version.to_string(),
        backup: target.exists(),
        staging: staging_name(staging),
        stage: TxStage::Prepared,
        committed: false,
        tree_sha256: tree,
        previous_state,
        expected_state: None,
    };
    // 记录先落盘（fsync），此时还没动任何目录：崩溃也只会走「什么都没发生」的恢复分支
    write_tx(root, id, &rec)?;
    Ok(InstallTx {
        root: root.to_path_buf(),
        id: id.to_string(),
        target,
        rec,
    })
}

// 安装确认时的基线：提交前重新核对，防止 inspect 到 install 之间被另一个窗口改掉
pub fn baseline_matches(existing: Option<&Entry>, version: Option<&str>, sha: Option<&str>) -> bool {
    match (existing, version, sha) {
        (None, None, None) => true,
        (Some(e), Some(v), Some(s)) => e.version == v && e.package_sha256.eq_ignore_ascii_case(s),
        _ => false,
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

    fn stage_pkg(root: &Path, tag: &str, body: &str) -> PathBuf {
        let dir = root.join(format!(".staging-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let html = format!("<p>{body}</p>").into_bytes();
        fs::write(dir.join("index.html"), &html).unwrap();
        let m = serde_json::json!({
            "schemaVersion": 1, "id": "hello", "name": "Hello", "version": "1.0.0",
            "apiVersion": 1, "kind": "web", "entry": "index.html",
            "capabilities": [],
            "integrity": { "index.html": format!("sha256-{}", sha256_hex(&html)) }
        });
        fs::write(dir.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
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
        }
    }
    fn seed_state(root: &Path, e: Entry) {
        let mut st = State::default();
        st.plugins.insert("hello".to_string(), e);
        save_state(root, &st).unwrap();
    }

    #[test]
    fn prepared_crash_does_not_touch_the_old_dir() {
        // 记录已写、换名还没做：目标目录仍是旧包，恢复绝不能删它
        let root = tmpdir("tx-prepared");
        let first = stage_pkg(&root, "s0", "old");
        fs::create_dir_all(plugin_dir(&root, "hello")).unwrap();
        fs::rename(&first, version_dir(&root, "hello", "1.0.0")).unwrap();
        let old = entry("1.0.0", 'a', true);
        seed_state(&root, old.clone());
        let staging = stage_pkg(&root, "s1", "new");
        let tx = begin_install(&root, "hello", "1.0.0", &staging, Some(old.clone())).unwrap();
        assert_eq!(read_tx(&tx_path(&root, "hello")).unwrap().stage, TxStage::Prepared);
        drop(tx); // 崩在任何换名之前
        let problems = recover_transactions(&root);
        assert!(problems.is_empty(), "prepared 阶段恢复不该失败");
        assert_eq!(fs::read(version_dir(&root, "hello", "1.0.0").join("index.html")).unwrap(), b"<p>old</p>");
        assert_eq!(load_state(&root).plugins.get("hello"), Some(&old));
        assert!(!tx_path(&root, "hello").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn swapped_crash_restores_dir_and_state_together() {
        let root = tmpdir("tx-swapped");
        let first = stage_pkg(&root, "s0", "old");
        fs::rename(&first, {
            fs::create_dir_all(plugin_dir(&root, "hello")).unwrap();
            version_dir(&root, "hello", "1.0.0")
        }).unwrap();
        let old = entry("1.0.0", 'a', true);
        seed_state(&root, old.clone());
        let staging = stage_pkg(&root, "s1", "new");
        let mut tx = begin_install(&root, "hello", "1.0.0", &staging, Some(old.clone())).unwrap();
        tx.swap().unwrap();
        assert_eq!(read_tx(&tx_path(&root, "hello")).unwrap().stage, TxStage::Swapped);
        assert_eq!(fs::read(tx.target().join("index.html")).unwrap(), b"<p>new</p>");
        drop(tx); // 崩在写 state.json 之前
        let problems = recover_transactions(&root);
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(fs::read(version_dir(&root, "hello", "1.0.0").join("index.html")).unwrap(), b"<p>old</p>");
        assert_eq!(load_state(&root).plugins.get("hello"), Some(&old), "state.json 必须与目录一起还原");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn state_written_crash_completes_the_commit() {
        let root = tmpdir("tx-state-written");
        let first = stage_pkg(&root, "s0", "old");
        fs::create_dir_all(plugin_dir(&root, "hello")).unwrap();
        fs::rename(&first, version_dir(&root, "hello", "0.9.0")).unwrap();
        seed_state(&root, entry("0.9.0", 'a', true));
        let staging = stage_pkg(&root, "s1", "new");
        let mut tx = begin_install(&root, "hello", "1.0.0", &staging, Some(entry("0.9.0", 'a', true))).unwrap();
        tx.swap().unwrap();
        let new_entry = entry("1.0.0", 'b', true);
        tx.write_state(new_entry.clone()).unwrap();
        assert_eq!(read_tx(&tx_path(&root, "hello")).unwrap().stage, TxStage::StateWritten);
        drop(tx); // 崩在 committed 标记之前
        fs::create_dir_all(plugin_dir(&root, "hello").join("0.9.0")).ok();
        let problems = recover_transactions(&root);
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(fs::read(version_dir(&root, "hello", "1.0.0").join("index.html")).unwrap(), b"<p>new</p>");
        assert_eq!(load_state(&root).plugins.get("hello"), Some(&new_entry), "state 补完为新条目");
        assert!(!version_dir(&root, "hello", "0.9.0").exists(), "补完提交要清旧版本");
        assert!(!tx_path(&root, "hello").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn committed_but_not_cleaned_is_finished_at_startup() {
        let root = tmpdir("tx-committed");
        let first = stage_pkg(&root, "s0", "old");
        fs::create_dir_all(plugin_dir(&root, "hello")).unwrap();
        fs::rename(&first, version_dir(&root, "hello", "0.9.0")).unwrap();
        seed_state(&root, entry("0.9.0", 'a', true));
        let staging = stage_pkg(&root, "s1", "new");
        let mut tx = begin_install(&root, "hello", "1.0.0", &staging, Some(entry("0.9.0", 'a', true))).unwrap();
        tx.swap().unwrap();
        tx.write_state(entry("1.0.0", 'b', true)).unwrap();
        let mut rec = read_tx(&tx_path(&root, "hello")).unwrap();
        rec.stage = TxStage::Committed;
        rec.committed = true;
        write_tx(&root, "hello", &rec).unwrap();
        drop(tx); // 崩在清理之前
        let problems = recover_transactions(&root);
        assert!(problems.is_empty(), "{problems:?}");
        assert!(!version_dir(&root, "hello", "0.9.0").exists());
        assert!(version_dir(&root, "hello", "1.0.0").exists());
        assert!(!tx_path(&root, "hello").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn recovery_failure_is_isolated_per_plugin() {
        let root = tmpdir("tx-isolate");
        // 一个坏事务：备份被删，恢复必然失败
        let first = stage_pkg(&root, "s0", "old");
        fs::create_dir_all(plugin_dir(&root, "hello")).unwrap();
        fs::rename(&first, version_dir(&root, "hello", "1.0.0")).unwrap();
        let old = entry("1.0.0", 'a', true);
        seed_state(&root, old.clone());
        let staging = stage_pkg(&root, "s1", "new");
        let mut tx = begin_install(&root, "hello", "1.0.0", &staging, Some(old.clone())).unwrap();
        tx.swap().unwrap();
        fs::remove_dir_all(plugin_dir(&root, "hello").join(".old-1.0.0")).unwrap();
        drop(tx);
        // 另一个好事务：只有 prepared 记录，恢复应成功
        let good = stage_pkg(&root, "g0", "good");
        let _ = begin_install(&root, "good", "1.0.0", &good, None);
        let problems = recover_transactions(&root);
        assert_eq!(problems.len(), 1, "只有坏插件需要修复");
        assert_eq!(problems[0].id, "hello");
        assert!(read_repair(&root, "hello").is_some(), "写 .repair.json");
        assert_eq!(load_state(&root).plugins["hello"].enabled, false, "停用受影响插件");
        assert!(!tx_path(&root, "good").exists(), "好插件照常恢复");
        assert!(read_repair(&root, "good").is_none());
        // 备份补回来后，「重试恢复」应能成功并清掉修复标记 / 事务记录
        fs::create_dir_all(plugin_dir(&root, "hello").join(".old-1.0.0")).unwrap();
        fs::write(plugin_dir(&root, "hello").join(".old-1.0.0/index.html"), b"<p>old</p>").unwrap();
        retry_recovery(&root, "hello").unwrap();
        assert!(read_repair(&root, "hello").is_none());
        assert!(!tx_path(&root, "hello").exists());
        assert_eq!(load_state(&root).plugins["hello"], old, "重试恢复把 state 还原成旧条目");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn tree_digest_mismatch_blocks_directory_delete() {
        let root = tmpdir("tx-tree-mismatch");
        let first = stage_pkg(&root, "s0", "old");
        fs::create_dir_all(plugin_dir(&root, "hello")).unwrap();
        fs::rename(&first, version_dir(&root, "hello", "1.0.0")).unwrap();
        seed_state(&root, entry("1.0.0", 'a', true));
        let staging = stage_pkg(&root, "s1", "new");
        let mut tx = begin_install(&root, "hello", "1.0.0", &staging, Some(entry("1.0.0", 'a', true))).unwrap();
        tx.swap().unwrap();
        // 换名之后目标目录被改坏，树摘要对不上：恢复不能删目录
        fs::write(tx.target().join("index.html"), b"tampered").unwrap();
        drop(tx);
        let problems = recover_transactions(&root);
        assert_eq!(problems.len(), 1);
        assert_eq!(fs::read(version_dir(&root, "hello", "1.0.0").join("index.html")).unwrap(), b"tampered");
        assert!(tx_path(&root, "hello").exists(), "失败时保留事务记录");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn tx_record_is_fsynced_and_roundtrips_stages() {
        let root = tmpdir("tx-fsync");
        fs::create_dir_all(plugin_dir(&root, "hello")).unwrap();
        let rec = TxRecord {
            version: "1.0.0".into(), backup: true, staging: ".staging-x".into(),
            stage: TxStage::StateWritten, committed: false,
            tree_sha256: "c".repeat(64),
            previous_state: Some(entry("0.9.0", 'a', true)),
            expected_state: Some(entry("1.0.0", 'b', true)),
        };
        write_tx(&root, "hello", &rec).unwrap();
        let back = read_tx(&tx_path(&root, "hello")).unwrap();
        assert_eq!(back.stage, TxStage::StateWritten);
        assert_eq!(back.previous_state, rec.previous_state);
        assert_eq!(back.expected_state, rec.expected_state);
        assert_eq!(back.tree_sha256, rec.tree_sha256);
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
