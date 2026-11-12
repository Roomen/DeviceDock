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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    let written = file.write_all(body).and_then(|_| file.flush());
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("无法写入插件目录：{e}"));
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("无法保存插件文件：{e}"));
    }
    Ok(())
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
// 崩溃恢复：begin_install 在任何目录换名之前把 .tx.json 落到 plugins/<id>/ 下。
// committed=false 表示「新包可能已就位但 state.json 还没提交」，启动时一律还原 .old-*；
// committed=true 表示状态已提交，启动时补做完清理。事务文件总是最后才删。
const TX_FILE: &str = ".tx.json";
const LOCK_FILE: &str = ".lock";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxRecord {
    pub version: String,
    pub backup: bool,
    pub staging: String,
    pub committed: bool,
}

fn tx_path(root: &Path, id: &str) -> PathBuf {
    plugin_dir(root, id).join(TX_FILE)
}

fn write_tx(root: &Path, id: &str, rec: &TxRecord) -> Result<(), String> {
    let body = serde_json::to_vec(rec).map_err(|e| format!("插件事务记录序列化失败：{e}"))?;
    write_atomic(&tx_path(root, id), &body)
}

fn read_tx(path: &Path) -> Result<TxRecord, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("无法读取插件事务记录：{e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("插件事务记录损坏：{e}"))
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

fn cleanup_after_commit(root: &Path, id: &str, rec: &TxRecord) -> Result<(), String> {
    prune_versions(root, id, &rec.version);
    if rec.backup {
        let backup = plugin_dir(root, id).join(format!(".old-{}", rec.version));
        if backup.exists() {
            fs::remove_dir_all(&backup).map_err(|e| format!("无法删除插件旧版本备份：{e}"))?;
        }
    }
    if !rec.staging.is_empty() {
        let st = root.join(&rec.staging);
        if st.exists() {
            fs::remove_dir_all(&st).map_err(|e| format!("无法删除插件临时目录：{e}"))?;
        }
    }
    Ok(())
}

fn restore_after_abort(root: &Path, id: &str, rec: &TxRecord) -> Result<(), String> {
    let target = checked_version_dir(root, id, &rec.version)?;
    let backup = plugin_dir(root, id).join(format!(".old-{}", rec.version));
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|e| format!("无法移除未提交的插件版本：{e}"))?;
    }
    if !rec.staging.is_empty() {
        let st = root.join(&rec.staging);
        if st.exists() {
            fs::remove_dir_all(&st).map_err(|e| format!("无法删除插件临时目录：{e}"))?;
        }
    }
    if rec.backup {
        if !backup.exists() {
            // 回滚错误绝不能吞掉：备份没了就不能假装已恢复，留着记录让下一次启动继续报
            return Err(format!("插件 {id} 的事务备份目录不存在，无法自动恢复"));
        }
        if !target.exists() {
            fs::rename(&backup, &target).map_err(|e| format!("无法还原插件旧版本：{e}"))?;
        }
    }
    Ok(())
}

// 应用启动时调用：把上次中断的安装事务收尾
pub fn recover_transactions(root: &Path) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(());
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
        let rec = read_tx(&tp)?;
        if rec.committed {
            cleanup_after_commit(root, &id, &rec)?;
        } else {
            restore_after_abort(root, &id, &rec)?;
        }
        fs::remove_file(&tp).map_err(|e| format!("无法删除插件事务记录：{e}"))?;
    }
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
    pub fn commit(&self) -> Result<(), String> {
        // 先标记已提交再清理：中途崩溃时恢复逻辑会补做清理，绝不会把旧包当成未提交而删掉
        let mut rec = self.rec.clone();
        rec.committed = true;
        write_tx(&self.root, &self.id, &rec)?;
        cleanup_after_commit(&self.root, &self.id, &rec)?;
        fs::remove_file(tx_path(&self.root, &self.id))
            .map_err(|e| format!("无法删除插件事务记录：{e}"))
    }
    pub fn rollback(&self) -> Result<(), String> {
        restore_after_abort(&self.root, &self.id, &self.rec)?;
        fs::remove_file(tx_path(&self.root, &self.id))
            .map_err(|e| format!("无法删除插件事务记录：{e}"))
    }
}

pub fn begin_install(root: &Path, id: &str, version: &str, staging: &Path) -> Result<InstallTx, String> {
    let target = checked_version_dir(root, id, version)?;
    let plugin_root = plugin_dir(root, id);
    fs::create_dir_all(&plugin_root).map_err(|e| format!("无法创建插件目录：{e}"))?;
    let backup_path = plugin_root.join(format!(".old-{version}"));
    let had_target = target.exists();
    let rec = TxRecord {
        version: version.to_string(),
        backup: had_target,
        staging: staging_name(staging),
        committed: false,
    };
    // 事务记录必须先落盘：崩溃点之后才有依据决定还原还是补做提交
    write_tx(root, id, &rec)?;
    if had_target {
        let _ = fs::remove_dir_all(&backup_path);
        if let Err(e) = fs::rename(&target, &backup_path) {
            let _ = fs::remove_file(tx_path(root, id));
            return Err(format!("无法替换已有插件版本：{e}"));
        }
    }
    if let Err(e) = fs::rename(staging, &target) {
        let _ = fs::remove_dir_all(staging);
        if had_target && backup_path.exists() && !target.exists() {
            let _ = fs::rename(&backup_path, &target);
        }
        let _ = fs::remove_file(tx_path(root, id));
        return Err(format!("无法放置插件文件：{e}"));
    }
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

    #[test]
    fn install_commit_prunes_other_versions_and_keeps_storage() {
        let root = tmpdir("install");
        let staging = root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("index.html"), b"x").unwrap();
        let tx = begin_install(&root, "hello", "1.0.0", &staging).unwrap();
        assert!(tx.target().exists());
        tx.commit().unwrap();
        fs::write(plugin_dir(&root, "hello").join(STORAGE_FILE), b"{}").unwrap();
        let staging2 = root.join("staging2");
        fs::create_dir_all(&staging2).unwrap();
        fs::write(staging2.join("index.html"), b"y").unwrap();
        let tx2 = begin_install(&root, "hello", "2.0.0", &staging2).unwrap();
        // 状态还没提交之前旧版本必须仍在，失败时才能回滚到它
        assert!(version_dir(&root, "hello", "1.0.0").exists());
        tx2.commit().unwrap();
        assert!(version_dir(&root, "hello", "2.0.0").exists());
        assert!(!version_dir(&root, "hello", "1.0.0").exists());
        assert!(plugin_dir(&root, "hello").join(STORAGE_FILE).exists());
        remove_plugin(&root, "hello").unwrap();
        assert!(!plugin_dir(&root, "hello").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rollback_restores_the_previous_version() {
        let root = tmpdir("rollback");
        let staging = root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("index.html"), b"old").unwrap();
        begin_install(&root, "hello", "1.0.0", &staging).unwrap().commit().unwrap();
        let staging2 = root.join("staging2");
        fs::create_dir_all(&staging2).unwrap();
        fs::write(staging2.join("index.html"), b"new").unwrap();
        // 同版本重装：先备份旧目录；state.json 保存失败时 rollback 要还原旧文件
        let tx = begin_install(&root, "hello", "1.0.0", &staging2).unwrap();
        assert_eq!(fs::read(tx.target().join("index.html")).unwrap(), b"new");
        tx.rollback().unwrap();
        assert_eq!(fs::read(version_dir(&root, "hello", "1.0.0").join("index.html")).unwrap(), b"old");
        assert!(!root.join("hello/.old-1.0.0").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rollback_of_a_new_version_keeps_the_installed_one() {
        let root = tmpdir("rollback-new");
        let first = root.join("s1");
        fs::create_dir_all(&first).unwrap();
        fs::write(first.join("index.html"), b"v1").unwrap();
        begin_install(&root, "hello", "1.0.0", &first).unwrap().commit().unwrap();
        let second = root.join("s2");
        fs::create_dir_all(&second).unwrap();
        fs::write(second.join("index.html"), b"v2").unwrap();
        let tx = begin_install(&root, "hello", "2.0.0", &second).unwrap();
        tx.rollback().unwrap();
        assert_eq!(fs::read(version_dir(&root, "hello", "1.0.0").join("index.html")).unwrap(), b"v1");
        assert!(!version_dir(&root, "hello", "2.0.0").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn version_paths_cannot_escape_the_plugin_dir() {
        let root = tmpdir("version-path");
        assert!(checked_version_dir(&root, "hello", "1.0.0-x/../../other").is_err());
        assert!(checked_version_dir(&root, "hello", "../evil").is_err());
        assert!(begin_install(&root, "hello", "1.0.0-x/../../other", &root.join("staging")).is_err());
        // 非法版本也绝不会被拼成可穿越的路径
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
                    st.plugins.insert(
                        format!("p{i}"),
                        Entry {
                            enabled: true,
                            repo: String::new(),
                            tag: String::new(),
                            version: "1.0.0".to_string(),
                            installed_at: i,
                            capabilities: vec![],
                            package_sha256: String::new(),
                        },
                    );
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
    fn transaction_record_is_written_before_the_swap() {
        let root = tmpdir("tx-record");
        let old = root.join("s0");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("index.html"), b"old").unwrap();
        let first = begin_install(&root, "hello", "1.0.0", &old).unwrap();
        first.commit().unwrap();
        let staging = root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("index.html"), b"new").unwrap();
        let tx = begin_install(&root, "hello", "1.0.0", &staging).unwrap();
        let rec = read_tx(&tx_path(&root, "hello")).unwrap();
        assert_eq!(rec.committed, false);
        assert_eq!(rec.backup, true);
        assert_eq!(fs::read(tx.target().join("index.html")).unwrap(), b"new");
        // 模拟进程被杀：不 commit 也不 rollback，启动时按未提交还原
        drop(tx);
        recover_transactions(&root).unwrap();
        assert_eq!(fs::read(version_dir(&root, "hello", "1.0.0").join("index.html")).unwrap(), b"old");
        assert!(!tx_path(&root, "hello").exists(), "恢复成功后事务记录必须删除");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn committed_transaction_is_finished_at_startup() {
        let root = tmpdir("tx-committed");
        let old = root.join("s0");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("index.html"), b"v1").unwrap();
        begin_install(&root, "hello", "1.0.0", &old).unwrap().commit().unwrap();
        let staging = root.join("staging2");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("index.html"), b"v2").unwrap();
        let tx = begin_install(&root, "hello", "2.0.0", &staging).unwrap();
        // 模拟「已标记提交但清理没做完」：手写 committed 记录
        write_tx(&root, "hello", &TxRecord {
            version: "2.0.0".into(), backup: false, staging: "staging2".into(), committed: true,
        }).unwrap();
        drop(tx);
        recover_transactions(&root).unwrap();
        assert_eq!(fs::read(version_dir(&root, "hello", "2.0.0").join("index.html")).unwrap(), b"v2");
        assert!(!version_dir(&root, "hello", "1.0.0").exists(), "已提交事务要补做清理");
        assert!(!tx_path(&root, "hello").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rollback_errors_are_not_ignored() {
        let root = tmpdir("tx-rollback-error");
        let first = root.join("s1");
        fs::create_dir_all(&first).unwrap();
        fs::write(first.join("index.html"), b"v1").unwrap();
        begin_install(&root, "hello", "1.0.0", &first).unwrap().commit().unwrap();
        let staging = root.join("staging");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("index.html"), b"v2").unwrap();
        let tx = begin_install(&root, "hello", "1.0.0", &staging).unwrap();
        // 备份目录被人为删掉：恢复/回滚必须报错，不能当作成功
        fs::remove_dir_all(root.join("hello/.old-1.0.0")).unwrap();
        assert!(tx.rollback().is_err());
        assert!(recover_transactions(&root).is_err());
        assert!(tx_path(&root, "hello").exists(), "失败时保留事务记录供下次恢复");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn baseline_and_sha256_checks() {
        assert!(valid_sha256(&"a".repeat(64)));
        assert!(valid_sha256(&"A".repeat(64)));
        assert!(!valid_sha256(""));
        assert!(!valid_sha256(&"a".repeat(63)));
        assert!(!valid_sha256(&("g".repeat(63) + "a")));
        let e = Entry {
            enabled: true, repo: String::new(), tag: String::new(), version: "1.0.0".into(),
            installed_at: 0, capabilities: vec![], package_sha256: "b".repeat(64),
        };
        assert!(baseline_matches(None, None, None));
        assert!(baseline_matches(Some(&e), Some("1.0.0"), Some(&"B".repeat(64))));
        assert!(!baseline_matches(Some(&e), Some("1.0.0"), Some(&"c".repeat(64))), "摘要变了要重新确认");
        assert!(!baseline_matches(Some(&e), Some("2.0.0"), Some(&"b".repeat(64))), "版本变了要重新确认");
        assert!(!baseline_matches(Some(&e), None, None), "原本为空基线但现在已安装");
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
