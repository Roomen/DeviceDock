// 客户端插件宿主（仅桌面客户端）的 Rust 侧：安装 / 更新 / 停用 / 卸载、逐文件校验、ddplugin:// 供包、
// 插件私有存储与 GitHub 令牌。页面侧 js/plugin-host.js 只经这些命令与本模块交互；插件 UI 在 sandbox iframe 里，
// 能力校验在页面侧(js/plugin-rpc.js)逐次做，这里不做设备业务。
//
// 信任模型：装一次 = 用户确认一次。安装对话框列出能力与来源/版本/sha256 前 12 位，安装后即为「已确认」版本；
// 更新时必须重新确认（能力有变化更要重新确认），停用插件立刻让 ddplugin:// 不再出它的文件。
pub mod archive;
pub mod github;
pub mod manifest;
pub mod scheme;
pub mod store;
pub mod token;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use manifest::Manifest;

pub const EVENT_CHANGED: &str = "plugins-changed";

pub struct PluginsState {
    root: PathBuf,
    // 插件私有存储是「读全部 → 改一项 → 原子写」，多窗口同时写要串行
    storage: Mutex<()>,
}

impl PluginsState {
    pub fn init(app: &AppHandle) -> Result<Self, String> {
        let root = store::root(app)?;
        std::fs::create_dir_all(&root).map_err(|e| format!("无法创建插件目录：{e}"))?;
        Ok(PluginsState { root, storage: Mutex::new(()) })
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub kind: String,
    pub capabilities: Vec<String>,
    pub platforms: Option<Vec<String>>,
    pub entry: String,
    pub icon: Option<String>,
    pub homepage: Option<String>,
    pub license: Option<String>,
    pub repo: String,
    pub tag: String,
    pub enabled: bool,
    pub installed_at: u64,
    pub package_sha256: String,
    // 当前系统能不能跑（platforms 不含本机时仍列出，但加载入口不出现）
    pub supported: bool,
    // manifest 读不出来或校验失败时的原因：仍列出，用户可以卸载
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InspectInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub current_version: Option<String>,
    pub repo: String,
    pub tag: String,
    pub package_sha256: String,
    pub capabilities: Vec<String>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub supported: bool,
    pub notes: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub id: String,
    pub name: String,
    pub current_version: String,
    pub version: String,
    pub repo: String,
    pub tag: String,
    pub package_sha256: String,
    pub capabilities: Vec<String>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub notes: String,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn current_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn repo_url(repo: &str) -> String {
    repo.to_string()
}

// 已安装插件：以磁盘上的 manifest 为准，state.json 只提供启用状态与来源
fn build_info(root: &Path, id: &str, entry: Option<&store::Entry>) -> PluginInfo {
    let version = entry.map(|e| e.version.clone()).unwrap_or_default();
    let dir = store::version_dir(root, id, &version);
    let fallback = || PluginInfo {
        id: id.to_string(),
        name: id.to_string(),
        version: version.clone(),
        api_version: manifest::API_VERSION,
        kind: "web".to_string(),
        capabilities: entry.map(|e| e.capabilities.clone()).unwrap_or_default(),
        platforms: None,
        entry: "index.html".to_string(),
        icon: None,
        homepage: None,
        license: None,
        repo: entry.map(|e| repo_url(&e.repo)).unwrap_or_default(),
        tag: entry.map(|e| e.tag.clone()).unwrap_or_default(),
        enabled: entry.map(|e| e.enabled).unwrap_or(false),
        installed_at: entry.map(|e| e.installed_at).unwrap_or(0),
        package_sha256: entry.map(|e| e.package_sha256.clone()).unwrap_or_default(),
        supported: true,
        error: Some("插件文件缺失或已损坏，请重新安装".to_string()),
    };
    let m: Manifest = match store::read_manifest(&dir) {
        Ok(m) => m,
        Err(e) => {
            let mut info = fallback();
            info.error = Some(e);
            return info;
        }
    };
    PluginInfo {
        id: m.id.clone(),
        name: m.name.clone(),
        version: m.version.clone(),
        api_version: m.api_version,
        kind: m.kind.clone(),
        capabilities: m.capabilities.clone(),
        platforms: m.platforms.clone(),
        entry: m.entry.clone(),
        icon: m.icon.clone(),
        homepage: m.homepage.clone(),
        license: m.license.clone(),
        repo: entry.map(|e| repo_url(&e.repo)).unwrap_or_default(),
        tag: entry.map(|e| e.tag.clone()).unwrap_or_default(),
        enabled: entry.map(|e| e.enabled).unwrap_or(false),
        installed_at: entry.map(|e| e.installed_at).unwrap_or(0),
        package_sha256: entry.map(|e| e.package_sha256.clone()).unwrap_or_default(),
        supported: m.runs_on(current_os()),
        error: None,
    }
}

fn list_all(root: &Path) -> Vec<PluginInfo> {
    let state = store::load_state(root);
    let mut out: Vec<PluginInfo> = Vec::new();
    for (id, entry) in &state.plugins {
        out.push(build_info(root, id, Some(entry)));
    }
    // 磁盘上有目录但 state 里没有（存档损坏 / 手工拷贝）：只报告，不自动加载
    if let Ok(entries) = std::fs::read_dir(root) {
        for dir in entries.flatten() {
            let name = dir.file_name().to_string_lossy().to_string();
            if !dir.path().is_dir() || name.starts_with('.') || state.plugins.contains_key(&name) {
                continue;
            }
            if manifest::valid_id(&name) {
                out.push(build_info(root, &name, None));
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn staging_dir(root: &Path) -> Result<PathBuf, String> {
    let mut suffix = [0u8; 8];
    getrandom::fill(&mut suffix).map_err(|_| "系统熵源不可用".to_string())?;
    let dir = root.join(format!(".staging-{}", suffix.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建临时目录：{e}"))?;
    Ok(dir)
}

// 下载 → 校验 → 解压 → 逐文件校验，返回 (manifest, 包 sha256, 临时目录, release)。
// 调用方负责把临时目录换进正式位置，任何一步失败都要删掉它。
async fn download_and_stage(root: &Path, repo: &github::RepoRef) -> Result<(Manifest, String, PathBuf, github::Release), String> {
    let token = token::get();
    let release = github::fetch_release(repo, token.as_deref()).await?;
    let (pkg, sha_asset) = github::pick_assets(&release.assets)?;
    let package = github::download_asset(&pkg, token.as_deref()).await?;
    let sha_bytes = github::download_asset(&sha_asset, token.as_deref()).await?;
    let expected = github::parse_sha256_file(&String::from_utf8_lossy(&sha_bytes))?;
    let actual = store::sha256_hex(&package);
    if actual != expected {
        return Err("下载的插件包 sha256 与发布方提供的校验文件不一致，已中止安装".to_string());
    }
    let staging = staging_dir(root)?;
    let result = (|| -> Result<Manifest, String> {
        let extracted = archive::extract_any(&package, &staging)?;
        if extracted.files.is_empty() {
            return Err("插件包里没有文件".to_string());
        }
        let m = store::read_manifest(&staging)?;
        store::verify_dir(&staging, &m)?;
        Ok(m)
    })();
    match result {
        Ok(m) => Ok((m, actual, staging, release)),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn plugin_list(state: State<'_, PluginsState>) -> Vec<PluginInfo> {
    list_all(state.root())
}

// 安装前检查：下载并校验 release 资产，读出 manifest 与能力变化，供界面展示确认框（不落地安装）
#[tauri::command]
pub async fn plugin_inspect(state: State<'_, PluginsState>, repo: String, tag: Option<String>) -> Result<InspectInfo, String> {
    let mut parsed = github::parse_repo_url(&repo)?;
    if let Some(t) = tag {
        let t = t.trim().to_string();
        if !t.is_empty() {
            parsed.tag = Some(t);
        }
    }
    let root = state.root().to_path_buf();
    let (m, digest, staging, release) = download_and_stage(&root, &parsed).await?;
    let _ = std::fs::remove_dir_all(&staging);
    if m.kind != "web" {
        return Err("本地进程（native）插件尚未支持，请安装 web 类型插件".to_string());
    }
    let st = store::load_state(&root);
    let existing = st.plugins.get(&m.id);
    let (added, removed) = match existing {
        Some(prev) => manifest::capability_diff(&prev.capabilities, &m.capabilities),
        None => (m.capabilities.clone(), Vec::new()),
    };
    let notes = release.body.clone().unwrap_or_default().chars().take(4000).collect::<String>();
    Ok(InspectInfo {
        id: m.id.clone(),
        name: m.name.clone(),
        version: m.version.clone(),
        current_version: existing.map(|e| e.version.clone()),
        repo: format!("https://github.com/{}/{}", parsed.owner, parsed.repo),
        tag: release.tag_name,
        package_sha256: digest,
        capabilities: m.capabilities.clone(),
        added,
        removed,
        supported: m.runs_on(current_os()),
        notes,
    })
}

#[tauri::command]
pub async fn plugin_install(app: AppHandle, state: State<'_, PluginsState>, repo: String, tag: Option<String>, expected_sha256: Option<String>) -> Result<PluginInfo, String> {
    let mut parsed = github::parse_repo_url(&repo)?;
    if let Some(t) = tag {
        let t = t.trim().to_string();
        if !t.is_empty() {
            parsed.tag = Some(t);
        }
    }
    let root = state.root().to_path_buf();
    let (m, digest, staging, release) = download_and_stage(&root, &parsed).await?;
    if let Some(exp) = expected_sha256.as_deref() {
        let norm = exp.trim().to_ascii_lowercase();
        if !norm.is_empty() && norm != digest {
            let _ = std::fs::remove_dir_all(&staging);
            return Err("远端插件包摘要与确认时不一致，请重新检查后再安装".to_string());
        }
    }
    if m.kind != "web" {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("本地进程（native）插件尚未支持，请安装 web 类型插件".to_string());
    }
    let installed = store::install_dir(&root, &m.id, &m.version, &staging);
    let target = match installed {
        Ok(t) => t,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    let mut st = store::load_state(&root);
    st.plugins.insert(
        m.id.clone(),
        store::Entry {
            // 安装对话框就是本次确认：装完即可用，用户可随时在管理面板停用
            enabled: true,
            repo: format!("https://github.com/{}/{}", parsed.owner, parsed.repo),
            tag: release.tag_name.clone(),
            version: m.version.clone(),
            installed_at: now_secs(),
            capabilities: m.capabilities.clone(),
            package_sha256: digest,
        },
    );
    if let Err(e) = store::save_state(&root, &st) {
        let _ = std::fs::remove_dir_all(&target);
        return Err(e);
    }
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(build_info(&root, &m.id, st.plugins.get(&m.id)))
}

// 检查更新：下载新包只为读出 manifest（版本与能力变化），不落地
#[tauri::command]
pub async fn plugin_check_update(_app: AppHandle, state: State<'_, PluginsState>, id: String) -> Result<Option<UpdateInfo>, String> {
    let root = state.root().to_path_buf();
    let st = store::load_state(&root);
    let entry = st.plugins.get(&id).ok_or_else(|| "插件没有安装".to_string())?.clone();
    let repo = github::parse_repo_url(&entry.repo)?;
    let (m, digest, staging, release) = download_and_stage(&root, &repo).await?;
    let _ = std::fs::remove_dir_all(&staging);
    if !manifest::is_newer(&m.version, &entry.version) {
        return Ok(None);
    }
    let (added, removed) = manifest::capability_diff(&entry.capabilities, &m.capabilities);
    let notes = release.body.clone().unwrap_or_default().chars().take(4000).collect::<String>();
    Ok(Some(UpdateInfo {
        id: m.id.clone(),
        name: m.name.clone(),
        current_version: entry.version.clone(),
        version: m.version.clone(),
        repo: entry.repo.clone(),
        tag: release.tag_name.clone(),
        package_sha256: digest,
        capabilities: m.capabilities.clone(),
        added,
        removed,
        notes,
    }))
}

#[tauri::command]
pub fn plugin_set_enabled(app: AppHandle, state: State<'_, PluginsState>, id: String, enabled: bool) -> Result<Vec<PluginInfo>, String> {
    let root = state.root().to_path_buf();
    let mut st = store::load_state(&root);
    {
        let entry = st.plugins.get_mut(&id).ok_or_else(|| "插件没有安装".to_string())?;
        entry.enabled = enabled;
    }
    store::save_state(&root, &st)?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(list_all(&root))
}

#[tauri::command]
pub fn plugin_uninstall(app: AppHandle, state: State<'_, PluginsState>, id: String) -> Result<Vec<PluginInfo>, String> {
    let root = state.root().to_path_buf();
    let mut st = store::load_state(&root);
    st.plugins.remove(&id);
    store::save_state(&root, &st)?;
    store::remove_plugin(&root, &id)?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(list_all(&root))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStatus {
    pub set: bool,
}

#[tauri::command]
pub fn plugin_token_status() -> TokenStatus {
    TokenStatus { set: token::is_set() }
}

#[tauri::command]
pub fn plugin_token_set(
    token: String,
) -> Result<TokenStatus, String> {
    self::token::set(&token)?;
    Ok(TokenStatus { set: true })
}

#[tauri::command]
pub fn plugin_token_clear() -> Result<TokenStatus, String> {
    self::token::clear()?;
    Ok(TokenStatus { set: false })
}

#[tauri::command]
pub fn plugin_storage_get(state: State<'_, PluginsState>, id: String, key: String) -> Result<serde_json::Value, String> {
    if !manifest::valid_id(&id) {
        return Err("插件 id 无效".to_string());
    }
    if !store::valid_storage_key(&key) {
        return Err("存储键无效".to_string());
    }
    let _guard = state.storage.lock().map_err(|_| "插件存储被占用".to_string())?;
    let map = store::storage_load(state.root(), &id);
    Ok(map.get(&key).cloned().unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub fn plugin_storage_set(state: State<'_, PluginsState>, id: String, key: String, value: serde_json::Value) -> Result<(), String> {
    if !manifest::valid_id(&id) {
        return Err("插件 id 无效".to_string());
    }
    if !store::valid_storage_key(&key) {
        return Err("存储键无效".to_string());
    }
    let body = serde_json::to_vec(&value).map_err(|e| format!("存储值无法序列化：{e}"))?;
    if body.len() > store::MAX_STORAGE_VALUE_BYTES {
        return Err("单个存储值不能超过 64 KiB".to_string());
    }
    let _guard = state.storage.lock().map_err(|_| "插件存储被占用".to_string())?;
    let mut map = store::storage_load(state.root(), &id);
    if !map.contains_key(&key) && map.len() >= store::MAX_STORAGE_KEYS {
        return Err("插件存储条目已达上限".to_string());
    }
    map.insert(key, value);
    store::storage_save(state.root(), &id, &map)
}

#[tauri::command]
pub fn plugin_storage_remove(state: State<'_, PluginsState>, id: String, key: String) -> Result<(), String> {
    if !manifest::valid_id(&id) {
        return Err("插件 id 无效".to_string());
    }
    let _guard = state.storage.lock().map_err(|_| "插件存储被占用".to_string())?;
    let mut map = store::storage_load(state.root(), &id);
    if map.remove(&key).is_none() {
        return Ok(());
    }
    store::storage_save(state.root(), &id, &map)
}

// ddplugin:// 的处理函数：读状态、解析路径、只出校验过的文件
pub fn serve(app: &AppHandle, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
    let root = match app.try_state::<PluginsState>() {
        Some(state) => state.root().to_path_buf(),
        None => return scheme::serve(Path::new("/nonexistent"), &store::State::default(), request),
    };
    let st = store::load_state(&root);
    scheme::serve(&root, &st, request)
}

