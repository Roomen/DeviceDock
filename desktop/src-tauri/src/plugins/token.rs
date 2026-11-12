// GitHub 令牌存系统钥匙串(macOS 登录钥匙串 / Windows 凭据管理器)：不进应用数据目录、不进 localStorage，
// 页面只能问「是否已设置」，永远拿不回明文。
const SERVICE: &str = "DeviceDock";
const ACCOUNT: &str = "github-token";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("系统钥匙串不可用：{e}"))
}

pub fn get() -> Option<String> {
    match entry() {
        Ok(e) => match e.get_password() {
            Ok(v) if !v.trim().is_empty() => Some(v),
            _ => None,
        },
        Err(_) => None,
    }
}

pub fn is_set() -> bool {
    get().is_some()
}

pub fn set(token: &str) -> Result<(), String> {
    let value = token.trim();
    if value.is_empty() {
        return Err("令牌不能为空".to_string());
    }
    if value.len() > 512 || value.chars().any(|c| c.is_whitespace()) {
        return Err("令牌格式不对".to_string());
    }
    entry()?.set_password(value).map_err(|e| format!("无法写入系统钥匙串：{e}"))
}

pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        // 本来就没有：当作已清除
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("无法删除系统钥匙串条目：{e}")),
    }
}
