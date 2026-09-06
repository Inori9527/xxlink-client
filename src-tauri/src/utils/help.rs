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

/// Name the failure class of a fetch error without quoting the error.
///
/// This is what replaced `mask_err`. Redacting whatever an error chose to say
/// meant guessing, from text, which parts were secret; four review rounds each
/// found a shape the guess did not cover. The class comes from the error's own
/// type instead, so there is nothing to guess and nothing to quote.
///
/// `prfitem.rs` preserves the source through `anyhow::Context`, which is what
/// makes the downcast possible; a `bail!("... {e}")` would have flattened it to
/// a string and lost both the type and the containment.
pub(crate) fn fetch_error_class(err: &anyhow::Error) -> std::string::String {
    // YAML first, because it is the one failure whose position the user can act
    // on, and M17 asked for line and column by name. `PrfItem::from_url` parses
    // the fetched body itself and lets the error out with `?`, so the typed
    // error is still here to downcast. A location is two integers -- it carries
    // no part of the profile, so nothing needs masking.
    if let Some(yaml) = err.downcast_ref::<serde_yaml_ng::Error>() {
        return match yaml.location() {
            Some(at) => format!("invalid-yaml line {} column {}", at.line(), at.column()),
            None => "invalid-yaml".into(),
        };
    }
    // A status reqwest did not turn into an error of its own -- a 304, a 1xx, a
    // 3xx the redirect policy did not follow -- arrives as the StatusCode
    // itself, because `reqwest::Error` has no public constructor and there is
    // nothing else to carry the fact with.
    if err.downcast_ref::<reqwest::StatusCode>().is_some() {
        return "status".into();
    }
    let Some(err) = err.downcast_ref::<reqwest::Error>() else {
        return "unknown".into();
    };
    if err.is_timeout() {
        "timeout"
    } else if err.is_connect() {
        "connect"
    } else if err.is_status() {
        "status"
    } else if err.is_decode() {
        "decode"
    } else if err.is_body() {
        "body"
    } else if err.is_request() {
        "request"
    } else if err.is_redirect() {
        "redirect"
    } else if err.is_builder() {
        "builder"
    } else {
        "unknown"
    }
    .into()
}

/// Reduce a URL to what a log line actually uses: its scheme and host.
///
/// Everything past that is one fixed marker. Four review rounds tried to decide,
/// inside the path and query text, which parts were secret -- by segment length,
/// by the presence of "=", by which scheme it was -- and every predicate was
/// defeated by a shape nobody had enumerated: an eight-byte token followed by
/// punctuation, a credential used as a query key, an apostrophe inside userinfo,
/// a scheme with no "//" at all. The set of shapes is not enumerable, so this no
/// longer tries to enumerate it. XXLink's subscription path is constant, and the
/// host is what says which server failed, which is all the log line was using.
pub fn mask_url(url: &str) -> String {
    let Ok(parsed) = Url::parse(url) else {
        // Returning any span of an unparseable URL risks returning the part
        // being withheld, so the fallback carries length only.
        return format!("<unparseable-url len={}>", url.len());
    };

    let scheme = parsed.scheme();

    // A scheme without a hierarchical authority puts its payload where the host
    // would be: a vmess:// link is a base64 blob there, and ss: has no "//" at
    // all. Nothing in such a URL can be kept.
    let host = match parsed.host_str() {
        Some(host) if matches!(scheme, "http" | "https" | "ws" | "wss") => host,
        _ => return format!("{scheme}:***"),
    };

    let mut result = format!("{scheme}://{host}");
    if let Some(port) = parsed.port() {
        result.push_str(&format!(":{port}"));
    }
    // The parser normalises an absent path to "/", so that is "no path".
    if !matches!(parsed.path(), "" | "/") {
        result.push_str("/***");
    }
    if parsed.query().is_some() {
        result.push_str("?***");
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

    // A one-shot listener on an ephemeral port. Every failure below is produced
    // against 127.0.0.1: no external network, nothing that can flake on someone
    // else's DNS. `hang` accepts and never answers, which is the timeout case.
    //
    // No `unwrap`/`expect` anywhere: the workspace denies both, and a test that
    // needs an exemption to exist is a test arguing with the rule rather than
    // following it.
    fn serve(response: &'static [u8], hang: bool) -> Result<std::string::String> {
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let addr = listener.local_addr()?;
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut discard = [0u8; 1024];
                let _ = stream.read(&mut discard);
                if hang {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    return;
                }
                let _ = stream.write_all(response);
                let _ = stream.flush();
            }
        });
        Ok(format!("http://{addr}/"))
    }

    // The two frames production puts between reqwest and the downcast:
    // utils/network.rs, then config/prfitem.rs.
    fn wrapped(err: reqwest::Error) -> anyhow::Error {
        let inner: Result<()> = Err(err).context("request failed");
        match inner.context("failed to fetch remote profile") {
            Ok(()) => anyhow!("unreachable: an Err was wrapped"),
            Err(err) => err,
        }
    }

    async fn class_of(request: reqwest::RequestBuilder) -> std::string::String {
        match request.send().await {
            Ok(_) => "no-error".into(),
            Err(err) => fetch_error_class(&wrapped(err)).into(),
        }
    }

    // The class is the only thing five call sites say about a failed update, so
    // a test that only checked the match arms would have missed what actually
    // shipped: the arms were right and the error never reached them, because a
    // frame two levels down had flattened it with `anyhow!("... {e}")`.
    #[tokio::test]
    async fn every_fetch_failure_kind_reports_a_class_rather_than_unknown() -> Result<()> {
        use std::time::Duration;

        let connect = class_of(reqwest::Client::new().get("http://127.0.0.1:1/")).await;
        assert_eq!(connect, "connect");

        let url = serve(b"", true)?;
        let slow = reqwest::Client::builder().timeout(Duration::from_millis(150)).build()?;
        assert_eq!(class_of(slow.get(&url)).await, "timeout");

        let url = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort", false)?;
        let decode = match reqwest::Client::new().get(&url).send().await {
            Err(err) => fetch_error_class(&wrapped(err)).to_string(),
            Ok(response) => match response.text().await {
                Ok(_) => "no-error".to_string(),
                Err(err) => fetch_error_class(&wrapped(err)).to_string(),
            },
        };
        assert_eq!(decode, "decode");

        // The control, and the reason the rest of this test is not enough on its
        // own: formatting the error into a new message -- what network.rs did
        // until this batch -- makes every one of them report "unknown". Without
        // this line the assertions above pass on a build where the class is real
        // and on one where the classifier is never reached.
        let flattened = match reqwest::Client::new().get("http://127.0.0.1:1/").send().await {
            Ok(_) => anyhow!("port 1 answered"),
            Err(err) => anyhow!("Request failed: {}", err),
        };
        assert_eq!(fetch_error_class(&flattened), "unknown");
        Ok(())
    }

    // The production-path acceptance test M25 asked for is still NOT here, but
    // the cause is no longer unknown -- it was found by command this round.
    //
    // A test that calls `NetworkManager::get_with_interrupt` makes tauri's window
    // code reachable from the test binary's roots, so the linker keeps its
    // comctl32 imports: `SetWindowSubclass`, `RemoveWindowSubclass`,
    // `DefSubclassProc`, `TaskDialogIndirect`. Those four live only in comctl32
    // **v6**, which the loader reaches through an application manifest.
    // `C:\Windows\System32\comctl32.dll` is v5 and exports none of them
    // (verified with objdump against the real file), and a `cargo test` binary
    // has no manifest -- so the process fails to LOAD, 0xc0000139
    // STATUS_ENTRYPOINT_NOT_FOUND, before any test runs, taking the other 35 with
    // it. The shipped app is unaffected: tauri gives it that manifest.
    //
    // The fix is a build-system change (embedding the Common-Controls v6
    // dependency into test binaries) and is proposed rather than taken here:
    // `rustc-link-arg-tests` needs a `[[test]]` target this package does not
    // have, and the unqualified `rustc-link-arg` would also alter the shipped
    // binary's link line. Until it is decided, the network.rs half of the status
    // fix is covered by reading; the classification half is covered by
    // `a_status_reqwest_did_not_error_on_is_still_classified` below.

    // M17 asked these sites to log "YAML line and column". This asserts they
    // can: the classifier is given the error `PrfItem::from_url` produces --
    // `serde_yaml_ng::from_str::<Mapping>` behind the same `.context` -- and
    // must name the position. What it does NOT prove is that from_url still
    // lets that error out with `?`; a `bail!` added there would flatten it and
    // this test would stay green while every site said "unknown" again.
    #[test]
    fn a_malformed_profile_reports_where_it_is_malformed() {
        // Valid on line 1, broken on line 2: a mapping value that opens a flow
        // sequence and never closes it.
        let broken = "proxies: []
mixed-port: [7890
";
        let parsed: Result<Mapping> =
            serde_yaml_ng::from_str::<Mapping>(broken).context("the remote profile data is invalid yaml");
        let err = match parsed {
            Ok(_) => anyhow!("the fixture parsed; it is no longer malformed"),
            Err(err) => err,
        };
        let class = fetch_error_class(&err);
        assert!(class.starts_with("invalid-yaml line "), "class was {class:?}");
        assert!(class.contains(" column "), "class was {class:?}");

        // The position must be the real one, not a constant: line 1 parses.
        assert!(!class.starts_with("invalid-yaml line 1 "), "class was {class:?}");

        // No part of the profile may travel with the position.
        assert!(!class.contains("7890"), "class carried profile content: {class:?}");
        assert!(
            !class.contains("mixed-port"),
            "class carried profile content: {class:?}"
        );

        // The control: flattened, it is "unknown" again -- which is what all
        // five sites printed for a malformed profile before this arm existed.
        let flattened = anyhow!("invalid yaml: {}", "some detail");
        assert_eq!(fetch_error_class(&flattened), "unknown");
    }

    // Covers the classification half of the 304 fix, and ONLY that half: it
    // asserts what `fetch_error_class` does with the value `network.rs` hands
    // it, not that `network.rs` hands it that value -- the test that would
    // prove the second thing cannot load, for the reason recorded above.
    // Deleting the StatusCode arm in `fetch_error_class` turns this red.
    #[test]
    fn a_status_reqwest_did_not_error_on_is_still_classified() {
        // reqwest turns 4xx and 5xx into errors of its own. A 304, a 1xx, or a
        // 3xx the redirect policy did not follow it simply returns, so the
        // status itself is the only thing there is to carry.
        let carried: Result<()> = Err(anyhow!(reqwest::StatusCode::NOT_MODIFIED));
        let err = match carried.context("remote profile responded with an error status") {
            Ok(()) => anyhow!("unreachable: an Err was wrapped"),
            Err(err) => err,
        };
        assert_eq!(fetch_error_class(&err), "status");

        // The message a user or a log line sees must stay the fixed context,
        // never the reason phrase, which the server chooses.
        assert_eq!(err.to_string(), "remote profile responded with an error status");

        // The control: the same status formatted into a message -- what the
        // caller's `bail!` still does for anything that gets past network.rs --
        // carries nothing to downcast and must report "unknown". Without this
        // line the assertion above passes on a build where the arm works and on
        // one where every error is classified "status".
        let flattened = anyhow!("status {}", reqwest::StatusCode::NOT_MODIFIED);
        assert_eq!(fetch_error_class(&flattened), "unknown");
    }

    // One test for one rule, because there is now one rule. The predicates these
    // replace -- a length threshold on path segments, a key/value split in the
    // query, a scheme allowlist applied after the host was already taken -- each
    // had its own test, and each test passed while the predicate leaked, because
    // a test can only carry the shapes its author thought of.
    #[test]
    fn mask_url_emits_only_scheme_and_host() {
        for (raw, expected) in [
            (
                "https://user:s3cr3t@sub.example.com/abcdefghijkl?token=xyz",
                "https://sub.example.com/***?***",
            ),
            ("https://user:s3cr3t@sub.example.com", "https://sub.example.com"),
            ("https://sub.example.com:8443/a", "https://sub.example.com:8443/***"),
            ("http://only-user@example.com/path", "http://example.com/***"),
            ("https://h.example/?q=1", "https://h.example?***"),
            ("https://h.example/", "https://h.example"),
            // Short, punctuated and key-shaped payloads were the four leaks of
            // the second ultra round. None of them survives a rule that keeps
            // no path text at all.
            ("https://h.example/abcdefg.", "https://h.example/***"),
            ("https://a.inv/x,https://u:p@b/y", "https://a.inv/***"),
            ("https://h.inv/?https://u:pw@evil.inv/x=1", "https://h.inv?***"),
            ("https://u:pw'tail@h.inv/subscription/abcdefghijkl", "https://h.inv/***"),
            ("https:////u:p@h/x", "https://h/***"),
        ] {
            assert_eq!(mask_url(raw), expected, "input {raw:?}");
        }
    }

    // Anything whose authority is not an authority keeps nothing. The payload of
    // a vmess:// link sits in host position, and ss: has no "//" for a host to
    // be parsed out of at all.
    #[test]
    fn mask_url_withholds_all_of_a_non_hierarchical_scheme() {
        for (raw, expected) in [
            ("vmess://czNjcjN0", "vmess:***"),
            ("ss://YWVzOnMzY3IzdA@1.2.3.4:8388#tag", "ss:***"),
            ("ss:YWVzOnMzY3IzdA@1.2.3.4:8388", "ss:***"),
            ("trojan://s3cr3tpw@host.example:443?sni=x#tag", "trojan:***"),
            ("mailto:user:s3cr3t@h.invalid", "mailto:***"),
            ("urn:xxlink:CANARYTOKEN", "urn:***"),
            ("file:///c:/secret", "file:***"),
        ] {
            assert_eq!(mask_url(raw), expected, "input {raw:?}");
        }
    }

    #[test]
    fn mask_url_never_emits_userinfo() {
        for raw in [
            "https://user:s3cr3t@sub.example.com/abcdefghijkl?token=xyz",
            "https://user:s3cr3t@sub.example.com",
            "http://only-user@example.com/path",
            "https://user:p%40ss:word@example.com/x",
            "https://u:pw@[::1]:8080/abcdefghij",
        ] {
            let masked = mask_url(raw);
            for secret in ["s3cr3t", "p%40ss", "only-user", "user:", "pw"] {
                assert!(
                    !masked.contains(secret),
                    "mask_url leaked {secret:?} from {raw:?}: {masked}"
                );
            }
            assert!(!masked.contains('@'), "userinfo separator survived: {masked}");
        }
    }

    #[test]
    fn mask_url_withholds_everything_it_cannot_parse() {
        // Returning any span of an unparseable URL risks returning the part
        // being withheld, so the fallback carries length only.
        let masked = mask_url("not a url with s3cr3t in it");
        assert!(masked.starts_with("<unparseable-url len="), "{masked}");
        assert!(!masked.contains("s3cr3t"), "{masked}");
    }
}
