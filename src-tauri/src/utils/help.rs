use crate::config::with_encryption;
use anyhow::{Context as _, Result, anyhow, bail};
use nanoid::nanoid;
use serde::{Serialize, de::DeserializeOwned};
use serde_yaml_ng::Mapping;
use std::{
    path::{Path, PathBuf},
    str::FromStr,
};
use tokio::io::AsyncWriteExt as _;
use tokio::sync::Mutex;
use url::Url;
use xxlink_logging::{Type, logging};

static ATOMIC_WRITE_LOCK: Mutex<()> = Mutex::const_new(());

fn atomic_sidecar_path(path: &Path, suffix: &str) -> Result<PathBuf> {
    let name = path
        .file_name()
        .ok_or_else(|| anyhow!("atomic write target has no file name"))?
        .to_string_lossy();
    Ok(path.with_file_name(format!(".{name}.xxlink-{suffix}")))
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows::{
        Win32::Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW},
        core::PCWSTR,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .with_context(|| format!("failed to replace file \"{}\"", destination.display()))
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> Result<()> {
    std::fs::rename(source, destination)
        .with_context(|| format!("failed to replace file \"{}\"", destination.display()))
}

#[cfg(not(target_os = "windows"))]
fn sync_parent(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("atomic write target has no parent directory"))?
        .to_owned();
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn sync_parent(path: &Path) -> Result<()> {
    let _ = path
        .parent()
        .ok_or_else(|| anyhow!("atomic write target has no parent directory"))?;
    Ok(())
}

async fn recover_atomic_write_unlocked(path: &Path) -> Result<()> {
    let pending = atomic_sidecar_path(path, "pending")?;
    let ready = atomic_sidecar_path(path, "ready")?;
    if tokio::fs::try_exists(&pending).await.unwrap_or(false) {
        tokio::fs::remove_file(&pending)
            .await
            .with_context(|| format!("failed to discard incomplete file \"{}\"", pending.display()))?;
    }
    if tokio::fs::try_exists(&ready).await.unwrap_or(false) {
        let ready_for_replace = ready.clone();
        let destination = path.to_owned();
        tokio::task::spawn_blocking(move || replace_file(&ready_for_replace, &destination))
            .await
            .context("failed to join atomic recovery")??;
        sync_parent(path)?;
    }
    Ok(())
}

pub async fn recover_atomic_write(path: &Path) -> Result<()> {
    let _guard = ATOMIC_WRITE_LOCK.lock().await;
    recover_atomic_write_unlocked(path).await
}

pub async fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let _guard = ATOMIC_WRITE_LOCK.lock().await;
    recover_atomic_write_unlocked(path).await?;
    let pending = atomic_sidecar_path(path, "pending")?;
    let ready = atomic_sidecar_path(path, "ready")?;
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&pending)
        .await
        .with_context(|| format!("failed to create staged file \"{}\"", pending.display()))?;
    if let Err(error) = async {
        file.write_all(data).await?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&pending, &ready).await?;
        sync_parent(path)?;
        let ready_for_replace = ready.clone();
        let destination = path.to_owned();
        tokio::task::spawn_blocking(move || replace_file(&ready_for_replace, &destination))
            .await
            .context("failed to join atomic replace")??;
        sync_parent(path)?;
        Ok::<(), anyhow::Error>(())
    }
    .await
    {
        let _ = tokio::fs::remove_file(&pending).await;
        let _ = tokio::fs::remove_file(&ready).await;
        return Err(error).with_context(|| format!("failed to atomically save file \"{}\"", path.display()));
    }
    Ok(())
}

/// read data from yaml as struct T
pub async fn read_yaml<T: DeserializeOwned>(path: &PathBuf) -> Result<T> {
    recover_atomic_write(path).await?;
    if !tokio::fs::try_exists(path).await.unwrap_or(false) {
        bail!("file not found \"{}\"", path.display());
    }

    let yaml_str = tokio::fs::read_to_string(path).await?;

    Ok(with_encryption(|| async { serde_yaml_ng::from_str::<T>(&yaml_str) }).await?)
}

/// read mapping from yaml
pub async fn read_mapping(path: &PathBuf) -> Result<Mapping> {
    recover_atomic_write(path).await?;
    if !tokio::fs::try_exists(path).await.unwrap_or(false) {
        bail!("file not found \"{}\"", path.display());
    }

    let yaml_str = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("failed to read the file \"{}\"", path.display()))?;

    // YAML语法检查
    match serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&yaml_str) {
        Ok(mut val) => {
            val.apply_merge()
                .with_context(|| format!("failed to apply merge \"{}\"", path.display()))?;

            Ok(val
                .as_mapping()
                .ok_or_else(|| anyhow!("failed to transform to yaml mapping \"{}\"", path.display()))?
                .to_owned())
        }
        Err(err) => {
            let error_msg = format!("YAML syntax error in {}: {}", path.display(), err);
            logging!(error, Type::Config, "{}", error_msg);

            crate::core::handle::Handle::notice_message("config_validate::yaml_syntax_error", &error_msg);

            bail!("YAML syntax error: {}", err)
        }
    }
}

/// save the data to the file
/// can set `prefix` string to add some comments
pub async fn save_yaml<T: Serialize + Sync>(path: &Path, data: &T, prefix: Option<&str>) -> Result<()> {
    let data_str = with_encryption(|| async { serde_yaml_ng::to_string(data) }).await?;

    let yaml_str = match prefix {
        Some(prefix) => format!("{prefix}\n\n{data_str}"),
        None => data_str,
    };

    let path_str = path.as_os_str().to_string_lossy().to_string();
    atomic_write(path, yaml_str.as_bytes())
        .await
        .with_context(|| format!("failed to save file \"{path_str}\""))?;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    Ok(())
}

const ALPHABET: [char; 62] = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J',
    'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
];

/// generate the uid
pub fn get_uid(prefix: &str) -> String {
    let id = nanoid!(11, &ALPHABET);
    format!("{prefix}{id}")
}

/// parse the string
/// xxx=123123; => 123123
pub fn parse_str<T: FromStr>(target: &str, key: &str) -> Option<T> {
    target.split(';').map(str::trim).find_map(|s| {
        let mut parts = s.splitn(2, '=');
        match (parts.next(), parts.next()) {
            (Some(k), Some(v)) if k == key => v.parse::<T>().ok(),
            _ => None,
        }
    })
}

/// Mask sensitive parts of a subscription URL for safe logging.
/// Examples:
/// - `https://example.com/api/v1/clash?token=abc123` → `https://example.com/api/v1/clash?token=***`
/// - `https://example.com/abc123def456ghi789/clash` → `https://example.com/***/clash`
pub fn mask_url(url: &str) -> String {
    // Split off query string
    let (path_part, query_part) = match url.find('?') {
        Some(pos) => (&url[..pos], Some(&url[pos + 1..])),
        None => (url, None),
    };

    // Rebuild scheme://host[:port] from the parsed URL rather than slicing the
    // original text. The slice used to run from "://" to the first '/', which
    // is exactly the span that holds `user:password@` -- so any credentials in
    // an imported subscription URL were copied verbatim into the log line this
    // function exists to make safe. `host_str()` cannot carry userinfo, so the
    // leak is closed by construction rather than by another pattern to match.
    //
    // A URL that does not parse is summarised by length only: returning any of
    // its text risks returning the part we are trying to withhold.
    let (scheme_and_host, path) = match Url::parse(path_part) {
        Ok(parsed) if parsed.host_str().is_some() => {
            let mut prefix = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or_default());
            if let Some(port) = parsed.port() {
                prefix.push_str(&format!(":{port}"));
            }
            // Offset the path out of the ORIGINAL text: parsed.path()
            // normalises (adds a trailing "/" for an empty path), which would
            // otherwise alter output for URLs that have no path at all.
            let host_end = path_part
                .find("://")
                .and_then(|scheme_end| {
                    path_part[scheme_end + 3..]
                        .find('/')
                        .map(|slash| scheme_end + 3 + slash)
                })
                .unwrap_or(path_part.len());
            (prefix, &path_part[host_end..])
        }
        _ => return format!("<unparseable-url len={}>", url.len()),
    };

    let mut result = scheme_and_host;

    // Mask path segments that look like tokens (longer than 8 chars)
    if !path.is_empty() {
        let masked: Vec<&str> = path
            .split('/')
            .map(|seg| if seg.len() > 8 { "***" } else { seg })
            .collect();
        result.push_str(&masked.join("/"));
    }

    // Keep query param keys, mask values
    if let Some(query) = query_part {
        result.push('?');
        let masked_query: Vec<String> = query
            .split('&')
            .map(|param| match param.find('=') {
                Some(eq) => format!("{}=***", &param[..eq]),
                None => param.to_owned(),
            })
            .collect();
        result.push_str(&masked_query.join("&"));
    }

    result
}

/// Index of the next `scheme://` in `text`, scanning back over the scheme
/// characters that precede a `://` so the returned span starts at the scheme
/// rather than in the middle of it.
fn find_scheme_start(text: &str) -> Option<usize> {
    let mut from = 0usize;
    while let Some(rel) = text[from..].find("://") {
        let sep = from + rel;
        let head = &text[..sep];
        let scheme_start = head
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')))
            .map_or(0, |i| i + head[i..].chars().next().map_or(1, char::len_utf8));
        // A scheme must be non-empty and start with a letter.
        if scheme_start < sep
            && head[scheme_start..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
        {
            return Some(scheme_start);
        }
        from = sep + 3;
    }
    None
}

/// Mask all URLs embedded in an error/log string for safe logging.
///
/// Scans the string for `http://` or `https://` and replaces each URL
/// (terminated by whitespace or `)`, `]`, `"`, `'`) with its masked form.
/// Text between URLs is copied verbatim.
pub fn mask_err(err: &str) -> String {
    let mut result = String::with_capacity(err.len());
    let mut remaining = err;

    loop {
        // Any scheme, not just http(s). Proxy subscriptions carry ss://,
        // vmess://, trojan://pw@host and similar, and validator output is
        // exactly the text that quotes them back -- scanning for two schemes
        // let every other one through verbatim, credentials included.
        // RFC 3986: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
        let start = match find_scheme_start(remaining) {
            None => {
                result.push_str(remaining);
                break;
            }
            Some(a) => a,
        };

        result.push_str(&remaining[..start]);
        remaining = &remaining[start..];

        let url_end = remaining
            .find(|c: char| c.is_whitespace() || matches!(c, ')' | ']' | '"' | '\''))
            .unwrap_or(remaining.len());

        result.push_str(&mask_url(&remaining[..url_end]));
        remaining = &remaining[url_end..];
    }

    result
}

/// get the last part of the url, if not found, return empty string
pub fn get_last_part_and_decode(url: &str) -> Option<String> {
    let path = url.split('?').next().unwrap_or(""); // Splits URL and takes the path part
    let segments: Vec<&str> = path.split('/').collect();
    let last_segment = segments.last()?;

    Some(
        percent_encoding::percent_decode_str(last_segment)
            .decode_utf8_lossy()
            .to_string(),
    )
}

/// open file
pub fn open_file(path: PathBuf) -> Result<()> {
    open::that_detached(path.as_os_str())?;
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn linux_elevator() -> String {
    use std::process::Command;
    match Command::new("which").arg("pkexec").output() {
        Ok(output) => {
            if !output.stdout.is_empty() {
                // Convert the output to a string slice
                if let Ok(path) = std::str::from_utf8(&output.stdout) {
                    path.trim().to_string()
                } else {
                    "sudo".to_string()
                }
            } else {
                "sudo".to_string()
            }
        }
        Err(_) => "sudo".to_string(),
    }
}

#[cfg(target_os = "windows")]
/// copy the file to the dist path and return the dist path
pub fn snapshot_path(original_path: &Path) -> Result<PathBuf> {
    let temp_dir = original_path
        .parent()
        .ok_or_else(|| anyhow!("Invalid log path"))?
        .join("temp");

    std::fs::create_dir_all(&temp_dir)?;

    let temp_path = temp_dir.join(format!(
        "{}_{}.log",
        original_path.file_stem().unwrap_or_default().to_string_lossy(),
        chrono::Local::now().format("%Y-%m-%d_%H-%M-%S")
    ));

    std::fs::copy(original_path, &temp_path)?;

    Ok(temp_path)
}

#[cfg(test)]
mod atomic_write_tests {
    use super::*;

    #[tokio::test]
    async fn atomic_write_commits_and_recovers_only_ready_data() -> Result<()> {
        let directory = std::env::temp_dir().join(format!("xxlink-atomic-write-{}", get_uid("t")));
        tokio::fs::create_dir_all(&directory).await?;
        let target = directory.join("profiles.yaml");

        atomic_write(&target, b"first").await?;
        assert_eq!(tokio::fs::read(&target).await?, b"first");

        let pending = atomic_sidecar_path(&target, "pending")?;
        let ready = atomic_sidecar_path(&target, "ready")?;
        tokio::fs::write(&pending, b"incomplete").await?;
        tokio::fs::write(&ready, b"second").await?;
        recover_atomic_write(&target).await?;
        assert_eq!(tokio::fs::read(&target).await?, b"second");
        assert!(!tokio::fs::try_exists(&pending).await?);
        assert!(!tokio::fs::try_exists(&ready).await?);

        tokio::fs::remove_dir_all(directory).await?;
        Ok(())
    }
}

// The module name is load-bearing: CI runs
// `cargo test --workspace --all-features --lib runtime_boundary_tests`, so a
// test outside a module with this name never executes. The pre-existing
// `atomic_write_tests` module in this same file is an example of that -- it
// has never run in CI.
#[cfg(test)]
mod runtime_boundary_tests {
    use super::*;

    #[test]
    fn mask_url_never_emits_userinfo() {
        // The defect: the old implementation sliced from "://" to the first
        // '/', which is precisely the span holding `user:password@`, and
        // copied it verbatim into a log line at info level.
        for raw in [
            "https://user:s3cr3t@sub.example.com/abcdefghijkl?token=xyz",
            "https://user:s3cr3t@sub.example.com",
            "http://only-user@example.com/path",
            "https://user:p%40ss:word@example.com/x",
        ] {
            let masked = mask_url(raw);
            for secret in ["s3cr3t", "p%40ss", "only-user", "user:"] {
                assert!(
                    !masked.contains(secret),
                    "mask_url leaked {secret:?} from {raw:?}: {masked}"
                );
            }
            assert!(!masked.contains('@'), "userinfo separator survived: {masked}");
        }
    }

    #[test]
    fn mask_url_keeps_what_makes_a_log_line_useful() {
        let masked = mask_url("https://user:pw@sub.example.com:8443/abcdefghijkl?token=xyz");
        assert!(masked.starts_with("https://sub.example.com:8443"), "{masked}");
        assert!(masked.contains("***"), "long path segment must be masked: {masked}");
        assert!(masked.contains("token=***"), "query value must be masked: {masked}");
        assert!(!masked.contains("xyz"), "query value leaked: {masked}");

        // No credentials, no path, no query: output stays recognisable.
        assert_eq!(mask_url("https://example.com"), "https://example.com");
    }

    #[test]
    fn mask_url_withholds_everything_it_cannot_parse() {
        // Returning any span of an unparseable URL risks returning the part
        // being withheld, so the fallback carries length only.
        let masked = mask_url("not a url with s3cr3t in it");
        assert!(masked.starts_with("<unparseable-url len="), "{masked}");
        assert!(!masked.contains("s3cr3t"), "{masked}");
    }

    #[test]
    fn mask_err_covers_every_scheme_not_just_http() {
        // Proxy subscription errors quote ss://, vmess://, trojan:// URLs back.
        // Scanning only for http(s) let all of those through verbatim.
        for raw in [
            "parse error at trojan://s3cr3tpw@host.example:443#tag",
            "bad node ss://s3cr3tpw@1.2.3.4:8388",
            "vmess://s3cr3tpw@host.example/path",
        ] {
            let masked = mask_err(raw);
            assert!(!masked.contains("s3cr3tpw"), "leaked from {raw:?}: {masked}");
            assert!(!masked.contains('@'), "userinfo separator survived: {masked}");
        }
        // Text around the URL is preserved, and a bare word with a colon is
        // not mistaken for a scheme.
        let m = mask_err("note: see trojan://pw@h.example now");
        assert!(m.starts_with("note: see "), "{m}");
        assert!(m.ends_with(" now"), "{m}");
    }

    #[test]
    fn mask_err_inherits_the_fix() {
        // mask_err delegates to mask_url, so the leak and its fix propagate
        // together. validate.rs does not call mask_err yet -- that is #3; this
        // asserts the delegation, not a routing that has not landed.
        let masked = mask_err("failed on https://user:s3cr3t@host.example/cfg (retrying)");
        assert!(!masked.contains("s3cr3t"), "{masked}");
        assert!(masked.contains("retrying"), "surrounding text must survive: {masked}");
    }
}
