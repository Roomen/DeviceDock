// 插件包根目录的 manifest.json：包身份、能力声明与逐文件 sha256。
// 这里只做纯数据校验(可在 cargo test 里跑)，不碰文件系统；文件校验在 store.rs，解压在 archive.rs。
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const API_VERSION: u32 = 1;
// 单包上限：文件数、单文件、总量。解压与校验两边都用同一组上限，先解压再校验不能放大占用。
pub const MAX_FILES: usize = 4000;
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

// 能力 id 就是宿主 API 的权限边界：manifest 只能声明这六个，页面侧 js/plugin-rpc.js 用同一张表
// 逐次校验调用。未声明的能力在安装时不可见，启用前必须由用户确认。
pub const CAPABILITIES: [&str; 6] = ["device.read", "serial.io", "serial.claim", "protocol.read", "log", "app"];
pub const KINDS: [&str; 2] = ["web", "native"];
pub const PLATFORMS: [&str; 3] = ["macos", "windows", "linux"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub kind: String,
    pub entry: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub platforms: Option<Vec<String>>,
    #[serde(default)]
    pub native: Option<serde_json::Value>,
    // 相对路径 -> "sha256-<64 hex>"，只出这里列出的文件
    pub integrity: BTreeMap<String, String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
}

impl Manifest {
    // 这一版插件在当前系统上能不能跑：platforms 省略表示全平台
    pub fn runs_on(&self, os: &str) -> bool {
        match &self.platforms {
            None => true,
            Some(list) => list.iter().any(|p| p == os),
        }
    }
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || (b'A'..=b'F').contains(&b))
}

// 包内相对路径：只认以 '/' 分隔的普通段。反斜杠、绝对路径、单点 / 双点段、盘符、保留设备名与
// Windows 不接受的结尾字符一律拒绝——同一份包要在两个系统上都能落盘。
pub fn safe_rel_path(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > 512 {
        return None;
    }
    if raw.contains('\\') || raw.starts_with('/') {
        return None;
    }
    if raw.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') {
        return None;
    }
    let mut out = Vec::new();
    for seg in raw.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.len() > 128 {
            return None;
        }
        if seg.contains(':') || seg.ends_with(' ') || seg.ends_with('.') {
            return None;
        }
        let lower = seg.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or("");
        if matches!(stem, "con" | "prn" | "aux" | "nul")
            || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && stem[3..].bytes().all(|b| b.is_ascii_digit()))
        {
            return None;
        }
        out.push(seg);
    }
    if out.is_empty() {
        return None;
    }
    Some(out.join("/"))
}

// 摘要字段统一成小写 hex(接受 sha256- 前缀)
pub fn normalize_digest(raw: &str) -> Option<String> {
    let body = raw.strip_prefix("sha256-").unwrap_or(raw);
    if !is_hex64(body) {
        return None;
    }
    Some(body.to_ascii_lowercase())
}

pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    if b.is_empty() || b.len() > 64 {
        return false;
    }
    if !b[0].is_ascii_lowercase() && !b[0].is_ascii_digit() {
        return false;
    }
    if !b[b.len() - 1].is_ascii_lowercase() && !b[b.len() - 1].is_ascii_digit() {
        return false;
    }
    b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'.')
}

// 语义化版本：主.次.修订，可带 -预发布 与 +构建；只用于比较与显示，不参与信任判定
pub fn valid_version(v: &str) -> bool {
    if v.is_empty() || v.len() > 64 {
        return false;
    }
    let core = v.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    parts.iter().all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()))
}

pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    if !valid_version(v) {
        return None;
    }
    let core = v.split(['-', '+']).next().unwrap_or("");
    let mut it = core.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next()?.parse().ok()?;
    let c = it.next()?.parse().ok()?;
    Some((a, b, c))
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

fn str_field(value: &str, max: usize) -> Option<String> {
    let t = value.trim();
    if t.is_empty() || t.chars().count() > max {
        return None;
    }
    if t.chars().any(|c| c == '\u{0}') {
        return None;
    }
    Some(t.to_string())
}

// 从字节解析并校验：任何一处不合规都整包拒绝(不猜测、不降级)
pub fn parse(bytes: &[u8]) -> Result<Manifest, String> {
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("manifest.json 过大".to_string());
    }
    let m: Manifest = serde_json::from_slice(bytes).map_err(|e| format!("manifest.json 不是合法的清单：{e}"))?;
    validate(m)
}

pub fn validate(m: Manifest) -> Result<Manifest, String> {
    if m.schema_version != SCHEMA_VERSION {
        return Err(format!("不支持的清单版本 {}（本版本只认 {}）", m.schema_version, SCHEMA_VERSION));
    }
    if m.api_version != API_VERSION {
        return Err(format!("不支持的插件 API 版本 {}（本版本只认 {}）", m.api_version, API_VERSION));
    }
    if !valid_id(&m.id) {
        return Err("插件 id 只能用小写字母、数字、'-' 与 '.'，且首尾必须是字母或数字".to_string());
    }
    if str_field(&m.name, 48).is_none() {
        return Err("插件名称不能为空，最多 48 个字符".to_string());
    }
    if !valid_version(&m.version) {
        return Err("插件版本必须是 主.次.修订（如 1.0.0）".to_string());
    }
    if !KINDS.contains(&m.kind.as_str()) {
        return Err("kind 只能是 web 或 native".to_string());
    }
    if let Some(list) = &m.platforms {
        for p in list {
            if !PLATFORMS.contains(&p.as_str()) {
                return Err(format!("platforms 里的 {p} 不是支持的平台"));
            }
        }
        if list.is_empty() {
            return Err("platforms 为空时请直接省略这个字段".to_string());
        }
    }
    if m.native.is_some() && m.kind != "native" {
        return Err("native 字段只对 kind=native 有意义".to_string());
    }
    let mut caps: Vec<String> = Vec::new();
    for c in &m.capabilities {
        if !CAPABILITIES.contains(&c.as_str()) {
            return Err(format!("未定义的能力 {c}"));
        }
        if caps.iter().any(|x| x == c) {
            return Err(format!("能力 {c} 重复声明"));
        }
        caps.push(c.clone());
    }
    if m.integrity.is_empty() {
        return Err("integrity 不能为空：每个要加载的文件都要有 sha256".to_string());
    }
    if m.integrity.len() > MAX_FILES {
        return Err(format!("包内文件超过 {MAX_FILES} 个"));
    }
    let mut integrity = BTreeMap::new();
    for (path, digest) in &m.integrity {
        let safe = safe_rel_path(path).ok_or_else(|| format!("integrity 里的路径不合法：{path}"))?;
        let d = normalize_digest(digest).ok_or_else(|| format!("{path} 的 sha256 格式不对（应为 sha256- 加 64 位十六进制）"))?;
        integrity.insert(safe, d);
    }
    let entry = safe_rel_path(&m.entry).ok_or_else(|| "entry 必须是包内相对路径".to_string())?;
    if !integrity.contains_key(&entry) {
        return Err("entry 文件必须在 integrity 里声明".to_string());
    }
    if m.kind == "web" && !(entry.ends_with(".html") || entry.ends_with(".htm")) {
        return Err("web 插件的 entry 必须是 .html 文件".to_string());
    }
    let icon = match m.icon.as_deref() {
        None => None,
        Some(raw) if raw.trim().is_empty() => None,
        Some(raw) => {
            // 图标要么是 lucide 图标名(宿主内置图标集)，要么是包内 svg 文件
            if raw.contains('/') || raw.contains('.') {
                let p = safe_rel_path(raw).ok_or_else(|| "icon 不是合法的包内路径".to_string())?;
                if !p.ends_with(".svg") {
                    return Err("icon 只支持 lucide 图标名或包内 .svg 文件".to_string());
                }
                if !integrity.contains_key(&p) {
                    return Err("icon 文件必须在 integrity 里声明".to_string());
                }
                Some(p)
            } else {
                if !raw.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') || raw.len() > 64 {
                    return Err("icon 的 lucide 图标名不合法".to_string());
                }
                Some(raw.to_string())
            }
        }
    };
    Ok(Manifest {
        schema_version: m.schema_version,
        id: m.id,
        name: str_field(&m.name, 48).unwrap_or_else(|| "插件".to_string()),
        version: m.version,
        api_version: m.api_version,
        kind: m.kind,
        entry,
        icon,
        capabilities: caps,
        platforms: m.platforms,
        native: m.native,
        integrity,
        homepage: m.homepage.and_then(|h| str_field(&h, 512)),
        license: m.license.and_then(|h| str_field(&h, 64)),
    })
}

// 版本之间能力变化(启用前必须重新确认的依据)
pub fn capability_diff(old: &[String], new: &[String]) -> (Vec<String>, Vec<String>) {
    let added = new.iter().filter(|c| !old.iter().any(|o| o == *c)).cloned().collect();
    let removed = old.iter().filter(|c| !new.iter().any(|n| n == *c)).cloned().collect();
    (added, removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1,
            "id": "hello",
            "name": "Hello",
            "version": "1.0.0",
            "apiVersion": 1,
            "kind": "web",
            "entry": "index.html",
            "capabilities": ["device.read", "app"],
            "integrity": { "index.html": format!("sha256-{}", "a".repeat(64)) }
        })
    }

    fn parse_value(v: serde_json::Value) -> Result<Manifest, String> {
        parse(serde_json::to_vec(&v).unwrap().as_slice())
    }

    #[test]
    fn accepts_minimal_manifest() {
        let m = parse_value(base()).unwrap();
        assert_eq!(m.id, "hello");
        assert_eq!(m.entry, "index.html");
        assert!(m.capabilities.iter().any(|c| c == "app"));
        assert!(m.runs_on("macos"));
        assert_eq!(m.integrity["index.html"], "a".repeat(64));
    }

    #[test]
    fn rejects_wrong_versions() {
        let mut v = base();
        v["schemaVersion"] = serde_json::json!(2);
        assert!(parse_value(v).is_err());
        let mut v = base();
        v["apiVersion"] = serde_json::json!(2);
        assert!(parse_value(v).is_err());
        let mut v = base();
        v["version"] = serde_json::json!("1.0");
        assert!(parse_value(v).is_err());
    }

    #[test]
    fn rejects_unknown_capability_and_duplicates() {
        let mut v = base();
        v["capabilities"] = serde_json::json!(["device.read", "filesystem"]);
        assert!(parse_value(v).unwrap_err().contains("未定义的能力"));
        let mut v = base();
        v["capabilities"] = serde_json::json!(["app", "app"]);
        assert!(parse_value(v).unwrap_err().contains("重复"));
    }

    #[test]
    fn entry_must_be_declared_in_integrity() {
        let mut v = base();
        v["entry"] = serde_json::json!("main.html");
        assert!(parse_value(v).unwrap_err().contains("entry"));
    }

    #[test]
    fn rejects_traversal_in_integrity() {
        for bad in ["../evil.js", "/etc/passwd", "a/../../b.js", "a\\b.js", "C:/x.js", "a//b.js", "con.js", "a/ "] {
            let mut v = base();
            v["integrity"] = serde_json::json!({ bad: format!("sha256-{}", "b".repeat(64)) });
            assert!(parse_value(v).is_err(), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn rejects_bad_digest() {
        let mut v = base();
        v["integrity"] = serde_json::json!({ "index.html": "sha256-xyz" });
        assert!(parse_value(v).is_err());
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let mut v = base();
        v["extra"] = serde_json::json!(1);
        assert!(parse_value(v).is_err());
    }

    #[test]
    fn icon_forms() {
        let mut v = base();
        v["icon"] = serde_json::json!("activity");
        assert_eq!(parse_value(v).unwrap().icon.as_deref(), Some("activity"));
        let mut v = base();
        v["icon"] = serde_json::json!("img/logo.svg");
        assert!(parse_value(v).unwrap_err().contains("icon"));
        let mut with_file = base();
        with_file["integrity"] = serde_json::json!({
            "index.html": format!("sha256-{}", "a".repeat(64)),
            "img/logo.svg": format!("sha256-{}", "c".repeat(64))
        });
        with_file["icon"] = serde_json::json!("img/logo.svg");
        assert_eq!(parse_value(with_file).unwrap().icon.as_deref(), Some("img/logo.svg"));
    }

    #[test]
    fn safe_paths() {
        assert_eq!(safe_rel_path("a/b.js").as_deref(), Some("a/b.js"));
        assert!(safe_rel_path("").is_none());
        assert!(safe_rel_path("../a").is_none());
        assert!(safe_rel_path("./a").is_none());
        assert!(safe_rel_path("/a").is_none());
        assert!(safe_rel_path("a\u{0}b").is_none());
        assert!(safe_rel_path("a:b").is_none());
        assert!(safe_rel_path("lpt1.txt").is_none());
        assert!(safe_rel_path("file.").is_none());
    }

    #[test]
    fn version_ordering() {
        assert!(is_newer("1.2.3", "1.2.2"));
        assert!(is_newer("2.0.0", "1.9.9"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("bad", "1.0.0"));
        assert!(valid_version("1.0.0-beta.1"));
        assert_eq!(parse_version("1.0.0-beta.1"), Some((1, 0, 0)));
    }

    #[test]
    fn capability_diff_lists_both_directions() {
        let (added, removed) = capability_diff(&["app".to_string()], &["app".to_string(), "serial.io".to_string()]);
        assert_eq!(added, vec!["serial.io".to_string()]);
        assert!(removed.is_empty());
    }
}
