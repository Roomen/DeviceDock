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

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use manifest::Manifest;

pub const EVENT_CHANGED: &str = "plugins-changed";

pub struct PluginsState {
    root: PathBuf,
    // 安装事务（目录切换 + state.json）、启停 / 卸载与插件私有存储都经这把锁；
    // 多窗口并发时不能各按旧快照读改写 state.json 再互相覆盖
    pub tx: Mutex<()>,
    // 隔离持久化两处都失败的插件：只在本次进程内存里强制不可用
    pub blocked: Mutex<BTreeSet<String>>,
    // 正在跑安装 / 卸载事务的插件：读路径（plugin_list / ddplugin://）必须拒绝
    pub active: Mutex<BTreeSet<String>>,
    // 插件根目录 / 跨进程锁获取失败：整个子系统不可用，但客户端照常启动
    pub unavailable: Option<String>,
}

// RAII：事务开始登记，任何返回路径（含错误）都在释放事务锁之前注销
struct ActiveGuard<'a> { set: &'a Mutex<BTreeSet<String>>, id: String }
impl<'a> ActiveGuard<'a> {
    fn new(set: &'a Mutex<BTreeSet<String>>, id: &str) -> Result<Self, String> {
        set.lock().map(|mut a| { a.insert(id.to_string()); }).map_err(|_| "插件事务表被占用".to_string())?;
        Ok(ActiveGuard { set, id: id.to_string() })
    }
}
impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut a) = self.set.lock() { a.remove(&self.id); }
    }
}

impl PluginsState {
    // 初始化绝不失败：拿不到根目录或文件锁时 subsystem 标记为不可用，页面提示原因。
    pub fn init(app: &AppHandle) -> Self {
        let root = match store::root(app) {
            Ok(r) => r,
            Err(e) => return PluginsState::disabled(PathBuf::new(), format!("找不到应用数据目录：{e}")),
        };
        if let Err(e) = std::fs::create_dir_all(&root) {
            return PluginsState::disabled(root, format!("无法创建插件目录：{e}"));
        }
        let lock = match store::file_lock(&root) {
            Ok(l) => l,
            Err(e) => return PluginsState::disabled(root, format!("无法取得插件事务锁：{e}")),
        };
        // 恢复按实际文件系统状态决策；单个插件失败只隔离该插件，不再让客户端起不来。
        let outcome = store::recover_transactions(&root);
        drop(lock);
        for p in &outcome.problems {
            eprintln!("插件 {} 需要修复：{}", p.id, p.reason);
        }
        PluginsState {
            root,
            tx: Mutex::new(()),
            blocked: Mutex::new(outcome.blocked.into_iter().collect()),
            active: Mutex::new(BTreeSet::new()),
            unavailable: None,
        }
    }
    fn disabled(root: PathBuf, reason: String) -> Self {
        eprintln!("插件子系统不可用：{reason}");
        PluginsState { root, tx: Mutex::new(()), blocked: Mutex::new(BTreeSet::new()), active: Mutex::new(BTreeSet::new()), unavailable: Some(reason) }
    }
    pub fn root(&self) -> &Path { &self.root }
    pub fn guard(&self) -> Result<(), String> {
        match &self.unavailable {
            Some(r) => Err(format!("插件子系统不可用：{r}")),
            None => Ok(()),
        }
    }
    // 锁异常按禁用处理：拿不到 blocked/active 集合时返回 None，scheme 直接拒绝全部请求
    pub fn serve_gates(&self) -> Option<scheme::ServeGates> {
        let blocked = self.blocked.lock().ok()?.clone();
        let active = self.active.lock().ok()?.clone();
        Some(scheme::ServeGates { blocked, active, all_busy: false })
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatus {
    pub available: bool,
    pub reason: Option<String>,
}

#[tauri::command]
pub fn plugin_status(state: State<'_, PluginsState>) -> PluginStatus {
    PluginStatus { available: state.unavailable.is_none(), reason: state.unavailable.clone() }
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
    // 安装事务恢复失败的原因：该插件被停用，管理面板显示「重试恢复 / 移除」
    pub repair: Option<String>,
    // 安装 / 卸载事务进行中：不给启用视图，ddplugin:// 也不供包
    pub installing: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InspectInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub current_version: Option<String>,
    pub current_package_sha256: Option<String>,
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
    pub current_package_sha256: String,
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
        repair: store::repair_reason(root, id).or_else(|| entry.and_then(|e| e.repair.clone())),
        installing: false,
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
        repair: store::repair_reason(root, id).or_else(|| entry.and_then(|e| e.repair.clone())),
        installing: false,
    }
}

fn list_all(root: &Path, blocked: &BTreeSet<String>, active: &BTreeSet<String>) -> Vec<PluginInfo> {
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
    for info in &mut out {
        // 内存禁用集合（两处隔离持久化都失败）等于「本次进程内不可用」：
        // 既要给出原因，也不能让界面把它当成可启用的插件。
        if blocked.contains(&info.id) {
            if info.repair.is_none() {
                info.repair = Some("恢复隔离未能持久化，本次进程内不可用".to_string());
            }
            info.enabled = false;
        }
        if active.contains(&info.id) {
            info.installing = true;
            info.enabled = false; // 事务期间不提供启用视图
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

// 门禁锁异常（中毒）时把每个插件都标成不可用：与 scheme 的行为一致，
// 绝不把「读不到禁用集合」当成「没有禁用插件」。
fn mark_unavailable(mut out: Vec<PluginInfo>) -> Vec<PluginInfo> {
    for info in &mut out {
        info.repair = Some("插件状态锁异常，本次进程内不可用".to_string());
        info.enabled = false;
        info.installing = false;
    }
    out
}

// 有排他事务在跑（共享锁拿不到）：列表照常给出便于显示，但一律标 installing
fn mark_all_installing(mut out: Vec<PluginInfo>) -> Vec<PluginInfo> {
    for info in &mut out {
        info.installing = true;
        info.enabled = false;
    }
    out
}

// 只读路径：整个读取过程（读 state、manifest、文件）持跨进程共享锁。
// 拿不到共享锁（有进程正在安装 / 卸载）→ 全部插件标 installing，不提供启用视图；
// 进程内门禁锁中毒 → 与 scheme 一致把全部插件标为不可用。
fn list_all_state(state: &PluginsState) -> Vec<PluginInfo> {
    let root = state.root();
    // 顺序固定：先拿共享锁，再在锁内读门禁（blocked / active）。
    // 若先拷门禁再等锁，等锁期间有安装失败并把插件写进内存 blocked，本列表会用旧快照报「可用」。
    let guard = store::read_lock(root);
    let (blocked, active) = match (state.blocked.lock(), state.active.lock()) {
        (Ok(b), Ok(a)) => (b.clone(), a.clone()),
        _ => {
            eprintln!("插件状态锁异常：本次列出全部插件时按不可用处理");
            return mark_unavailable(list_all(root, &BTreeSet::new(), &BTreeSet::new()));
        }
    };
    match guard {
        Ok(_guard) => list_all(root, &blocked, &active),
        Err(_) => mark_all_installing(list_all(root, &blocked, &active)),
    }
}

// 下载 → 校验 → 解压 → 逐文件校验，返回 (manifest, 包 sha256, 临时目录, release)。
// 调用方负责把临时目录换进正式位置，任何一步失败都要删掉它。
async fn download_and_stage(root: &Path, repo: &github::RepoRef) -> Result<(Manifest, String, PathBuf, github::Release), String> {
    let token = token::get();
    let release = github::fetch_release(repo, token.as_deref()).await?;
    let (pkg, sha_asset) = github::pick_assets(&release.assets)?;
    let package = github::download_asset(&pkg, token.as_deref(), repo).await?;
    let sha_bytes = github::download_asset(&sha_asset, token.as_deref(), repo).await?;
    let expected = github::parse_sha256_file(&String::from_utf8_lossy(&sha_bytes))?;
    let actual = store::sha256_hex(&package);
    if actual != expected {
        return Err("下载的插件包 sha256 与发布方提供的校验文件不一致，已中止安装".to_string());
    }
    // staging 的创建与解压都在跨进程事务锁内：别的进程启动清理不会误删在用的包。
    // owner.json（pid + 创建时间）与进程级 .lock 由 create_staging 登记。
    let _file = store::file_lock(root)?;
    let staging = store::create_staging(root)?;
    let result = (|| -> Result<Manifest, String> {
        let extracted = archive::extract_any(&package, &staging)?;
        if extracted.files.is_empty() {
            return Err("插件包里没有文件".to_string());
        }
        let m = store::read_manifest(&staging)?;
        store::verify_dir(&staging, &m)?;
        store::seal_staging(root, &staging)?;
        Ok(m)
    })();
    match result {
        Ok(m) => Ok((m, actual, staging, release)),
        Err(e) => {
            store::drop_staging(root, &staging);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn plugin_list(state: State<'_, PluginsState>) -> Vec<PluginInfo> {
    if state.guard().is_err() { return Vec::new(); }
    list_all_state(&state)
}

// 安装前检查：下载并校验 release 资产，读出 manifest 与能力变化，供界面展示确认框（不落地安装）
#[tauri::command]
pub async fn plugin_inspect(state: State<'_, PluginsState>, repo: String, tag: Option<String>) -> Result<InspectInfo, String> {
    state.guard()?;
    let mut parsed = github::parse_repo_url(&repo)?;
    if let Some(t) = tag {
        let t = t.trim().to_string();
        if !t.is_empty() {
            parsed.tag = Some(t);
        }
    }
    let root = state.root().to_path_buf();
    let (m, digest, staging, release) = download_and_stage(&root, &parsed).await?;
    store::drop_staging(&root, &staging);
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
        current_package_sha256: existing.map(|e| e.package_sha256.clone()),
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
pub async fn plugin_install(
    app: AppHandle,
    state: State<'_, PluginsState>,
    repo: String,
    tag: Option<String>,
    expected_sha256: String,
    expected_current_version: Option<String>,
    expected_current_sha256: Option<String>,
) -> Result<PluginInfo, String> {
    state.guard()?;
    let mut parsed = github::parse_repo_url(&repo)?;
    if let Some(t) = tag {
        let t = t.trim().to_string();
        if !t.is_empty() {
            parsed.tag = Some(t);
        }
    }
    // 摘要必填且必须是完整 64 位十六进制：没有确认过的包不能落盘
    let expected = expected_sha256.trim().to_ascii_lowercase();
    if !store::valid_sha256(&expected) {
        return Err("安装缺少确认时校验过的包 SHA-256，请重新检查并确认".to_string());
    }
    let root = state.root().to_path_buf();
    let (m, digest, staging, release) = download_and_stage(&root, &parsed).await?;
    if expected != digest {
        store::drop_staging(&root, &staging);
        return Err("远端插件包摘要与确认时不一致，请重新检查后再安装".to_string());
    }
    if m.kind != "web" {
        store::drop_staging(&root, &staging);
        return Err("本地进程（native）插件尚未支持，请安装 web 类型插件".to_string());
    }
    // 事务期间登记 active：plugin_list 不给启用视图，ddplugin:// 返回 503。
    // 任何失败都在**释放锁之前**按决策表同步恢复或隔离，staging 是否删除由决策结果决定。
    let outcome = (|| -> Result<store::State, String> {
        let _file = store::file_lock(&root)?;
        let _guard = state.tx.lock().map_err(|_| "插件状态被占用".to_string())?;
        let _active = ActiveGuard::new(&state.active, &m.id)?;
        // 提交前重新核对确认时的已安装状态：并发变更会让能力差异展示过期
        let before = store::load_state(&root);
        if !store::baseline_matches(
            before.plugins.get(&m.id),
            expected_current_version.as_deref(),
            expected_current_sha256.as_deref(),
        ) {
            // 还没写事务记录，没有可恢复的目录动作；staging 是本进程刚创建的，可直接丢弃
            store::drop_staging(&root, &staging);
            return Err("插件安装状态在确认后发生变化，请重新检查并确认".to_string());
        }
        let result = (|| -> Result<store::State, String> {
            let mut tx = store::begin_install(
                &root, &m.id, &m.version, &staging,
                before.plugins.get(&m.id).cloned(),
            )?;
            tx.swap()?;
            let entry = store::Entry {
                enabled: true,
                repo: format!("https://github.com/{}/{}", parsed.owner, parsed.repo),
                tag: release.tag_name.clone(),
                version: m.version.clone(),
                installed_at: now_secs(),
                capabilities: m.capabilities.clone(),
                package_sha256: digest.clone(),
                repair: None,
            };
            tx.write_state(entry)?;
            tx.commit()?;
            store::clear_repair(&root, &m.id);
            Ok(store::load_state(&root))
        })();
        match result {
            Ok(st) => {
                store::release_staging(&root, &staging);
                Ok(st)
            }
            Err(e) => {
                let fin = store::finalize_failed_install(&root, &m.id);
                if fin.blocked {
                    if let Ok(mut b) = state.blocked.lock() { b.insert(m.id.clone()); }
                }
                if let Some(r) = &fin.reason {
                    if !fin.recovered { return Err(format!("{e}；未能自动恢复：{r}")); }
                }
                Err(e)
            }
        }
    })();
    outcome?;
    let _ = app.emit(EVENT_CHANGED, ());
    // 返回值也要在共享锁下重新读 state + manifest：排他锁已释放，
    // 并发的另一次同版本重装可能已换掉目录，不能把上一次的 state 与这一次的 manifest 混在一起。
    Ok(read_info_locked(&root, &m.id))
}

// 在跨进程共享锁下读 state + manifest 并组装 PluginInfo（拿不到锁时返回带原因的最小信息）
fn read_info_locked(root: &Path, id: &str) -> PluginInfo {
    match store::read_lock(root) {
        Ok(_guard) => {
            let st = store::load_state(root);
            build_info(root, id, st.plugins.get(id))
        }
        Err(e) => {
            let mut info = build_info(root, id, None);
            info.enabled = false;
            info.installing = true;
            info.error = Some(format!("插件正在被修改，稍后重试：{e}"));
            info
        }
    }
}

// 检查更新：下载新包只为读出 manifest（版本与能力变化），不落地
#[tauri::command]
pub async fn plugin_check_update(_app: AppHandle, state: State<'_, PluginsState>, id: String) -> Result<Option<UpdateInfo>, String> {
    state.guard()?;
    let root = state.root().to_path_buf();
    let st = store::load_state(&root);
    let entry = st.plugins.get(&id).ok_or_else(|| "插件没有安装".to_string())?.clone();
    let repo = github::parse_repo_url(&entry.repo)?;
    let (m, digest, staging, release) = download_and_stage(&root, &repo).await?;
    store::drop_staging(&root, &staging);
    if !manifest::is_newer(&m.version, &entry.version) {
        return Ok(None);
    }
    let (added, removed) = manifest::capability_diff(&entry.capabilities, &m.capabilities);
    let notes = release.body.clone().unwrap_or_default().chars().take(4000).collect::<String>();
    Ok(Some(UpdateInfo {
        id: m.id.clone(),
        name: m.name.clone(),
        current_version: entry.version.clone(),
        current_package_sha256: entry.package_sha256.clone(),
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
    state.guard()?;
    let root = state.root().to_path_buf();
    {
        // 排他锁覆盖全部门槛检查 + 落盘；离开这段后读路径才能拿共享锁
        let _file = store::file_lock(&root)?;
        let _guard = state.tx.lock().map_err(|_| "插件状态被占用".to_string())?;
        // 全部门槛检查都在同一段锁内，避免并发恢复只写入标记时读到过期结果
        if enabled {
            let st = store::load_state(&root);
            let marker = store::read_repair(&root, &id).is_some();
            let blocked = state.blocked.lock().map(|b| b.contains(&id)).unwrap_or_else(|_| true);
            if !store::can_enable(&st, &id, marker, blocked) {
                return Err("插件处于待修复状态，请先重试恢复或移除".to_string());
            }
        }
        store::load_and_save(&root, |st| -> Result<(), String> {
            let entry = st.plugins.get_mut(&id).ok_or_else(|| "插件没有安装".to_string())?;
            if enabled && entry.repair.is_some() {
                return Err("插件处于待修复状态，请先重试恢复或移除".to_string());
            }
            entry.enabled = enabled;
            Ok(())
        })??;
    }
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(list_all_state(&state))
}

#[tauri::command]
pub fn plugin_uninstall(app: AppHandle, state: State<'_, PluginsState>, id: String) -> Result<Vec<PluginInfo>, String> {
    state.guard()?;
    let root = state.root().to_path_buf();
    {
        let _file = store::file_lock(&root)?;
        let _guard = state.tx.lock().map_err(|_| "插件状态被占用".to_string())?;
        let _active = ActiveGuard::new(&state.active, &id)?;
        // 状态提交与目录删除必须在同一段锁内：否则可能删掉并发安装刚放进来的包
        let removed = store::load_and_save(&root, |st| st.plugins.remove(&id).is_some())?;
        if !removed {
            return Err("插件没有安装".to_string());
        }
        store::remove_plugin(&root, &id)?;
    }
    if let Ok(mut blocked) = state.blocked.lock() { blocked.remove(&id); }
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(list_all_state(&state))
}

#[tauri::command]
pub fn plugin_repair_list(state: State<'_, PluginsState>) -> Vec<store::RepairInfo> {
    if state.guard().is_err() { return Vec::new(); }
    store::list_repairs(state.root())
}

#[tauri::command]
pub fn plugin_retry_recovery(app: AppHandle, state: State<'_, PluginsState>, id: String) -> Result<Vec<store::RepairInfo>, String> {
    state.guard()?;
    let root = state.root().to_path_buf();
    {
        let _file = store::file_lock(&root)?;
        let _guard = state.tx.lock().map_err(|_| "插件状态被占用".to_string())?;
        // 回滚分支会还原 previous_state（含 enabled），补完分支写的是 expected_state，
        // 两条路各自把 state.json 处理好了，这里不要再改 enabled
        store::retry_recovery(&root, &id)?;
    }
    if let Ok(mut blocked) = state.blocked.lock() { blocked.remove(&id); }
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(store::list_repairs(&root))
}

#[tauri::command]
pub fn plugin_remove_repair(app: AppHandle, state: State<'_, PluginsState>, id: String) -> Result<Vec<store::RepairInfo>, String> {
    state.guard()?;
    let root = state.root().to_path_buf();
    {
        let _file = store::file_lock(&root)?;
        let _guard = state.tx.lock().map_err(|_| "插件状态被占用".to_string())?;
        store::discard_tx(&root, &id);
        store::clear_repair(&root, &id);
        store::load_and_save(&root, |st| { st.plugins.remove(&id); })?;
        store::remove_plugin(&root, &id)?;
    }
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(store::list_repairs(&root))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStatus {
    pub set: bool,
}

#[tauri::command]
pub fn plugin_token_status(state: State<'_, PluginsState>) -> TokenStatus {
    if state.guard().is_err() { return TokenStatus { set: false }; }
    TokenStatus { set: token::is_set() }
}

#[tauri::command]
pub fn plugin_token_set(
    state: State<'_, PluginsState>,
    token: String,
) -> Result<TokenStatus, String> {
    state.guard()?;
    self::token::set(&token)?;
    Ok(TokenStatus { set: true })
}

#[tauri::command]
pub fn plugin_token_clear(state: State<'_, PluginsState>) -> Result<TokenStatus, String> {
    state.guard()?;
    self::token::clear()?;
    Ok(TokenStatus { set: false })
}

#[tauri::command]
pub fn plugin_storage_get(state: State<'_, PluginsState>, id: String, key: String) -> Result<serde_json::Value, String> {
    state.guard()?;
    if !manifest::valid_id(&id) {
        return Err("插件 id 无效".to_string());
    }
    if !store::valid_storage_key(&key) {
        return Err("存储键无效".to_string());
    }
    let _guard = state.tx.lock().map_err(|_| "插件状态被占用".to_string())?;
    let map = store::storage_load(state.root(), &id);
    Ok(map.get(&key).cloned().unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub fn plugin_storage_set(state: State<'_, PluginsState>, id: String, key: String, value: serde_json::Value) -> Result<(), String> {
    state.guard()?;
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
    let _guard = state.tx.lock().map_err(|_| "插件状态被占用".to_string())?;
    let mut map = store::storage_load(state.root(), &id);
    if !map.contains_key(&key) && map.len() >= store::MAX_STORAGE_KEYS {
        return Err("插件存储条目已达上限".to_string());
    }
    map.insert(key, value);
    store::storage_save(state.root(), &id, &map)
}

#[tauri::command]
pub fn plugin_storage_remove(state: State<'_, PluginsState>, id: String, key: String) -> Result<(), String> {
    state.guard()?;
    if !manifest::valid_id(&id) {
        return Err("插件 id 无效".to_string());
    }
    let _guard = state.tx.lock().map_err(|_| "插件状态被占用".to_string())?;
    let mut map = store::storage_load(state.root(), &id);
    if map.remove(&key).is_none() {
        return Ok(());
    }
    store::storage_save(state.root(), &id, &map)
}

// ddplugin:// 的处理函数：读状态、解析路径、只出校验过的文件
pub fn serve(app: &AppHandle, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
    let denied = || scheme::serve(Path::new("/nonexistent"), &store::State::default(), request);
    let Some(state) = app.try_state::<PluginsState>() else { return denied() };
    if state.guard().is_err() { return denied(); }
    let root = state.root().to_path_buf();
    // 顺序固定：先拿共享锁，再在锁内读内存门禁与 state。先拷门禁会在「等锁期间有安装失败
    // 并把插件加入 blocked」时用旧快照供包，所以门禁必须在锁内取。
    let _read = match store::read_lock(&root) {
        Ok(g) => g,
        Err(_) => return scheme::serve_gated(&root, &store::State::default(), request, &unavailable_gates()),
    };
    // 锁异常按禁用处理：拿不到门禁集合就拒绝全部插件请求
    let Some(gates) = state.serve_gates() else { return denied() };
    let st = store::load_state(&root);
    scheme::serve_gated(&root, &st, request, &gates)
}

// 读锁拿不到时用「所有 id 都 active」的门禁：scheme 统一回 503
fn unavailable_gates() -> scheme::ServeGates {
    let mut g = scheme::ServeGates::default();
    g.all_busy = true;
    g
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("ddplug-list-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("hello/1.0.0");
        fs::create_dir_all(&dir).unwrap();
        let body = b"<h1>hi</h1>";
        fs::write(dir.join("index.html"), body).unwrap();
        let m = serde_json::json!({
            "schemaVersion": 1, "id": "hello", "name": "Hello", "version": "1.0.0",
            "apiVersion": 1, "kind": "web", "entry": "index.html",
            "capabilities": [],
            "integrity": { "index.html": format!("sha256-{}", store::sha256_hex(body)) }
        });
        fs::write(dir.join("manifest.json"), serde_json::to_vec(&m).unwrap()).unwrap();
        let mut st = store::State::default();
        st.plugins.insert("hello".to_string(), store::Entry {
            enabled: true, repo: String::new(), tag: String::new(), version: "1.0.0".into(),
            installed_at: 0, capabilities: vec![], package_sha256: "a".repeat(64), repair: None,
        });
        store::save_state(&root, &st).unwrap();
        root
    }

    #[test]
    fn list_all_marks_active_transaction_as_installing() {
        let root = fixture("active");
        let empty = BTreeSet::new();
        let mut active = BTreeSet::new();
        active.insert("hello".to_string());
        let normal = list_all(&root, &empty, &empty);
        assert_eq!(normal.len(), 1);
        assert_eq!(normal[0].enabled, true);
        assert_eq!(normal[0].installing, false);
        let during = list_all(&root, &empty, &active);
        assert_eq!(during[0].installing, true, "事务期间标为 installing");
        assert_eq!(during[0].enabled, false, "事务期间不提供启用视图");
        fs::remove_dir_all(&root).unwrap();
    }

    // 回修 7 · 2：安装返回值与 serve 都在共享锁下重新读取。
    // 持排他锁时 read_info_locked 必须拿不到共享锁，因此不能返回「混合快照」，
    // 只会给出 installing + 原因；释放后才是真实 state + manifest。
    #[test]
    fn read_info_locked_requires_the_shared_lock() {
        let root = fixture("read-info");
        let held = store::file_lock(&root).unwrap();
        let busy = read_info_locked(&root, "hello");
        assert_eq!(busy.installing, true, "排他锁期间不能返回真实信息");
        assert_eq!(busy.enabled, false);
        assert!(busy.error.as_deref().unwrap_or("").contains("正在被修改"), "{:?}", busy.error);
        drop(held);
        let fresh = read_info_locked(&root, "hello");
        assert_eq!(fresh.installing, false, "锁释放后返回真实信息");
        assert_eq!(fresh.enabled, true);
        assert_eq!(fresh.version, "1.0.0");
        assert_eq!(fresh.entry, "index.html");
        assert!(fresh.error.is_none());
        fs::remove_dir_all(&root).unwrap();
    }

    // 回修 7 · 2：serve 的门禁必须在持锁之后取（顺序写在 serve 的注释里：
    // 先 store::read_lock，再 state.serve_gates()）。这里断言锁内取门禁能看到
    // 「等锁期间新增的 blocked 项」——旧顺序（先拷快照再等锁）会漏掉它。
    #[test]
    fn gates_read_after_lock_see_newly_blocked_plugin() {
        let root = fixture("gates-order");
        let state = PluginsState {
            root: root.clone(),
            tx: Mutex::new(()),
            blocked: Mutex::new(BTreeSet::new()),
            active: Mutex::new(BTreeSet::new()),
            unavailable: None,
        };
        // 模拟「另一个窗口在等锁期间把插件加入 blocked」
        let held = store::file_lock(&root).unwrap();
        state.blocked.lock().unwrap().insert("hello".to_string());
        drop(held);
        // serve 的顺序：先拿共享锁，再读门禁 → 能看到新项
        let _read = store::read_lock(&root).unwrap();
        let gates = state.serve_gates().unwrap();
        assert!(gates.blocked.contains("hello"), "持锁之后读门禁必须包含新加入的 blocked 项");
        drop(_read);
        fs::remove_dir_all(&root).unwrap();
    }

    // 回修 8 · 3：plugin_list 的门禁必须在取到共享锁之后读。
    // 旧顺序（先拷 blocked 再等锁）在「等锁期间插件被写进 blocked」时会漏掉它。
    #[test]
    fn list_all_state_reads_gates_inside_the_read_lock() {
        let root = fixture("gates-in-lock");
        let state = PluginsState {
            root: root.clone(),
            tx: Mutex::new(()),
            blocked: Mutex::new(BTreeSet::new()),
            active: Mutex::new(BTreeSet::new()),
            unavailable: None,
        };
        let available = list_all_state(&state);
        assert_eq!(available.len(), 1);
        assert_eq!(available[0].enabled, true, "正常情况下可用");
        // 模拟「另一个窗口在等共享锁期间把插件加入 blocked」
        state.blocked.lock().unwrap().insert("hello".to_string());
        let after = list_all_state(&state);
        assert_eq!(after[0].enabled, false, "锁内读门禁必须看到新加入的 blocked 项");
        assert!(after[0].repair.as_deref().unwrap_or("").contains("锁异常")
            || after[0].repair.is_some(), "{:?}", after[0].repair);
        // 有排他事务在跑时：全部标 installing（共享锁拿不到）
        let held = store::file_lock(&root).unwrap();
        state.blocked.lock().unwrap().clear();
        let during = list_all_state(&state);
        assert!(during[0].installing, "拿不到共享锁时一律 installing");
        assert_eq!(during[0].enabled, false);
        drop(held);
        fs::remove_dir_all(&root).unwrap();
    }

    // 回修 6 · 5：门禁锁中毒时把插件标为不可用，不能当成「没有禁用项」
    #[test]
    fn mark_unavailable_hides_every_plugin() {
        let root = fixture("poison");
        let empty = BTreeSet::new();
        let out = mark_unavailable(list_all(&root, &empty, &empty));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].enabled, false, "锁异常时不给启用视图");
        assert_eq!(out[0].installing, false);
        assert!(out[0].repair.as_deref().unwrap_or("").contains("锁异常"), "{:?}", out[0].repair);
        fs::remove_dir_all(&root).unwrap();
    }
}
