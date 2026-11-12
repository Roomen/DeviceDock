// 插件包解压：只落普通文件与目录，严格防路径穿越、符号链接与超大文件。
// 上限与 manifest.rs 共用同一组常量；解压到调用方给的临时目录，失败由调用方整目录删除。
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use super::manifest::{safe_rel_path, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES};

#[derive(Debug)]
pub struct Extracted {
    pub files: Vec<String>,
    #[allow(dead_code)] // 诊断用(解压后总量)；上限在解压过程中已经拦过
    pub total: u64,
}

fn target(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let safe = safe_rel_path(rel).ok_or_else(|| format!("包内路径不合法：{rel}"))?;
    let path = root.join(&safe);
    // 双保险：拼出来的绝对路径必须仍在 root 之内
    if !path.starts_with(root) {
        return Err(format!("包内路径越界：{rel}"));
    }
    Ok(path)
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("无法创建目录：{e}"))?;
    }
    Ok(())
}

struct Budget {
    files: Vec<String>,
    total: u64,
}

impl Budget {
    fn new() -> Self {
        Budget { files: Vec::new(), total: 0 }
    }
    fn take(&mut self, rel: &str, size: u64) -> Result<(), String> {
        if size > MAX_FILE_BYTES {
            return Err(format!("包内文件过大：{rel}"));
        }
        if self.files.len() >= MAX_FILES {
            return Err(format!("包内文件超过 {MAX_FILES} 个"));
        }
        self.total = self.total.saturating_add(size);
        if self.total > MAX_TOTAL_BYTES {
            return Err("包解压后超过 64 MiB".to_string());
        }
        self.files.push(rel.to_string());
        Ok(())
    }
}

// 复制一个条目：按块读，超过单文件上限立即中止，不把整包读进内存
fn copy_limited<R: Read>(reader: &mut R, dest: &Path) -> Result<u64, String> {
    let mut out = std::fs::File::create(dest).map_err(|e| format!("无法写入包内文件：{e}"))?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut written: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("解压失败：{e}"))?;
        if n == 0 {
            break;
        }
        written += n as u64;
        if written > MAX_FILE_BYTES {
            return Err("包内单个文件超过 8 MiB".to_string());
        }
        out.write_all(&buf[..n]).map_err(|e| format!("无法写入包内文件：{e}"))?;
    }
    out.flush().map_err(|e| format!("无法写入包内文件：{e}"))?;
    Ok(written)
}

pub fn extract_zip(bytes: &[u8], root: &Path) -> Result<Extracted, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor).map_err(|e| format!("不是有效的 zip 包：{e}"))?;
    if zip.len() > MAX_FILES {
        return Err(format!("包内文件超过 {MAX_FILES} 个"));
    }
    let mut budget = Budget::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("zip 条目损坏：{e}"))?;
        let name = entry.name().to_string();
        // 符号链接在 zip 里靠 unix mode 表达：一律拒绝，不跟随
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(format!("包内不允许符号链接：{name}"));
            }
        }
        let is_dir = entry.is_dir();
        let rel = name.trim_end_matches('/').to_string();
        if rel.is_empty() {
            continue;
        }
        let dest = target(root, &rel)?;
        if is_dir {
            std::fs::create_dir_all(&dest).map_err(|e| format!("无法创建目录：{e}"))?;
            continue;
        }
        if entry.size() > MAX_FILE_BYTES {
            return Err(format!("包内文件过大：{rel}"));
        }
        ensure_parent(&dest)?;
        let written = copy_limited(&mut entry, &dest)?;
        budget.take(&rel, written)?;
    }
    Ok(Extracted { files: budget.files, total: budget.total })
}

pub fn extract_tar_gz(bytes: &[u8], root: &Path) -> Result<Extracted, String> {
    let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
    let mut archive = tar::Archive::new(gz);
    let mut budget = Budget::new();
    let entries = archive.entries().map_err(|e| format!("不是有效的 tar.gz 包：{e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("tar 条目损坏：{e}"))?;
        let header = entry.header().clone();
        let path = entry.path().map_err(|e| format!("tar 条目路径无效：{e}"))?.to_string_lossy().to_string();
        let kind = header.entry_type();
        if kind.is_dir() {
            let rel = path.trim_end_matches('/').to_string();
            if rel.is_empty() {
                continue;
            }
            let dest = target(root, &rel)?;
            std::fs::create_dir_all(&dest).map_err(|e| format!("无法创建目录：{e}"))?;
            continue;
        }
        // 只接受普通文件：符号链接、硬链接、设备节点、FIFO 全部拒绝
        if !kind.is_file() {
            return Err(format!("包内只允许普通文件与目录：{path}"));
        }
        if header.size().unwrap_or(0) > MAX_FILE_BYTES {
            return Err(format!("包内文件过大：{path}"));
        }
        let dest = target(root, &path)?;
        ensure_parent(&dest)?;
        let written = copy_limited(&mut entry, &dest)?;
        budget.take(&path, written)?;
    }
    Ok(Extracted { files: budget.files, total: budget.total })
}

// 按魔数判断包类型，不依赖文件名后缀(资产名由发布方决定)
pub fn kind_of(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 4 && &bytes[..4] == b"PK\x03\x04" {
        return Some("zip");
    }
    if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        return Some("tar.gz");
    }
    None
}

pub fn extract_any(bytes: &[u8], root: &Path) -> Result<Extracted, String> {
    match kind_of(bytes) {
        Some("zip") => extract_zip(bytes, root),
        Some("tar.gz") => extract_tar_gz(bytes, root),
        _ => Err("发布资产既不是 zip 也不是 tar.gz".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ddplug-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut buf));
            for (name, data) in entries {
                w.start_file(*name, SimpleFileOptions::default()).unwrap();
                w.write_all(data).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    #[test]
    fn extracts_normal_zip() {
        let dir = tmpdir("zip-ok");
        let bytes = zip_with(&[("index.html", b"<h1>hi</h1>"), ("js/app.js", b"1")]);
        let out = extract_zip(&bytes, &dir).unwrap();
        assert_eq!(out.files.len(), 2);
        assert_eq!(std::fs::read(dir.join("js/app.js")).unwrap(), b"1");
        assert!(out.total > 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_traversal_entries() {
        let dir = tmpdir("zip-evil");
        let bytes = zip_with(&[("../escape.js", b"x")]);
        let err = extract_zip(&bytes, &dir).unwrap_err();
        assert!(err.contains("不合法") || err.contains("越界"), "{err}");
        assert!(!dir.parent().unwrap().join("escape.js").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_absolute_entries() {
        let dir = tmpdir("zip-abs");
        let bytes = zip_with(&[("/tmp/escape.js", b"x")]);
        assert!(extract_zip(&bytes, &dir).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn detects_kind_by_magic() {
        assert_eq!(kind_of(b"PK\x03\x04rest"), Some("zip"));
        assert_eq!(kind_of(&[0x1f, 0x8b, 0x08]), Some("tar.gz"));
        assert_eq!(kind_of(b"nope"), None);
    }

    fn tar_gz(entries: Vec<(tar::EntryType, &str, &[u8])>) -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        {
            let mut builder = tar::Builder::new(&mut gz);
            for (kind, name, data) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_entry_type(kind);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, name, data).unwrap();
            }
            builder.finish().unwrap();
        }
        gz.finish().unwrap()
    }

    #[test]
    fn extracts_tar_gz() {
        let dir = tmpdir("tar-ok");
        let bytes = tar_gz(vec![(tar::EntryType::Regular, "index.html", b"<p>x</p>")]);
        let out = extract_tar_gz(&bytes, &dir).unwrap();
        assert_eq!(out.files, vec!["index.html".to_string()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // 手工写名字字段：tar 的 append_data 会先拒绝 ..，这里要的正是「发布方塞进来的坏条目」
    fn raw_tar_gz(name: &str, data: &[u8], kind: tar::EntryType) -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        {
            let mut builder = tar::Builder::new(&mut gz);
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_entry_type(kind);
            header.set_mode(0o644);
            let src = name.as_bytes();
            {
                let bytes = header.as_mut_bytes();
                bytes[..src.len()].copy_from_slice(src);
                for b in bytes[src.len()..100].iter_mut() {
                    *b = 0;
                }
            }
            header.set_cksum();
            builder.append(&header, data).unwrap();
            builder.finish().unwrap();
        }
        gz.finish().unwrap()
    }

    #[test]
    fn rejects_symlink_and_traversal_in_tar() {
        let dir = tmpdir("tar-evil");
        let link = raw_tar_gz("link", b"", tar::EntryType::Symlink);
        assert!(extract_tar_gz(&link, &dir).unwrap_err().contains("普通文件"));
        let evil = raw_tar_gz("../escape.js", b"x", tar::EntryType::Regular);
        assert!(extract_tar_gz(&evil, &dir).is_err());
        assert!(!dir.parent().unwrap().join("escape.js").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn extract_any_rejects_unknown_payload() {
        let dir = tmpdir("any-bad");
        assert!(extract_any(b"plain text", &dir).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
