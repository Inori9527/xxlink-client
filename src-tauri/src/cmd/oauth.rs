use super::CmdResult;
use tauri::{AppHandle, Emitter as _};

#[derive(Clone, serde::Serialize)]
struct OAuthPayload {
    code: Option<String>,
    error: Option<String>,
    #[serde(rename = "redirectUri")]
    redirect_uri: Option<String>,
}

/// Start a local HTTP server for OAuth callback and open the URL in the
/// system default browser. Returns the actual redirect URI (with port)
/// so the frontend can build the correct OAuth URL.
#[tauri::command]
pub async fn open_oauth_window(app: AppHandle, url: String, _callback_url_prefix: String) -> CmdResult<()> {
    // Bind a local TCP listener on a random available port
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| smartstring::alias::String::from(format!("无法启动本地回调服务: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| smartstring::alias::String::from(format!("{e}")))?
        .port();

    let redirect_uri = format!("http://127.0.0.1:{port}");

    // The frontend already set redirect_uri as a placeholder.
    // We need to replace it in the URL with the actual port.
    // The value is URL-encoded in the query string, so we replace the encoded form.
    let placeholder_encoded = urlencoding::encode("http://127.0.0.1").to_string();
    let actual_encoded = urlencoding::encode(&redirect_uri).to_string();
    let final_url = url.replace(&placeholder_encoded, &actual_encoded);

    // Open in system default browser
    open::that(&final_url).map_err(|e| smartstring::alias::String::from(format!("无法打开浏览器: {e}")))?;

    // Spawn a task to wait for the OAuth callback
    tauri::async_runtime::spawn(async move {
        #[allow(clippy::expect_used)]
        let listener_handle =
            tokio::net::TcpListener::from_std(listener).expect("Failed to convert to tokio TcpListener");

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            accept_oauth_callback(listener_handle),
        )
        .await;

        match result {
            Ok(Ok((code, error))) => {
                let _ = app.emit(
                    "oauth-callback",
                    OAuthPayload {
                        code,
                        error,
                        redirect_uri: Some(redirect_uri),
                    },
                );
            }
            Ok(Err(_)) | Err(_) => {
                let _ = app.emit(
                    "oauth-callback",
                    OAuthPayload {
                        code: None,
                        error: Some("access_denied".to_string()),
                        redirect_uri: None,
                    },
                );
            }
        }
    });

    Ok(())
}

/// Accept a single HTTP request on the local listener and extract OAuth params.
async fn accept_oauth_callback(
    listener: tokio::net::TcpListener,
) -> Result<(Option<String>, Option<String>), Box<dyn std::error::Error + Send + Sync>> {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    let (mut stream, _) = listener.accept().await?;

    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await?;
    let request = String::from_utf8_lossy(&buf[..n]);

    let mut code: Option<String> = None;
    let mut error: Option<String> = None;

    if let Some(path_line) = request.lines().next()
        && let Some(query_start) = path_line.find('?')
    {
        let rest = &path_line[query_start + 1..];
        let query_end = rest.find(' ').unwrap_or(rest.len());
        let query = &rest[..query_end];

        for pair in query.split('&') {
            let mut kv = pair.splitn(2, '=');
            if let (Some(key), Some(value)) = (kv.next(), kv.next()) {
                let decoded = urlencoding::decode(value).unwrap_or_else(|_| value.into());
                match key {
                    "code" => code = Some(decoded.into_owned()),
                    "error" => error = Some(decoded.into_owned()),
                    _ => {}
                }
            }
        }
    }

    let (status, body) = if code.is_some() {
        (
            "200 OK",
            r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>XXLink</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f2ff}div{text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08)}h2{color:#4f46e5;margin-bottom:8px}p{color:#6b7280}</style></head><body><div><h2>✓ 登录成功</h2><p>请返回 XXLink 客户端</p><p style="font-size:13px;margin-top:16px;color:#9ca3af">此窗口可以安全关闭</p></div></body></html>"#,
        )
    } else {
        (
            "400 Bad Request",
            r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>XXLink</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f2ff}div{text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08)}h2{color:#ef4444;margin-bottom:8px}p{color:#6b7280}</style></head><body><div><h2>✗ 登录失败</h2><p>请返回 XXLink 客户端重试</p></div></body></html>"#,
        )
    };

    let response =
        format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n{body}");
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;

    Ok((code, error))
}
