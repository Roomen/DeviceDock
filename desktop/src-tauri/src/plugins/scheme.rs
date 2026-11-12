// ddplugin:// 自定义协议：只出「已安装 + 已启用 + integrity 里列出 + 摘要仍对得上」的插件文件。
// 插件页面在 sandbox iframe（allow-scripts，不给 allow-same-origin）里加载，因此与本页面不同源；
// 这里的 CSP 只放行包内脚本 / 样式 / 图片，禁掉一切网络与表单出口，插件只能经 postMessage 与宿主通信。
use std::borrow::Cow;
use std::path::Path;

use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};

use super::manifest::{self, safe_rel_path};
use super::store::{self, sha256_hex};

// 单次响应上限：包内单文件上限以内，超过不读
const MAX_SERVE_BYTES: u64 = manifest::MAX_FILE_BYTES;

pub struct Target {
    pub id: String,
    pub version: String,
    pub rel: String,
}

// 请求路径 -> (插件 id, 版本, 包内相对路径)。所有段都过一遍白名单，不信任任何解码后的形式。
pub fn resolve_request_path(raw: &str) -> Option<Target> {
    let decoded = percent_decode_str(raw).decode_utf8().ok()?.to_string();
    let decoded = decoded.split(['?', '#']).next().unwrap_or("");
    let mut segs: Vec<&str> = decoded.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() < 3 {
        return None;
    }
    let id = segs.remove(0).to_string();
    let version = segs.remove(0).to_string();
    let rel = segs.join("/");
    if !manifest::valid_id(&id) || !manifest::valid_version(&version) {
        return None;
    }
    let rel = safe_rel_path(&rel)?;
    Some(Target { id, version, rel })
}

fn content_type(rel: &str) -> &'static str {
    let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// 插件文档的 CSP：脚本 / 样式 / 图片只能来自这个协议，网络与表单全部关掉。
// iframe 是 opaque origin，用 'self' 匹配不到任何东西，所以按请求的实际源写成 scheme / 源。
pub fn csp_for(request: &Request<Vec<u8>>) -> String {
    let uri = request.uri();
    let source = match uri.scheme_str() {
        Some("http") | Some("https") => match uri.authority() {
            Some(a) => format!("{}://{}", uri.scheme_str().unwrap_or("http"), a),
            None => "'none'".to_string(),
        },
        Some(s) => format!("{s}:"),
        None => "'none'".to_string(),
    };
    format!(
        "default-src 'none'; script-src {source} 'unsafe-inline'; style-src {source} 'unsafe-inline'; img-src {source} data:; font-src {source} data:; media-src {source}; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors *"
    )
}

fn text_response(status: StatusCode, message: &str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(Cow::Owned(message.as_bytes().to_vec()))
        .unwrap_or_else(|_| Response::new(Cow::Owned(Vec::new())))
}

pub fn serve(root: &Path, state: &store::State, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let Some(target) = resolve_request_path(request.uri().path()) else {
        return text_response(StatusCode::NOT_FOUND, "not found");
    };
    let Some(entry) = state.plugins.get(&target.id) else {
        return text_response(StatusCode::NOT_FOUND, "not found");
    };
    // 只出当前启用版本：停用 / 升级途中旧版本立刻不可加载
    if !entry.enabled || entry.version != target.version {
        return text_response(StatusCode::NOT_FOUND, "not found");
    }
    let dir = store::version_dir(root, &target.id, &target.version);
    let Ok(m) = store::read_manifest(&dir) else {
        return text_response(StatusCode::NOT_FOUND, "not found");
    };
    let Some(expected) = m.integrity.get(&target.rel) else {
        return text_response(StatusCode::NOT_FOUND, "not found");
    };
    let path = dir.join(&target.rel);
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return text_response(StatusCode::NOT_FOUND, "not found");
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_SERVE_BYTES {
        return text_response(StatusCode::NOT_FOUND, "not found");
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return text_response(StatusCode::NOT_FOUND, "not found");
    };
    if &sha256_hex(&bytes) != expected {
        return text_response(StatusCode::NOT_FOUND, "not found");
    }
    let csp = csp_for(request);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type(&target.rel))
        .header(header::CONTENT_SECURITY_POLICY, csp)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .body(Cow::Owned(bytes))
        .unwrap_or_else(|_| text_response(StatusCode::INTERNAL_SERVER_ERROR, "error"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_plugin_paths() {
        let t = resolve_request_path("/hello/1.0.0/index.html").unwrap();
        assert_eq!(t.id, "hello");
        assert_eq!(t.version, "1.0.0");
        assert_eq!(t.rel, "index.html");
        let t = resolve_request_path("/hello/1.0.0/js/app.js").unwrap();
        assert_eq!(t.rel, "js/app.js");
        // 百分号编码的段按解码后的形式判断
        assert_eq!(resolve_request_path("/hello/1.0.0/a%20b.js").unwrap().rel, "a b.js");
    }

    #[test]
    fn rejects_bad_paths() {
        for bad in [
            "/",
            "/hello",
            "/hello/1.0.0",
            "/hello/1.0.0/",
            "/Hello/1.0.0/index.html",
            "/hello/v1/index.html",
            "/hello/1.0.0/../x.js",
            "/hello/1.0.0/%2e%2e/x.js",
            "/hello/1.0.0/a%5cb.js",
            "/../hello/1.0.0/index.html",
        ] {
            assert!(resolve_request_path(bad).is_none(), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn content_types_cover_plugin_assets() {
        assert!(content_type("index.html").starts_with("text/html"));
        assert!(content_type("js/app.js").starts_with("text/javascript"));
        assert_eq!(content_type("logo.svg"), "image/svg+xml");
        assert_eq!(content_type("bin/x.wasm"), "application/wasm");
        assert_eq!(content_type("noext"), "application/octet-stream");
    }

    #[test]
    fn csp_allows_only_the_scheme() {
        let req = Request::builder().uri("ddplugin://localhost/hello/1.0.0/index.html").body(Vec::new()).unwrap();
        let csp = csp_for(&req);
        assert!(csp.contains("script-src ddplugin: 'unsafe-inline'"), "{csp}");
        assert!(csp.contains("connect-src 'none'"), "{csp}");
        let req = Request::builder().uri("http://ddplugin.localhost/hello/1.0.0/index.html").body(Vec::new()).unwrap();
        assert!(csp_for(&req).contains("script-src http://ddplugin.localhost"), "{}", csp_for(&req));
    }
}
