// GitHub 侧：仓库地址解析、release 与资产选择、带令牌的 API / 资产下载。
// 只认 github.com 的公开仓库地址；令牌可选，用于私有仓库与 API 限额。
use serde::Deserialize;
use reqwest::redirect::Policy;

pub const API_ROOT: &str = "https://api.github.com";
// 单包下载上限：与解压上限一致，下载阶段就拒绝，不把超大资产读进内存
pub const MAX_DOWNLOAD_BYTES: u64 = 72 * 1024 * 1024;
pub const USER_AGENT: &str = "DeviceDock-PluginHost";

#[derive(Debug, Clone, PartialEq)]
pub struct RepoRef {
    pub owner: String,
    pub repo: String,
    pub tag: Option<String>,
}

fn valid_part(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        && s != "."
        && s != ".."
}

fn valid_tag(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'/')
        && !s.starts_with('/')
        && !s.ends_with('/')
        && !s.contains("..")
}

// 接受 https://github.com/<owner>/<repo>（可带 .git、末尾斜杠、@tag），也接受省略协议的 github.com/...
pub fn parse_repo_url(raw: &str) -> Result<RepoRef, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("请填写插件仓库地址".to_string());
    }
    let mut rest = trimmed;
    for prefix in ["https://", "http://"] {
        if let Some(r) = rest.strip_prefix(prefix) {
            rest = r;
        }
    }
    let (host, path) = match rest.split_once('/') {
        Some((h, p)) => (h.to_ascii_lowercase(), p),
        None => return Err("仓库地址缺少仓库名".to_string()),
    };
    if host != "github.com" && host != "www.github.com" {
        return Err("只支持 GitHub 仓库地址（https://github.com/<owner>/<repo>）".to_string());
    }
    let path = path.split(['?', '#']).next().unwrap_or("");
    let mut segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() < 2 {
        return Err("仓库地址应形如 https://github.com/<owner>/<repo>".to_string());
    }
    if segments.len() > 2 {
        return Err("只支持仓库根地址，不要带 releases 或其它子路径".to_string());
    }
    let repo_raw = segments.pop().unwrap();
    let owner = segments.pop().unwrap().to_string();
    let (name, tag) = match repo_raw.split_once('@') {
        Some((name, t)) => {
            if !valid_tag(t) {
                return Err("标签（@后面）不合法".to_string());
            }
            (name, Some(t.to_string()))
        }
        None => (repo_raw, None),
    };
    let repo = name.strip_suffix(".git").unwrap_or(name).to_string();
    if !valid_part(&owner) || !valid_part(&repo) {
        return Err("仓库地址里的 owner / repo 不合法".to_string());
    }
    Ok(RepoRef { owner, repo, tag })
}

#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    // GitHub release 资产 id：下载走 API 的 /assets/<id>，不信任包元数据里的 browser_download_url
    #[serde(default)]
    pub id: u64,
    pub name: String,
    #[serde(default)]
    pub size: u64,
    // 保留字段仅用于诊断 / 测试：下载一律走 asset_api_url，不读这个值
    #[allow(dead_code)]
    #[serde(default)]
    pub browser_download_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    #[serde(default)]
    pub tag_name: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

fn plugin_rank(name: &str) -> Option<u8> {
    if name == "devicedock-plugin.zip" || name == "devicedock-plugin.tar.gz" {
        return Some(0);
    }
    if name.ends_with(".devicedock-plugin.zip") || name.ends_with(".devicedock-plugin.tar.gz") {
        return Some(1);
    }
    None
}

// 资产选择：先认固定名 devicedock-plugin.(zip|tar.gz)，再认 <任意>.devicedock-plugin.(zip|tar.gz)；
// 同一 release 必须有 <包名>.sha256，否则拒绝安装（不做「没有校验也装」的降级）。
pub fn pick_assets(assets: &[Asset]) -> Result<(Asset, Asset), String> {
    let mut candidates: Vec<(u8, &Asset)> = assets.iter().filter_map(|a| plugin_rank(&a.name).map(|r| (r, a))).collect();
    if candidates.is_empty() {
        return Err("这个 release 里没有 devicedock-plugin.zip / .tar.gz 资产".to_string());
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.name.cmp(&b.1.name)));
    let package = candidates[0].1;
    let sha_name = format!("{}.sha256", package.name);
    let sha = assets
        .iter()
        .find(|a| a.name == sha_name)
        .ok_or_else(|| format!("release 里缺少校验文件 {sha_name}"))?;
    Ok((package.clone(), sha.clone()))
}

// .sha256 资产内容：允许 sha256sum 的「哈希  文件名」格式，取前 64 位十六进制
pub fn parse_sha256_file(text: &str) -> Result<String, String> {
    let token = text
        .split_whitespace()
        .next()
        .ok_or_else(|| "校验文件为空".to_string())?
        .trim()
        .to_ascii_lowercase();
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("校验文件里的 sha256 不是 64 位十六进制".to_string());
    }
    Ok(token)
}

fn api_error(status: u16, token_set: bool) -> String {
    match status {
        401 => "GitHub 令牌无效或已过期，请在插件设置里重新填写".to_string(),
        403 | 429 => {
            if token_set {
                "GitHub 拒绝访问（可能超出 API 限额或没有该仓库权限）".to_string()
            } else {
                "GitHub 拒绝访问：可能是 API 限额用完，或仓库是私有的——填写 GitHub 令牌后重试".to_string()
            }
        }
        404 => "找不到仓库或发布版本（私有仓库需要填写令牌）".to_string(),
        _ => format!("GitHub 返回 {status}"),
    }
}

// 下载可能被 GitHub 重定向到对象存储；只跟到白名单域名，别把初始请求里的 Bearer 令牌带到别处。
// reqwest 对 bearer_auth 标记的敏感头在跨 host 重定向时会自动剥离，这里再限制重定向目标本身。
pub fn allowed_redirect_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    matches!(h.as_str(), "api.github.com" | "github.com" | "objects.githubusercontent.com" | "release-assets.githubusercontent.com" | "github-releases.githubusercontent.com")
        || h.ends_with(".githubusercontent.com")
}

pub fn redirect_target_allowed(url: &str) -> bool {
    match reqwest::Url::parse(url) {
        Ok(u) => u.scheme() == "https" && allowed_redirect_host(u.host_str().unwrap_or("")),
        Err(_) => false,
    }
}

pub fn redirect_policy() -> Policy {
    Policy::custom(|attempt| {
        if attempt.previous().len() > 5 {
            return attempt.error("插件下载重定向次数过多");
        }
        let url = attempt.url();
        if url.scheme() != "https" || !allowed_redirect_host(url.host_str().unwrap_or("")) {
            return attempt.error("插件下载被重定向到不受信任的地址");
        }
        attempt.follow()
    })
}

// 初始下载 URL 也校验一遍：只认 api.github.com 的资产接口
pub fn asset_api_url(owner: &str, repo: &str, id: u64) -> String {
    format!("{API_ROOT}/repos/{owner}/{repo}/releases/assets/{id}")
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(120))
        .redirect(redirect_policy())
        .build()
        .map_err(|e| format!("无法创建网络客户端：{e}"))
}

fn with_auth(req: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    let req = req.header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28");
    match token {
        Some(t) if !t.trim().is_empty() => req.bearer_auth(t.trim()),
        _ => req,
    }
}

pub async fn fetch_release(repo: &RepoRef, token: Option<&str>) -> Result<Release, String> {
    let url = match &repo.tag {
        Some(tag) => format!("{API_ROOT}/repos/{}/{}/releases/tags/{}", repo.owner, repo.repo, tag),
        None => format!("{API_ROOT}/repos/{}/{}/releases/latest", repo.owner, repo.repo),
    };
    let resp = with_auth(client()?.get(&url), token)
        .send()
        .await
        .map_err(|e| format!("无法访问 GitHub：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(api_error(status.as_u16(), token.map(|t| !t.trim().is_empty()).unwrap_or(false)));
    }
    resp.json::<Release>().await.map_err(|e| format!("GitHub 返回的发布信息无法解析：{e}"))
}

async fn download_with(url: &str, token: Option<&str>, accept: &str) -> Result<Vec<u8>, String> {
    // 私有仓库的资产下载也要令牌；GitHub 会重定向到带签名的对象存储，reqwest 跟随后不再带令牌
    let resp = with_auth(client()?.get(url).header("Accept", accept), token)
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(api_error(status.as_u16(), token.map(|t| !t.trim().is_empty()).unwrap_or(false)));
    }
    if resp.content_length().unwrap_or(0) > MAX_DOWNLOAD_BYTES {
        return Err("发布资产超过 64 MiB".to_string());
    }
    let mut out: Vec<u8> = Vec::new();
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载中断：{e}"))? {
        out.extend_from_slice(&chunk);
        if out.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err("发布资产超过 64 MiB".to_string());
        }
    }
    Ok(out)
}

pub async fn download_asset(asset: &Asset, token: Option<&str>, repo: &RepoRef) -> Result<Vec<u8>, String> {
    if asset.id == 0 {
        return Err("发布资产缺少 id，无法安全下载".to_string());
    }
    if asset.size > MAX_DOWNLOAD_BYTES {
        return Err("发布资产超过 64 MiB".to_string());
    }
    // 用仓库坐标 + 资产 id 自己拼 API 地址：release 元数据里的 browser_download_url 不被信任，
    // 即使发布方把它换成第三方地址也不会有令牌发过去。
    let url = asset_api_url(&repo.owner, &repo.repo, asset.id);
    if !redirect_target_allowed(&url) {
        return Err("资产下载地址不在 GitHub API 域名上".to_string());
    }
    download_with(&url, token, "application/octet-stream").await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> Asset {
        Asset { id: 42, name: name.to_string(), size: 10, browser_download_url: format!("https://x/{name}") }
    }

    #[test]
    fn parses_repo_urls() {
        let r = parse_repo_url("https://github.com/Roomen/devicedock-plugin-power").unwrap();
        assert_eq!(r.owner, "Roomen");
        assert_eq!(r.repo, "devicedock-plugin-power");
        assert_eq!(r.tag, None);
        assert_eq!(parse_repo_url("https://github.com/o/r.git").unwrap().repo, "r");
        assert_eq!(parse_repo_url("github.com/o/r/").unwrap().repo, "r");
        assert_eq!(parse_repo_url("https://github.com/o/r@v1.2.3").unwrap().tag.as_deref(), Some("v1.2.3"));
        assert_eq!(parse_repo_url("  https://github.com/o/r?tab=readme ").unwrap().repo, "r");
    }

    #[test]
    fn rejects_bad_repo_urls() {
        for bad in [
            "",
            "https://gitlab.com/o/r",
            "https://github.com/onlyowner",
            "https://github.com/o/r/releases",
            "https://github.com/o/r@../x",
            "https://github.com//r",
        ] {
            assert!(parse_repo_url(bad).is_err(), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn picks_preferred_asset_and_requires_sha() {
        let assets = vec![
            asset("notes.txt"),
            asset("power.devicedock-plugin.zip"),
            asset("devicedock-plugin.tar.gz"),
            asset("devicedock-plugin.tar.gz.sha256"),
        ];
        let (pkg, sha) = pick_assets(&assets).unwrap();
        assert_eq!(pkg.name, "devicedock-plugin.tar.gz");
        assert_eq!(sha.name, "devicedock-plugin.tar.gz.sha256");
    }

    #[test]
    fn falls_back_to_suffixed_asset() {
        let assets = vec![asset("power.devicedock-plugin.zip"), asset("power.devicedock-plugin.zip.sha256")];
        assert_eq!(pick_assets(&assets).unwrap().0.name, "power.devicedock-plugin.zip");
    }

    #[test]
    fn refuses_missing_checksum() {
        let assets = vec![asset("devicedock-plugin.zip")];
        assert!(pick_assets(&assets).unwrap_err().contains("校验文件"));
        assert!(pick_assets(&[]).unwrap_err().contains("没有"));
    }

    #[test]
    fn parses_sha256_files() {
        let hex = "a".repeat(64);
        assert_eq!(parse_sha256_file(&hex).unwrap(), hex);
        assert_eq!(parse_sha256_file(&format!("{hex}  devicedock-plugin.zip\n")).unwrap(), hex);
        assert!(parse_sha256_file("").is_err());
        assert!(parse_sha256_file("sha256-abc").is_err());
    }

    #[test]
    fn asset_urls_are_built_from_the_api_not_release_metadata() {
        let r = RepoRef { owner: "o".into(), repo: "r".into(), tag: None };
        assert_eq!(
            asset_api_url(&r.owner, &r.repo, 987),
            "https://api.github.com/repos/o/r/releases/assets/987"
        );
        // 被替换过的 browser_download_url 完全不参与下载
        let evil = Asset { id: 7, name: "devicedock-plugin.zip".into(), size: 1, browser_download_url: "https://evil.example/steal".into() };
        assert!(!redirect_target_allowed(&evil.browser_download_url));
        assert!(redirect_target_allowed(&asset_api_url(&r.owner, &r.repo, evil.id)));
    }

    #[test]
    fn redirects_are_limited_to_github_hosts() {
        assert!(redirect_target_allowed("https://objects.githubusercontent.com/x"));
        assert!(redirect_target_allowed("https://release-assets.githubusercontent.com/x"));
        assert!(redirect_target_allowed("https://cdn.githubusercontent.com/x"));
        for bad in [
            "https://evil.example/x",
            "http://api.github.com/x",
            "https://api.github.com.evil.example/x",
            "https://github.com@evil.example/x",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert!(!redirect_target_allowed(bad), "{bad} 不能跟随");
        }
        assert!(allowed_redirect_host("API.GITHUB.COM"));
        assert!(!allowed_redirect_host("api.github.com.evil.example"));
    }
}
