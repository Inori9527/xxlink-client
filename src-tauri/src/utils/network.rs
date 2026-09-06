use crate::config::Config;
use anyhow::{Context as _, Result, anyhow};
use base64::{Engine as _, engine::general_purpose};
use reqwest::{
    Client, Proxy, StatusCode,
    header::{HeaderMap, HeaderValue, USER_AGENT},
};
use smartstring::alias::String;
use std::time::Duration;
use sysproxy::Sysproxy;
use tauri::Url;

#[derive(Debug)]
pub struct HttpResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

impl HttpResponse {
    pub const fn new(status: StatusCode, headers: HeaderMap, body: String) -> Self {
        Self { status, headers, body }
    }

    pub const fn status(&self) -> StatusCode {
        self.status
    }

    pub const fn headers(&self) -> &HeaderMap {
        &self.headers
    }

    pub fn text_with_charset(&self) -> Result<&str> {
        Ok(&self.body)
    }
}

#[derive(Debug, Clone, Copy)]
pub enum ProxyType {
    None,
    Localhost,
    System,
}

pub struct NetworkManager;

impl Default for NetworkManager {
    fn default() -> Self {
        Self::new()
    }
}

impl NetworkManager {
    pub const fn new() -> Self {
        Self
    }

    fn build_client(
        &self,
        proxy_url: Option<std::string::String>,
        default_headers: HeaderMap,
        accept_invalid_certs: bool,
        timeout_secs: Option<u64>,
    ) -> Result<Client> {
        let mut builder = Client::builder()
            .use_rustls_tls()
            .redirect(reqwest::redirect::Policy::limited(10))
            .tcp_keepalive(Duration::from_secs(60))
            .pool_max_idle_per_host(0)
            .pool_idle_timeout(None);

        // 设置代理
        if let Some(proxy_str) = proxy_url {
            let proxy = Proxy::all(proxy_str)?;
            builder = builder.proxy(proxy);
        } else {
            builder = builder.no_proxy();
        }

        builder = builder.default_headers(default_headers);

        // SSL/TLS
        if accept_invalid_certs {
            builder = builder
                .danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true);
        }

        // 超时设置
        if let Some(secs) = timeout_secs {
            builder = builder
                .timeout(Duration::from_secs(secs))
                .connect_timeout(Duration::from_secs(secs.min(30)));
        }

        Ok(builder.build()?)
    }

    pub async fn create_request(
        &self,
        proxy_type: ProxyType,
        timeout_secs: Option<u64>,
        user_agent: Option<String>,
        accept_invalid_certs: bool,
    ) -> Result<Client> {
        let proxy_url: Option<std::string::String> = match proxy_type {
            ProxyType::None => None,
            ProxyType::Localhost => {
                let port = {
                    let verge_port = Config::verge().await.data_arc().verge_mixed_port;
                    match verge_port {
                        Some(port) => port,
                        None => Config::clash().await.data_arc().get_mixed_port(),
                    }
                };
                Some(format!("http://127.0.0.1:{port}"))
            }
            ProxyType::System => {
                if let Ok(p @ Sysproxy { enable: true, .. }) = Sysproxy::get_system_proxy() {
                    Some(format!("http://{}:{}", p.host, p.port))
                } else {
                    None
                }
            }
        };

        let mut headers = HeaderMap::new();

        // 设置 User-Agent
        if let Some(ua) = user_agent {
            headers.insert(USER_AGENT, HeaderValue::from_str(ua.as_str())?);
        } else {
            headers.insert(
                USER_AGENT,
                HeaderValue::from_str(&format!("xxlink-client/v{}", env!("CARGO_PKG_VERSION")))?,
            );
        }

        let client = self.build_client(proxy_url, headers, accept_invalid_certs, timeout_secs)?;

        Ok(client)
    }

    pub async fn get_with_interrupt(
        &self,
        url: &str,
        proxy_type: ProxyType,
        timeout_secs: Option<u64>,
        user_agent: Option<String>,
        accept_invalid_certs: bool,
    ) -> Result<HttpResponse> {
        let mut parsed = Url::parse(url)?;
        let mut extra_headers = HeaderMap::new();

        if !parsed.username().is_empty()
            && let Some(pass) = parsed.password()
        {
            let username = percent_encoding::percent_decode_str(parsed.username())
                .decode_utf8_lossy()
                .into_owned();
            let password = percent_encoding::percent_decode_str(pass)
                .decode_utf8_lossy()
                .into_owned();
            let auth_str = format!("{}:{}", username, password);
            let encoded = general_purpose::STANDARD.encode(auth_str);
            extra_headers.insert("Authorization", HeaderValue::from_str(&format!("Basic {}", encoded))?);
        }

        parsed.set_username("").ok();
        parsed.set_password(None).ok();

        // 创建请求
        let client = self
            .create_request(proxy_type, timeout_secs, user_agent, accept_invalid_certs)
            .await?;

        let mut request_builder = client.get(parsed);

        for (key, value) in extra_headers.iter() {
            request_builder = request_builder.header(key, value);
        }

        let response = match request_builder.send().await {
            Ok(resp) => resp,
            Err(e) => {
                // `.context`, not `anyhow!("... {e}")`. Formatting the error
                // into a new message flattens it to a string, and every layer
                // above -- PrfItem::from_url, then the five call sites that ask
                // `fetch_error_class` what went wrong -- then has nothing to
                // downcast, so all of them reported "unknown" for every failure
                // there is. Keeping the source is what makes the class real.
                return Err(e).context("request failed");
            }
        };

        let status = response.status();
        let headers = response.headers().to_owned();
        // A non-2xx has to become a `reqwest::Error` HERE, because
        // `reqwest::Error` has no public constructor -- no fix confined to the
        // caller can ever produce a classifiable one. `prfitem.rs` used to
        // decide this itself with `status.is_success()` and `bail!`, which
        // builds a fresh error with no source, so every HTTP status failure
        // reported its class as "unknown": an expired token and a revoked
        // account, the two most common real failures, were indistinguishable
        // from a DNS error in the log and on the two user-visible surfaces.
        //
        // `_ref` rather than the consuming form: `response.text()` below still
        // needs the response, and a non-2xx body stays readable.
        if !response.status().is_success() {
            // 4xx/5xx give a real `reqwest::Error`. Everything else non-2xx does
            // not: a 304, a 1xx, or a 3xx the redirect policy did not follow
            // comes back as an ordinary response, and `error_for_status_ref`
            // says nothing about it. Those used to fall through to a `bail!` in
            // the caller and reach every log line as class "unknown".
            //
            // `anyhow!(status)` carries the StatusCode itself as the error's
            // payload, which `downcast_ref` finds -- no new type, and
            // `to_string()` stays the fixed context below rather than any text
            // the server chose.
            return match response.error_for_status_ref() {
                Err(err) => Err(err).context("remote profile responded with an error status"),
                Ok(_) => Err(anyhow!(response.status())).context("remote profile responded with an error status"),
            };
        }
        let body = match response.text().await {
            Ok(text) => text.into(),
            Err(e) => {
                return Err(e).context("failed to read response body");
            }
        };

        Ok(HttpResponse::new(status, headers, body))
    }
}
