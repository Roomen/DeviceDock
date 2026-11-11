//! Content-addressed executable plugins. Trust authorizes unsandboxed OS code, not device access.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager, State, Webview};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot, watch},
};
const MAX_JSON: usize = 44 * 1024 * 1024;
const MAX_MESSAGE: usize = 64 * 1024;
const DEADLINE: Duration = Duration::from_secs(5);
type Result<T> = std::result::Result<T, String>;
fn io<T>(r: std::io::Result<T>) -> Result<T> {
    r.map_err(|_| "Native plugin storage/process operation failed".into())
}
fn digest(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn safe_path(s: &str) -> bool {
    !s.is_empty()
        && s.len() < 200
        && s.split('/').all(|p| {
            let base = p.split('.').next().unwrap_or("").to_ascii_uppercase();
            let device = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (base.len() == 4
                    && (base.starts_with("COM") || base.starts_with("LPT"))
                    && matches!(base.as_bytes()[3], b'1'..=b'9'));
            !p.is_empty()
                && p != "."
                && p != ".."
                && !p.ends_with('.')
                && !device
                && p.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        })
}
fn target() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    schema_version: u32,
    kind: String,
    id: String,
    name: String,
    version: String,
    target: String,
    executable: String,
    page: String,
    methods: Vec<String>,
    integrity: BTreeMap<String, String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bundle {
    manifest: Manifest,
    files: BTreeMap<String, String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    hash: String,
    manifest: Manifest,
    trusted: bool,
    running: bool,
    error: Option<String>,
}
fn parse(raw: &str, hash: &str) -> Result<(Manifest, BTreeMap<String, Vec<u8>>)> {
    if raw.len() > MAX_JSON || !valid_hash(hash) || digest(raw.as_bytes()) != hash {
        return Err("Native package digest mismatch or size limit".into());
    }
    let b: Bundle = serde_json::from_str(raw).map_err(|_| "Invalid native package JSON")?;
    let m = b.manifest;
    if m.schema_version != 1
        || m.kind != "native-process"
        || m.target != target()
        || !safe_path(&m.executable)
        || !safe_path(&m.page)
        || m.executable == m.page
        || m.id.is_empty()
        || m.id.len() > 128
        || !m
            .id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
        || m.name.is_empty()
        || m.name.len() > 120
        || m.version.len() > 80
        || m.methods.len() > 64
        || m.methods.iter().any(|s| {
            s == "initialize"
                || s.is_empty()
                || s.len() > 80
                || !s
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        })
        || b.files.len() > 128
        || b.files.len() != m.integrity.len()
    {
        return Err("Incompatible native manifest/platform".into());
    }
    let mut files = BTreeMap::new();
    let mut aliases = BTreeSet::new();
    let mut size = 0;
    for (path, encoded) in b.files {
        if !safe_path(&path)
            || path.eq_ignore_ascii_case("__bundle.json")
            || !aliases.insert(path.to_ascii_lowercase())
        {
            return Err("Invalid native package path".into());
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "Invalid native package base64")?;
        size += bytes.len();
        if size > 32 * 1024 * 1024
            || m.integrity.get(&path) != Some(&format!("sha256-{}", digest(&bytes)))
        {
            return Err("Native file digest mismatch or size limit".into());
        }
        files.insert(path, bytes);
    }
    if !files.contains_key(&m.executable)
        || !files.contains_key(&m.page)
        || files[&m.page].len() > 512 * 1024
        || std::str::from_utf8(&files[&m.page]).is_err()
    {
        return Err("Missing executable or invalid self-contained HTML page".into());
    }
    Ok((m, files))
}
// Check every existing ancestor as well as the leaf; never follow a package/store symlink.
fn checked(path: &Path) -> Result<PathBuf> {
    let mut p = PathBuf::new();
    for c in path.components() {
        p.push(c);
        let meta = io(fs::symlink_metadata(&p))?;
        if meta.file_type().is_symlink() {
            return Err("Native store symlink rejected".into());
        }
    }
    Ok(p)
}
fn load(root: &Path, hash: &str) -> Result<(Manifest, BTreeMap<String, Vec<u8>>)> {
    if !valid_hash(hash) {
        return Err("Invalid native digest".into());
    }
    let base = checked(&root.join(hash))?;
    let bundle = checked(&base.join("__bundle.json"))?;
    if io(fs::metadata(&bundle))?.len() > MAX_JSON as u64 {
        return Err("Installed native bundle too large".into());
    }
    let raw = io(fs::read_to_string(bundle))?;
    let (m, files) = parse(&raw, hash)?;
    for (name, expected) in &files {
        let file = checked(&base.join(name))?;
        if io(fs::metadata(&file))?.len() != expected.len() as u64
            || io(fs::read(file))? != *expected
        {
            return Err("Installed native package modified".into());
        }
    }
    Ok((m, files))
}
fn install(root: &Path, raw: &str, hash: &str) -> Result<Manifest> {
    let (m, files) = parse(raw, hash)?;
    io(fs::create_dir_all(root))?;
    checked(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        io(fs::set_permissions(root, fs::Permissions::from_mode(0o700)))?;
    }
    if root.join(hash).exists() {
        load(root, hash)?;
        return Ok(m);
    }
    // Unique staging directory; never reuse/remove a pre-existing path.
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "Random source unavailable")?;
    let stage = root.join(format!(".stage-{}", digest(&random)));
    io(fs::create_dir(&stage))?;
    let result = (|| {
        for (name, bytes) in files {
            let dest = stage.join(&name);
            io(fs::create_dir_all(dest.parent().unwrap()))?;
            io(fs::write(&dest, bytes))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                io(fs::set_permissions(
                    &dest,
                    fs::Permissions::from_mode(if name == m.executable { 0o500 } else { 0o400 }),
                ))?;
            }
        }
        io(fs::write(stage.join("__bundle.json"), raw))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            io(fs::set_permissions(
                stage.join("__bundle.json"),
                fs::Permissions::from_mode(0o400),
            ))?;
        }
        io(fs::rename(&stage, root.join(hash)))?;
        Ok(m)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(stage);
    }
    result
}
fn trusted(root: &Path) -> Result<BTreeSet<String>> {
    let path = root.join("trust.json");
    if !path.exists() {
        return Ok(BTreeSet::new());
    }
    checked(&path)?;
    let bytes = io(fs::read(path))?;
    if bytes.len() > 128 * 1024 {
        return Err("Native trust store too large".into());
    }
    let values: BTreeSet<String> =
        serde_json::from_slice(&bytes).map_err(|_| "Native trust store damaged")?;
    if values.iter().any(|s| !valid_hash(s)) {
        return Err("Native trust store damaged".into());
    }
    Ok(values)
}
fn set_trust(root: &Path, hash: &str, allow: bool) -> Result<()> {
    if !valid_hash(hash) {
        return Err("Invalid native digest".into());
    }
    let mut values = trusted(root)?;
    if allow {
        load(root, hash)?;
        if values.len() >= 1024 {
            return Err("Native trust limit reached".into());
        }
        values.insert(hash.into());
    } else {
        values.remove(hash);
    }
    let temp = root.join("trust.tmp");
    if temp.exists() {
        checked(&temp)?;
    }
    io(fs::write(&temp, serde_json::to_vec(&values).unwrap()))?;
    // Windows rename cannot replace an existing file. Revocation is fail-closed across this gap.
    #[cfg(windows)]
    if root.join("trust.json").exists() {
        io(fs::remove_file(checked(&root.join("trust.json"))?))?;
    }
    io(fs::rename(temp, root.join("trust.json")))
}
struct Request {
    method: String,
    params: Value,
    reply: oneshot::Sender<Result<Value>>,
    deadline: tokio::time::Instant,
}
pub(crate) struct Running {
    tx: mpsc::Sender<Request>,
    stop: watch::Sender<bool>,
    ready: Arc<std::sync::atomic::AtomicBool>,
    done: watch::Receiver<bool>,
    error: Arc<Mutex<Option<String>>>,
}
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}
#[derive(Default)]
struct Inner {
    processes: HashMap<(String, String), Arc<Running>>,
    blocked: BTreeSet<String>,
}
#[derive(Default)]
pub struct NativePluginState {
    exiting: std::sync::atomic::AtomicBool,
    inner: Mutex<Inner>,
    owners: crate::lease::OwnerSet,
    storage: Mutex<()>,
}
impl NativePluginState {
    pub fn begin_shutdown(&self) {
        let _lock = self.inner.lock().unwrap();
        self.exiting
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn release(&self, owner: &str) -> crate::lease::OwnerRelease<Vec<Arc<Running>>> {
        let inner = self.inner.lock().unwrap();
        let lifecycle = self.owners.owner(owner);
        lifecycle.invalidate();
        let processes = inner
            .processes
            .iter()
            .filter(|((o, _), _)| o == owner)
            .map(|(_, p)| {
                let _ = p.stop.send(true);
                p.clone()
            })
            .collect();
        crate::lease::OwnerRelease::new(lifecycle, processes)
    }
    pub async fn release_all(&self) {
        let processes = {
            let inner = self.inner.lock().unwrap();
            inner
                .processes
                .values()
                .map(|p| {
                    let _ = p.stop.send(true);
                    p.clone()
                })
                .collect::<Vec<_>>()
        };
        for p in processes {
            p.finished().await;
        }
    }
    fn launch(
        &self,
        owner: &str,
        hash: &str,
        path: PathBuf,
        cwd: PathBuf,
        notify: Option<Box<dyn FnOnce() + Send>>,
    ) -> Result<oneshot::Receiver<Result<()>>> {
        let mut inner = self.inner.lock().unwrap();
        if self.exiting.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Native host shutting down".into());
        }
        let operation = self.owners.owner(owner).begin(None)?;
        let key = (owner.to_string(), hash.to_string());
        if inner.blocked.contains(hash) {
            return Err("Native package mutation in progress".into());
        }
        if inner.processes.get(&key).is_some_and(|p| !*p.done.borrow()) {
            return Err("Native plugin already starting/running".into());
        }
        inner.processes.retain(|_, p| !*p.done.borrow());
        if inner.processes.len() >= 16 {
            return Err("Native process limit reached".into());
        }
        let (tx, rx) = mpsc::channel(8);
        let (stop, stopped) = watch::channel(false);
        let (started, received) = oneshot::channel();
        let (done, finished) = watch::channel(false);
        let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let error = Arc::new(Mutex::new(None));
        if !operation.is_current() {
            return Err("Native owner session released".into());
        }
        inner.processes.insert(
            key,
            Arc::new(Running {
                tx,
                stop,
                ready: ready.clone(),
                done: finished,
                error: error.clone(),
            }),
        );
        tauri::async_runtime::spawn(run_process(
            path, cwd, rx, stopped, ready, started, done, notify, error,
        ));
        Ok(received)
    }
    fn stop_hash(&self, hash: &str) -> Vec<Arc<Running>> {
        self.inner
            .lock()
            .unwrap()
            .processes
            .iter()
            .filter(|((_, h), _)| h == hash)
            .map(|(_, p)| {
                let _ = p.stop.send(true);
                p.clone()
            })
            .collect()
    }
}
impl Running {
    async fn finished(&self) {
        let mut done = self.done.clone();
        while !*done.borrow_and_update() {
            if done.changed().await.is_err() {
                break;
            }
        }
    }
}
pub async fn finish_release(release: crate::lease::OwnerRelease<Vec<Arc<Running>>>) {
    for p in &release.payload {
        p.finished().await;
    }
}
// Process tree guard: children inherit a dedicated Unix group / Windows kill-on-close job.
struct ProcessTree {
    #[cfg(unix)]
    pid: i32,
    #[cfg(windows)]
    job: isize,
}
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
impl ProcessTree {
    fn attach(child: &tokio::process::Child) -> Result<Self> {
        #[cfg(unix)]
        {
            Ok(Self {
                pid: child.id().ok_or("Missing child PID")? as i32,
            })
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::{
                Foundation::*,
                System::{JobObjects::*, Threading::*},
            };
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err("Cannot create plugin job".into());
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let process = OpenProcess(
                    PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                    false as i32,
                    child.id().ok_or("Missing child PID")?,
                );
                let ok = !process.is_null()
                    && SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        &limits as *const _ as *const _,
                        std::mem::size_of_val(&limits) as u32,
                    ) != 0
                    && AssignProcessToJobObject(job, process) != 0;
                if !process.is_null() {
                    CloseHandle(process);
                }
                if !ok {
                    CloseHandle(job);
                    return Err("Cannot isolate plugin process tree".into());
                }
                Ok(Self { job: job as isize })
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = child;
            Err("Native executable plugins unavailable".into())
        }
    }
}
impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.pid, libc::SIGKILL);
        }
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job as _);
        }
    }
}
async fn exchange(
    stdin: &mut tokio::process::ChildStdin,
    stdout: &mut BufReader<tokio::process::ChildStdout>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value> {
    let mut bytes =
        serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .unwrap();
    if bytes.len() > MAX_MESSAGE {
        return Err("Native request too large".into());
    }
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|_| "Native stdin closed")?;
    stdin.flush().await.map_err(|_| "Native stdin closed")?;
    let mut line = Vec::new();
    loop {
        let available = stdout.fill_buf().await.map_err(|_| "Native stdout error")?;
        if available.is_empty() {
            return Err("Native process exited".into());
        }
        let n = available
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(available.len());
        if line.len() + n > MAX_MESSAGE {
            return Err("Native response too large".into());
        }
        line.extend_from_slice(&available[..n]);
        stdout.consume(n);
        if line.last() == Some(&b'\n') {
            break;
        }
    }
    let v: Value = serde_json::from_slice(&line).map_err(|_| "Invalid native JSON-RPC response")?;
    if v["jsonrpc"] != "2.0"
        || v["id"] != id
        || v.get("method").is_some()
        || (v.get("result").is_some() == v.get("error").is_some())
    {
        return Err("Unexpected native JSON-RPC response".into());
    }
    if v.get("error").is_some() {
        return Err("Native plugin returned an RPC error".into());
    }
    Ok(v["result"].clone())
}
struct Completion {
    done: watch::Sender<bool>,
    notify: Option<Box<dyn FnOnce() + Send>>,
}
impl Drop for Completion {
    fn drop(&mut self) {
        let _ = self.done.send(true);
        if let Some(notify) = self.notify.take() {
            notify();
        }
    }
}
async fn run_process(
    path: PathBuf,
    cwd: PathBuf,
    mut requests: mpsc::Receiver<Request>,
    mut stop: watch::Receiver<bool>,
    ready: Arc<std::sync::atomic::AtomicBool>,
    started: oneshot::Sender<Result<()>>,
    done: watch::Sender<bool>,
    notify: Option<Box<dyn FnOnce() + Send>>,
    error: Arc<Mutex<Option<String>>>,
) {
    let completion = Completion { done, notify };
    let mut cmd = Command::new(path);
    cmd.current_dir(cwd)
        .env_clear()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        if let Some(root) = std::env::var_os("SystemRoot") {
            cmd.env("SystemRoot", root);
        }
        cmd.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => {
            *error.lock().unwrap() = Some("Cannot launch native executable".into());
            drop(completion);
            let _ = started.send(Err("Cannot launch native executable".into()));
            return;
        }
    };
    let tree = match ProcessTree::attach(&child) {
        Ok(t) => t,
        Err(e) => {
            let _ = child.kill().await;
            *error.lock().unwrap() = Some(e.clone());
            drop(completion);
            let _ = started.send(Err(e));
            return;
        }
    };
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let handshake = tokio::select! {biased; _=stop.changed()=>Err("Native start canceled".into()), r=tokio::time::timeout(DEADLINE,exchange(&mut stdin,&mut stdout,0,"initialize",json!({"protocolVersion":1})))=>r.unwrap_or_else(|_|Err("Native handshake timed out".into()))};
    let initialized = handshake.and_then(|v| {
        if v["protocolVersion"] == 1 {
            Ok(())
        } else {
            Err("Native protocol incompatible".into())
        }
    });
    if let Err(e) = &initialized {
        *error.lock().unwrap() = Some(e.clone());
    }
    let ok = initialized.is_ok();
    ready.store(ok, std::sync::atomic::Ordering::SeqCst);
    let mut failed_start = None;
    if ok {
        let _ = started.send(Ok(()));
    } else {
        failed_start = Some((started, initialized));
    }
    let mut failed_call = None;
    if ok {
        let mut id = 0u64;
        loop {
            // Read while idle too: any unsolicited output/notification is a protocol violation.
            tokio::select! {biased;
             _=stop.changed()=>break,
             _=child.wait()=>{*error.lock().unwrap()=Some("Native process exited unexpectedly".into());break},
             _=stdout.fill_buf()=>{*error.lock().unwrap()=Some("Native stdout closed or unsolicited output".into());break},
             request=requests.recv()=>{let Some(request)=request else{break};if request.reply.is_closed() || tokio::time::Instant::now()>=request.deadline {continue}id+=1;
              let result=tokio::select!{biased; _=stop.changed()=>Err("Native call canceled".into()),r=tokio::time::timeout_at(request.deadline,exchange(&mut stdin,&mut stdout,id,&request.method,request.params))=>r.unwrap_or_else(|_|Err("Native call timed out".into()))};
              if let Err(e)=&result{*error.lock().unwrap()=Some(e.clone());failed_call=Some((request.reply,result));break}let _=request.reply.send(result);
             }
            }
        }
    }
    ready.store(false, std::sync::atomic::Ordering::SeqCst);
    drop(tree);
    let _ = child.kill().await;
    let _ = child.wait().await;
    drop(completion);
    if let Some((reply, result)) = failed_start {
        let _ = reply.send(result);
    }
    if let Some((reply, result)) = failed_call {
        let _ = reply.send(result);
    }
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf> {
    #[cfg(feature = "native-smoke")]
    if std::env::var("DEVICEDOCK_SMOKE_MODE").as_deref() == Ok("native-plugins") {
        if let Some(path) = std::env::var_os("DEVICEDOCK_NATIVE_SMOKE_ROOT") {
            return Ok(PathBuf::from(path));
        }
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "App storage unavailable")?
        .join("native-plugins-v1"))
}
// Reject calls from auxiliary webviews. Plugin pages have no IPC permission and an opaque sandbox origin.
fn owner(webview: &Webview) -> Result<String> {
    let label = webview.label();
    if label == "main"
        || label
            .strip_prefix("main-")
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
    {
        Ok(label.into())
    } else {
        Err("Native plugin host window required".into())
    }
}
#[tauri::command]
pub async fn native_plugin_install(
    app: tauri::AppHandle,
    webview: Webview,
    state: State<'_, NativePluginState>,
    bundle_json: String,
    expected_hash: String,
) -> Result<Record> {
    owner(&webview)?;
    let _gate = crate::updater::begin_device_operation(&app)?;
    let root = root(&app)?;
    let _lock = state.storage.lock().unwrap();
    let manifest = install(&root, &bundle_json, &expected_hash)?;
    Ok(Record {
        trusted: trusted(&root)?.contains(&expected_hash),
        hash: expected_hash,
        manifest,
        running: false,
        error: None,
    })
}
#[tauri::command]
pub fn native_plugin_list(
    app: tauri::AppHandle,
    webview: Webview,
    state: State<'_, NativePluginState>,
) -> Result<Vec<Record>> {
    let owner = owner(&webview)?;
    let root = root(&app)?;
    let _lock = state.storage.lock().unwrap();
    if !root.exists() {
        return Ok(vec![]);
    }
    checked(&root)?;
    let trust = trusted(&root)?;
    let inner = state.inner.lock().unwrap();
    let mut list = vec![];
    for entry in io(fs::read_dir(&root))? {
        let entry = io(entry)?;
        let hash = entry.file_name().to_string_lossy().into_owned();
        if !valid_hash(&hash) {
            continue;
        }
        let (manifest, _) = load(&root, &hash)?;
        let running = inner
            .processes
            .get(&(owner.clone(), hash.clone()))
            .is_some_and(|p| p.ready.load(std::sync::atomic::Ordering::SeqCst));
        list.push(Record {
            trusted: trust.contains(&hash),
            error: inner
                .processes
                .get(&(owner.clone(), hash.clone()))
                .and_then(|p| p.error.lock().unwrap().clone()),
            hash,
            manifest,
            running,
        });
    }
    list.sort_by(|a, b| a.hash.cmp(&b.hash));
    Ok(list)
}
#[tauri::command]
pub fn native_plugin_trust(
    app: tauri::AppHandle,
    webview: Webview,
    state: State<'_, NativePluginState>,
    hash: String,
) -> Result<()> {
    owner(&webview)?;
    let _lock = state.storage.lock().unwrap();
    if state.inner.lock().unwrap().blocked.contains(&hash) {
        return Err("Native package mutation in progress".into());
    }
    set_trust(&root(&app)?, &hash, true)?;
    let _ = app.emit("native-plugin-state", ());
    Ok(())
}
async fn remove_authority(
    app: &tauri::AppHandle,
    state: &NativePluginState,
    hash: &str,
    uninstall: bool,
) -> Result<()> {
    let root = root(app)?;
    let (processes, saved) = {
        let _storage = state.storage.lock().unwrap();
        if !state.inner.lock().unwrap().blocked.insert(hash.into()) {
            return Err("Native package mutation in progress".into());
        }
        let processes = state.stop_hash(hash);
        (processes, set_trust(&root, hash, false))
    };
    for process in processes {
        process.finished().await;
    }
    let _storage = state.storage.lock().unwrap();
    let result = if saved.is_err() {
        saved
    } else if uninstall {
        checked(&root.join(hash)).and_then(|p| io(fs::remove_dir_all(p)))
    } else {
        Ok(())
    };
    state.inner.lock().unwrap().blocked.remove(hash);
    let _ = app.emit("native-plugin-state", ());
    result
}
#[tauri::command]
pub async fn native_plugin_revoke(
    app: tauri::AppHandle,
    webview: Webview,
    state: State<'_, NativePluginState>,
    hash: String,
) -> Result<()> {
    owner(&webview)?;
    remove_authority(&app, &state, &hash, false).await
}
#[tauri::command]
pub async fn native_plugin_start(
    app: tauri::AppHandle,
    webview: Webview,
    state: State<'_, NativePluginState>,
    hash: String,
) -> Result<()> {
    let owner = owner(&webview)?;
    let _update = crate::updater::begin_device_operation(&app)?;
    let root = root(&app)?;
    let started = {
        let _storage = state.storage.lock().unwrap();
        let (m, _) = load(&root, &hash)?;
        if !trusted(&root)?.contains(&hash) {
            return Err("Trust this exact native package before starting".into());
        }
        let notify_app = app.clone();
        state.launch(
            &owner,
            &hash,
            root.join(&hash).join(m.executable),
            root.join(&hash),
            Some(Box::new(move || {
                let _ = notify_app.emit("native-plugin-state", ());
            })),
        )?
    };
    started.await.map_err(|_| "Native startup canceled")?
}
#[tauri::command]
pub async fn native_plugin_call(
    app: tauri::AppHandle,
    webview: Webview,
    state: State<'_, NativePluginState>,
    hash: String,
    method: String,
    params: Value,
) -> Result<Value> {
    let owner = owner(&webview)?;
    let _update = crate::updater::begin_device_operation(&app)?;
    if serde_json::to_vec(&params)
        .map_err(|_| "Invalid native parameters")?
        .len()
        > MAX_MESSAGE - 256
    {
        return Err("Native request too large".into());
    }
    let deadline = tokio::time::Instant::now() + DEADLINE;
    let (received, process) = {
        let _storage = state.storage.lock().unwrap();
        let root = root(&app)?;
        if !trusted(&root)?.contains(&hash) {
            return Err("Native trust revoked".into());
        }
        let (manifest, _) = load(&root, &hash)?;
        if !manifest.methods.contains(&method) {
            return Err("Native method not declared".into());
        }
        let inner = state.inner.lock().unwrap();
        let process = inner
            .processes
            .get(&(owner, hash))
            .ok_or("Native plugin stopped")?;
        if !process.ready.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Native plugin not ready".into());
        }
        let (reply, received) = oneshot::channel();
        process
            .tx
            .try_send(Request {
                method,
                params,
                reply,
                deadline,
            })
            .map_err(|_| "Native call queue full or process stopped")?;
        (received, process.clone())
    };
    // Queue wait is also bounded (not 8 * per-call timeout).
    await_call(process, received, deadline).await
}
async fn await_call(
    process: Arc<Running>,
    received: oneshot::Receiver<Result<Value>>,
    deadline: tokio::time::Instant,
) -> Result<Value> {
    match tokio::time::timeout_at(deadline, received).await {
        Ok(Ok(result)) => result,
        _ => {
            let _ = process.stop.send(true);
            process.finished().await;
            Err("Native call canceled/timed out; process terminated".into())
        }
    }
}
#[tauri::command]
pub async fn native_plugin_stop(
    webview: Webview,
    state: State<'_, NativePluginState>,
    hash: String,
) -> Result<()> {
    let owner = owner(&webview)?;
    let process = {
        state
            .inner
            .lock()
            .unwrap()
            .processes
            .get(&(owner, hash))
            .cloned()
    };
    if let Some(process) = process {
        let _ = process.stop.send(true);
        process.finished().await;
    }
    Ok(())
}
#[tauri::command]
pub async fn native_plugin_release_owned(
    webview: Webview,
    state: State<'_, NativePluginState>,
) -> Result<()> {
    finish_release(state.release(&owner(&webview)?)).await;
    Ok(())
}
#[tauri::command]
pub async fn native_plugin_uninstall(
    app: tauri::AppHandle,
    webview: Webview,
    state: State<'_, NativePluginState>,
    hash: String,
) -> Result<()> {
    owner(&webview)?;
    remove_authority(&app, &state, &hash, true).await
}
#[tauri::command]
pub fn native_plugin_page(
    app: tauri::AppHandle,
    webview: Webview,
    state: State<'_, NativePluginState>,
    hash: String,
) -> Result<String> {
    owner(&webview)?;
    let _storage = state.storage.lock().unwrap();
    let root = root(&app)?;
    if !trusted(&root)?.contains(&hash) {
        return Err("Native trust required".into());
    }
    load(&root, &hash)?;
    Ok(if cfg!(windows) {
        format!("http://devicedock-native.localhost/{hash}/page")
    } else {
        format!("devicedock-native://localhost/{hash}/page")
    })
}
pub fn response(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    let result = (|| {
        let hash = path
            .strip_prefix('/')
            .and_then(|s| s.strip_suffix("/page"))
            .ok_or("Invalid native page")?;
        let state = app.state::<NativePluginState>();
        let _storage = state.storage.lock().unwrap();
        let root = root(app)?;
        if !trusted(&root)?.contains(hash) {
            return Err("Native trust required".into());
        }
        let (m, files) = load(&root, hash)?;
        let bridge = include_str!("../../../src/shell/native-plugin-bridge.js");
        let mut html =
            format!("<!doctype html><meta charset=utf-8><script>{bridge}</script>").into_bytes();
        html.extend_from_slice(&files[&m.page]);
        Ok::<_, String>(html)
    })();
    match result {Ok(bytes)=>tauri::http::Response::builder().header("Content-Type","text/html; charset=utf-8").header("Content-Security-Policy","default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts").header("X-Content-Type-Options","nosniff").body(bytes).unwrap(),Err(_)=>tauri::http::Response::builder().status(404).body(b"Verified native page unavailable".to_vec()).unwrap()}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let mut bytes = [0u8; 16];
            getrandom::fill(&mut bytes).unwrap();
            let p = std::env::temp_dir().join(format!("dd-native-test-{}", digest(&bytes)));
            fs::create_dir(&p).unwrap();
            Self(fs::canonicalize(p).unwrap())
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn bundle() -> (String, String) {
        let mut files = BTreeMap::new();
        files.insert("bin/plugin", b"executable".to_vec());
        files.insert("ui.html", b"<h1>native</h1>".to_vec());
        let integrity: BTreeMap<_, _> = files
            .iter()
            .map(|(p, b)| (p.to_string(), format!("sha256-{}", digest(b))))
            .collect();
        let files: BTreeMap<_, _> = files
            .iter()
            .map(|(p, b)| (p.to_string(), STANDARD.encode(b)))
            .collect();
        let raw=json!({"manifest":{"schemaVersion":1,"kind":"native-process","id":"test.plugin","name":"test","version":"1","target":target(),"executable":"bin/plugin","page":"ui.html","methods":["echo"],"integrity":integrity},"files":files}).to_string();
        let hash = digest(raw.as_bytes());
        (raw, hash)
    }
    #[test]
    fn installation_trust_is_digest_bound_and_revalidates_bytes() {
        let temp = Temp::new();
        let (raw, hash) = bundle();
        install(&temp.0, &raw, &hash).unwrap();
        assert!(trusted(&temp.0).unwrap().is_empty());
        set_trust(&temp.0, &hash, true).unwrap();
        assert!(trusted(&temp.0).unwrap().contains(&hash));
        let changed = raw.replace("<h1>", "<h2>"); // Changing even raw JSON whitespace must change the identity.
        let changed = changed + " ";
        let other = digest(changed.as_bytes());
        install(&temp.0, &changed, &other).unwrap();
        assert!(!trusted(&temp.0).unwrap().contains(&other));
        let executable = temp.0.join(&hash).join("bin/plugin");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o600)).unwrap();
        }
        fs::write(executable, b"tampered").unwrap();
        assert!(load(&temp.0, &hash).is_err());
        assert!(set_trust(&temp.0, &hash, true).is_err());
        set_trust(&temp.0, &hash, false).unwrap();
        assert!(trusted(&temp.0).unwrap().is_empty());
    }
    #[test]
    fn rejects_path_platform_and_digest_attacks() {
        let (raw, hash) = bundle();
        assert!(parse(&(raw.clone() + " "), &hash).is_err());
        for path in [
            "../a",
            "a//b",
            "a/./b",
            "/bin/x",
            "a\\b",
            "a/%2e",
            "a:",
            "a/..",
            "CON",
            "bin/NUL.txt",
            "COM1",
            "bin/foo.",
        ][..]
            .iter()
        {
            assert!(!safe_path(path));
        }
        let mut value: Value = serde_json::from_str(&raw).unwrap();
        value["manifest"]["target"] = json!("other-platform");
        let raw = value.to_string();
        assert!(parse(&raw, &digest(raw.as_bytes())).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_in_package_and_store_ancestors() {
        use std::os::unix::fs::symlink;
        let temp = Temp::new();
        let (raw, hash) = bundle();
        let root = temp.0.join("store");
        install(&root, &raw, &hash).unwrap();
        let executable = root.join(&hash).join("bin/plugin");
        fs::remove_file(&executable).unwrap();
        let other = temp.0.join("other");
        fs::write(&other, b"executable").unwrap();
        symlink(&other, &executable).unwrap();
        assert!(load(&root, &hash).is_err());
        let alias = temp.0.join("alias");
        symlink(&root, &alias).unwrap();
        assert!(install(&alias, &raw, &hash).is_err());
    }
    fn fixture() -> PathBuf {
        static FIXTURE: OnceLock<PathBuf> = OnceLock::new();
        FIXTURE.get_or_init(||{
   let temp=Temp::new();let path=temp.0.join(if cfg!(windows){"fixture.exe"}else{"fixture"});let source=temp.0.join("fixture.rs");
   fs::write(&source,r###"
use std::{io::{self,BufRead,Write},time::Duration};
fn main(){if std::env::args().nth(1).as_deref()==Some("descendant"){std::fs::write("descendant.pid",std::process::id().to_string()).unwrap();let mut n=0u64;loop{n+=1;std::fs::write("heartbeat",n.to_string()).unwrap();std::thread::sleep(Duration::from_millis(10))}}
std::fs::write("pid",std::process::id().to_string()).unwrap();let stdin=io::stdin();let mut out=io::stdout();for line in stdin.lock().lines(){let line=line.unwrap();let id=line.split("\"id\":").nth(1).unwrap().chars().take_while(char::is_ascii_digit).collect::<String>();
if line.contains("\"crash\""){std::process::exit(7)}
if line.contains("\"initialize\"") && std::path::Path::new("stall-init").exists(){std::thread::sleep(Duration::from_secs(10));}
if line.contains("\"stderr\""){std::io::stderr().write_all(&vec![b'x';1000000]).unwrap();}
if line.contains("\"stall\""){std::thread::sleep(Duration::from_secs(10));std::fs::write("late",b"bad").unwrap();}
if line.contains("\"mark\""){std::fs::write("executed",b"bad").unwrap();}
if line.contains("\"spawn\""){std::process::Command::new(std::env::current_exe().unwrap()).arg("descendant").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).spawn().unwrap();}
if line.contains("\"flood\""){out.write_all(&vec![b'x';100000]).unwrap();out.flush().unwrap();continue}
let result=if line.contains("\"env\""){if std::env::vars_os().all(|(key,_)|cfg!(windows)&&key=="SystemRoot"){r#"{"envClear":true}"#}else{r#"{"envClear":false}"#}}else if line.contains("\"initialize\""){r#"{"protocolVersion":1}"#}else{r#"{"ok":true}"#};writeln!(out,"{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{}}}",id,result).unwrap();out.flush().unwrap();
}}
"###).unwrap();
   let output=std::process::Command::new("rustc").arg("--edition=2021").arg(&source).arg("-o").arg(&path).output().unwrap();assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));std::mem::forget(temp);path
  }).clone()
    }
    async fn launched(
        state: &NativePluginState,
        temp: &Temp,
        owner: &str,
        hash: &str,
    ) -> Arc<Running> {
        state
            .launch(owner, hash, fixture(), temp.0.clone(), None)
            .unwrap()
            .await
            .unwrap()
            .unwrap();
        state.inner.lock().unwrap().processes[&(owner.into(), hash.into())].clone()
    }
    async fn call(p: Arc<Running>, method: &str, timeout: Duration) -> Result<Value> {
        let (reply, received) = oneshot::channel();
        let deadline = tokio::time::Instant::now() + timeout;
        p.tx.try_send(Request {
            method: method.into(),
            params: Value::Null,
            reply,
            deadline,
        })
        .unwrap_or_else(|_| panic!("queue unavailable"));
        await_call(p, received, deadline).await
    }
    #[tokio::test]
    async fn spawn_failure_completes_and_can_retry() {
        let state = NativePluginState::default();
        let temp = Temp::new();
        let failed = state
            .launch("main", "hash", temp.0.join("missing"), temp.0.clone(), None)
            .unwrap();
        assert!(failed.await.unwrap().is_err());
        let prior = state.inner.lock().unwrap().processes[&("main".into(), "hash".into())].clone();
        assert!(*prior.done.borrow());
        let p = launched(&state, &temp, "main", "hash").await;
        assert_eq!(call(p.clone(), "echo", DEADLINE).await.unwrap()["ok"], true);
        let _ = p.stop.send(true);
        p.finished().await;
    }
    #[tokio::test]
    async fn handshake_timeout_reaps_and_allows_immediate_retry() {
        let state = NativePluginState::default();
        let temp = Temp::new();
        fs::write(temp.0.join("stall-init"), b"1").unwrap();
        let started = state
            .launch("main", "hash", fixture(), temp.0.clone(), None)
            .unwrap();
        assert!(started
            .await
            .unwrap()
            .unwrap_err()
            .contains("handshake timed out"));
        assert!(
            *state.inner.lock().unwrap().processes[&("main".into(), "hash".into())]
                .done
                .borrow()
        );
        fs::remove_file(temp.0.join("stall-init")).unwrap();
        let p = launched(&state, &temp, "main", "hash").await;
        assert!(call(p, "echo", DEADLINE).await.is_ok());
        state.release_all().await;
    }
    #[tokio::test]
    async fn stop_drains_before_restart_and_owner_release_isolated() {
        let state = NativePluginState::default();
        let first = Temp::new();
        let second = Temp::new();
        let p = launched(&state, &first, "main", "hash").await;
        let q = launched(&state, &second, "main-2", "hash").await;
        let release = state.release("main");
        assert!(state
            .launch("main", "hash", fixture(), first.0.clone(), None)
            .is_err());
        finish_release(release).await;
        assert!(*p.done.borrow());
        assert!(call(q, "echo", DEADLINE).await.is_ok());
        let p = launched(&state, &first, "main", "hash").await;
        assert!(call(p, "echo", DEADLINE).await.is_ok());
        state.release_all().await;
        assert!(state
            .inner
            .lock()
            .unwrap()
            .processes
            .values()
            .all(|p| *p.done.borrow()));
    }
    #[tokio::test]
    async fn timeout_kills_process_and_skips_expired_queued_side_effects() {
        let state = NativePluginState::default();
        let temp = Temp::new();
        let p = launched(&state, &temp, "main", "hash").await;
        let first = tokio::spawn(call(p.clone(), "stall", Duration::from_millis(150)));
        tokio::time::sleep(Duration::from_millis(20)).await;
        let queued = call(p.clone(), "mark", Duration::from_millis(30)).await;
        assert!(queued.is_err());
        assert!(first.await.unwrap().is_err());
        assert!(*p.done.borrow());
        assert!(!temp.0.join("executed").exists());
        assert!(!temp.0.join("late").exists());
    }
    #[tokio::test]
    async fn expired_request_never_executes_and_crash_flood_are_reaped() {
        let state = NativePluginState::default();
        let temp = Temp::new();
        let p = launched(&state, &temp, "main", "hash").await;
        let (reply, received) = oneshot::channel();
        p.tx.try_send(Request {
            method: "mark".into(),
            params: Value::Null,
            reply,
            deadline: tokio::time::Instant::now() - Duration::from_secs(1),
        })
        .unwrap_or_else(|_| panic!("queue"));
        assert!(received.await.is_err());
        assert!(!temp.0.join("executed").exists());
        let _ = p.stop.send(true);
        p.finished().await;
        for method in ["crash", "flood"] {
            let p = launched(&state, &temp, "main", "hash").await;
            assert!(call(p.clone(), method, DEADLINE).await.is_err());
            p.finished().await;
            assert!(*p.done.borrow());
        }
    }
    #[tokio::test]
    async fn shutdown_fences_new_processes_and_stderr_is_not_buffered() {
        let state = NativePluginState::default();
        let temp = Temp::new();
        let p = launched(&state, &temp, "main", "hash").await;
        assert!(call(p.clone(), "stderr", DEADLINE).await.is_ok());
        assert_eq!(call(p, "env", DEADLINE).await.unwrap()["envClear"], true);
        state.begin_shutdown();
        assert!(state
            .launch("main-2", "hash", fixture(), temp.0.clone(), None)
            .is_err());
        state.release_all().await;
        assert!(state
            .inner
            .lock()
            .unwrap()
            .processes
            .values()
            .all(|p| *p.done.borrow()));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn release_terminates_descendant_process_group() {
        let state = NativePluginState::default();
        let temp = Temp::new();
        let p = launched(&state, &temp, "main", "hash").await;
        call(p, "spawn", DEADLINE).await.unwrap();
        let file = temp.0.join("descendant.pid");
        for _ in 0..100 {
            if file.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let _pid: i32 = fs::read_to_string(file).unwrap().parse().unwrap();
        let heartbeat = temp.0.join("heartbeat");
        for _ in 0..100 {
            if heartbeat.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let before = fs::read(&heartbeat).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_ne!(
            before,
            fs::read(&heartbeat).unwrap(),
            "descendant did not execute"
        );
        state.release_all().await;
        let stopped = fs::read(&heartbeat).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            stopped,
            fs::read(&heartbeat).unwrap(),
            "descendant survived owner cleanup"
        );
    }
}
