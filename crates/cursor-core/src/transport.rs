//! In-process, HTTP/2-only Cursor RPC transport. No protocol heartbeats are generated here.

use std::{
    collections::HashMap,
    io::Read,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{anyhow, bail, ensure, Result};
use base64::Engine as _;
use bytes::{BufMut, Bytes, BytesMut};
use futures_util::future::poll_fn;
use http::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, TE};
use reqwest::{Response, Version};
use rustls::{
    pki_types::{pem::PemObject, CertificateDer, ServerName},
    ClientConfig, RootCertStore,
};
use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, Mutex as AsyncMutex},
};
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

const MAX_PAYLOAD: usize = 64 * 1024 * 1024;
const FRAME_HEADER: usize = 5;
const QUEUE_CAPACITY: usize = 4;
// A tolerated framed unary response can contain one message and one end envelope.
const MAX_UNARY_WIRE: usize = 2 * (MAX_PAYLOAD + FRAME_HEADER);
const MAX_CA_BUNDLE: u64 = 8 * 1024 * 1024;
const MAX_USAGE_RESPONSE: usize = 1024 * 1024;
const USAGE_PATH: &str = "/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const DEFAULT_CLIENT_VERSION: &str = "cli-2026.07.23-e383d2b";

pub enum Frame {
    Message(Vec<u8>),
    End(Value),
}

pub struct Connection {
    pub incoming: mpsc::Receiver<Result<Frame>>,
    /// Raw protobuf messages; the transport adds Connect envelopes.
    pub outgoing: mpsc::Sender<Vec<u8>>,
    pub cancel: CancellationToken,
}

/// Clones share only this client's pool. Workers never retain ClientInner, so dropping the
/// last public handle cancels drivers even when an RPC or TLS handshake is still pending.
#[derive(Clone)]
pub struct Client {
    inner: Arc<ClientInner>,
}

struct ClientInner {
    unary: reqwest::Client,
    pool: Arc<H2Pool>,
}

impl Client {
    /// Permanently stop this client's connections and pending streams (including all clones).
    pub fn shutdown(&self) {
        self.inner.pool.shutdown.cancel();
    }
}

impl Drop for ClientInner {
    fn drop(&mut self) {
        self.pool.shutdown.cancel();
    }
}

/// Native trust, h2-only ALPN, explicit environment proxy policy, and no redirects.
pub fn client() -> Result<Client> {
    build_client(ProxyConfig::from_env()?)
}

fn build_client(proxies: ProxyConfig) -> Result<Client> {
    let native = rustls_native_certs::load_native_certs();
    let mut roots = RootCertStore::empty();
    for certificate in native.certs {
        roots
            .add(certificate)
            .map_err(|_| anyhow!("Cannot initialize native TLS trust roots"))?;
    }

    if let Some(path) = std::env::var_os("NODE_EXTRA_CA_CERTS").filter(|path| !path.is_empty()) {
        // Only read bounded public certificates; never attach parser/file errors or paths.
        let metadata = std::fs::metadata(&path)
            .map_err(|_| anyhow!("Cannot read NODE_EXTRA_CA_CERTS public CA bundle"))?;
        ensure!(
            metadata.is_file() && metadata.len() <= MAX_CA_BUNDLE,
            "NODE_EXTRA_CA_CERTS must be a regular public CA PEM file of at most 8 MiB"
        );
        let file = std::fs::File::open(path)
            .map_err(|_| anyhow!("Cannot read NODE_EXTRA_CA_CERTS public CA bundle"))?;
        let metadata = file
            .metadata()
            .map_err(|_| anyhow!("Cannot inspect NODE_EXTRA_CA_CERTS public CA bundle"))?;
        ensure!(
            metadata.is_file() && metadata.len() <= MAX_CA_BUNDLE,
            "NODE_EXTRA_CA_CERTS must be a regular public CA PEM file of at most 8 MiB"
        );
        let mut pem = Vec::new();
        file.take(MAX_CA_BUNDLE + 1)
            .read_to_end(&mut pem)
            .map_err(|_| anyhow!("Cannot read NODE_EXTRA_CA_CERTS public CA bundle"))?;
        ensure!(
            pem.len() as u64 <= MAX_CA_BUNDLE,
            "NODE_EXTRA_CA_CERTS public CA bundle exceeds 8 MiB"
        );
        for certificate in public_ca_certificates(&pem)? {
            roots.add(certificate).map_err(|_| {
                anyhow!("NODE_EXTRA_CA_CERTS contains invalid public CA certificates")
            })?;
        }
    }
    ensure!(
        !roots.is_empty(),
        "Cannot initialize native TLS trust roots"
    );
    let mut tls =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|_| anyhow!("Cannot initialize TLS protocol policy"))?
            .with_root_certificates(roots)
            .with_no_client_auth();
    tls.alpn_protocols = vec![b"h2".to_vec()];
    let mut proxy_tls = tls.clone();
    proxy_tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    let proxies = Arc::new(proxies);
    let unary_proxies = proxies.clone();
    let unary = reqwest::Client::builder()
        .use_preconfigured_tls(tls.clone())
        .http2_prior_knowledge()
        .http2_keep_alive_interval(Duration::from_secs(20))
        .http2_keep_alive_timeout(Duration::from_secs(20))
        .http2_keep_alive_while_idle(true)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .proxy(reqwest::Proxy::custom(move |url| {
            unary_proxies.proxy_for(url).map(|proxy| proxy.url.clone())
        }))
        .build()
        .map_err(|_| anyhow!("Cannot initialize Cursor HTTP/2 client or TLS trust roots"))?;
    Ok(Client {
        inner: Arc::new(ClientInner {
            unary,
            pool: Arc::new(H2Pool {
                origins: Mutex::new(HashMap::new()),
                tls: Arc::new(tls),
                proxy_tls: Arc::new(proxy_tls),
                proxies,
                shutdown: CancellationToken::new(),
            }),
        }),
    })
}

fn public_ca_certificates(pem: &[u8]) -> Result<Vec<rustls::pki_types::CertificateDer<'static>>> {
    let text = std::str::from_utf8(pem)
        .map_err(|_| anyhow!("NODE_EXTRA_CA_CERTS is not a public CA PEM bundle"))?;
    // Check every delimiter, including ones the PEM iterator would otherwise skip.
    let mut inside = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with("-----BEGIN ") {
            ensure!(
                line == "-----BEGIN CERTIFICATE-----" && !inside,
                "NODE_EXTRA_CA_CERTS must contain public certificates, not keys or identities"
            );
            inside = true;
        } else if line.starts_with("-----END ") {
            ensure!(
                line == "-----END CERTIFICATE-----" && inside,
                "NODE_EXTRA_CA_CERTS contains invalid public CA PEM"
            );
            inside = false;
        }
    }
    ensure!(
        !inside,
        "NODE_EXTRA_CA_CERTS contains truncated public CA PEM"
    );
    let certificates = CertificateDer::pem_slice_iter(pem)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| anyhow!("NODE_EXTRA_CA_CERTS contains invalid public CA PEM"))?;
    ensure!(
        !certificates.is_empty(),
        "NODE_EXTRA_CA_CERTS contains no public CA certificates"
    );
    // Validate DER too, not just base64/PEM syntax.
    let mut roots = RootCertStore::empty();
    for certificate in &certificates {
        roots
            .add(certificate.clone())
            .map_err(|_| anyhow!("NODE_EXTRA_CA_CERTS contains invalid public CA certificates"))?;
    }
    Ok(certificates)
}

type OriginSlot = Arc<AsyncMutex<Option<Arc<PooledConnection>>>>;

struct H2Pool {
    origins: Mutex<HashMap<String, OriginSlot>>,
    tls: Arc<ClientConfig>,
    proxy_tls: Arc<ClientConfig>,
    proxies: Arc<ProxyConfig>,
    shutdown: CancellationToken,
}

struct PooledConnection {
    sender: h2::client::SendRequest<Bytes>,
    closed: CancellationToken,
}

impl H2Pool {
    async fn ready(&self, endpoint: &Url) -> Result<h2::client::SendRequest<Bytes>> {
        let slot = self
            .origins
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(endpoint.origin().ascii_serialization())
            .or_insert_with(|| Arc::new(AsyncMutex::new(None)))
            .clone();
        // Retry only readiness on a dead/GOAWAY connection, never a submitted RPC.
        for _ in 0..2 {
            ensure!(
                !self.shutdown.is_cancelled(),
                "Cursor HTTP/2 client is shut down"
            );
            let connection = {
                let mut cached = slot.lock().await;
                if cached
                    .as_ref()
                    .is_some_and(|connection| connection.closed.is_cancelled())
                {
                    *cached = None;
                }
                if cached.is_none() {
                    *cached = Some(self.connect(endpoint).await?);
                }
                cached.as_ref().expect("initialized connection").clone()
            };
            if let Ok(sender) = connection.sender.clone().ready().await {
                return Ok(sender);
            }
            let mut cached = slot.lock().await;
            if cached
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &connection))
            {
                // Do not cancel the old driver: its other streams may still be active.
                *cached = None;
            }
        }
        Err(h2_error())
    }

    async fn connect(&self, endpoint: &Url) -> Result<Arc<PooledConnection>> {
        let mut io = if let Some(proxy) = self.proxies.proxy_for(endpoint) {
            let mut io = tcp_connect(&proxy.url).await?;
            if proxy.url.scheme() == "https" {
                io = tls_connect(io, &proxy.url, self.proxy_tls.clone(), false).await?;
            }
            connect_tunnel(&mut io, endpoint, proxy.authorization.as_ref()).await?;
            io
        } else {
            tcp_connect(endpoint).await?
        };
        if endpoint.scheme() == "https" {
            io = tls_connect(io, endpoint, self.tls.clone(), true).await?;
        }
        let (sender, connection) = h2::client::Builder::new()
            .enable_push(false)
            .handshake(io)
            .await
            .map_err(|_| h2_error())?;
        let closed = CancellationToken::new();
        let driver_closed = closed.clone();
        let shutdown = self.shutdown.clone();
        tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => {},
                _ = connection => {},
            }
            driver_closed.cancel();
        });
        Ok(Arc::new(PooledConnection { sender, closed }))
    }
}

trait TransportIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> TransportIo for T {}
type BoxIo = Box<dyn TransportIo>;

fn host_name(url: &Url) -> String {
    match url.host().expect("validated host") {
        Host::Domain(host) => host.to_owned(),
        Host::Ipv4(host) => host.to_string(),
        Host::Ipv6(host) => host.to_string(),
    }
}

async fn tcp_connect(url: &Url) -> Result<BoxIo> {
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow!("Invalid destination port"))?;
    let socket = TcpStream::connect((host_name(url).as_str(), port))
        .await
        .map_err(|_| {
            anyhow!("Cursor HTTP/2 connection failed; check TLS trust, proxies and h2 ALPN support")
        })?;
    socket.set_nodelay(true).map_err(|_| h2_error())?;
    Ok(Box::new(socket))
}

async fn tls_connect(
    io: BoxIo,
    endpoint: &Url,
    config: Arc<ClientConfig>,
    require_h2: bool,
) -> Result<BoxIo> {
    let name = ServerName::try_from(host_name(endpoint))
        .map_err(|_| anyhow!("Invalid TLS server name"))?;
    let tls = tokio_rustls::TlsConnector::from(config)
        .connect(name, io)
        .await
        .map_err(|_| {
            anyhow!(
                "Cursor TLS connection failed; check native trust roots and proxy configuration"
            )
        })?;
    let alpn = tls.get_ref().1.alpn_protocol();
    if require_h2 {
        ensure!(
            alpn == Some(b"h2".as_slice()),
            "Cursor requires HTTP/2 h2 ALPN; no HTTP/1 fallback is supported"
        );
    } else {
        ensure!(
            alpn.is_none() || alpn == Some(b"http/1.1".as_slice()),
            "HTTPS proxy requires HTTP/1.1 CONNECT"
        );
    }
    Ok(Box::new(tls))
}

async fn connect_tunnel(
    io: &mut BoxIo,
    endpoint: &Url,
    authorization: Option<&HeaderValue>,
) -> Result<()> {
    let port = endpoint
        .port_or_known_default()
        .ok_or_else(|| anyhow!("Invalid destination port"))?;
    let authority = match endpoint.host().expect("validated host") {
        Host::Ipv6(host) => format!("[{host}]:{port}"),
        host => format!("{host}:{port}"),
    };
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some(authorization) = authorization {
        request.push_str("Proxy-Authorization: ");
        request.push_str(
            authorization
                .to_str()
                .map_err(|_| anyhow!("Invalid proxy authorization"))?,
        );
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    io.write_all(request.as_bytes())
        .await
        .map_err(|_| anyhow!("Cursor proxy CONNECT failed"))?;
    let mut response = Vec::new();
    // Never consume bytes belonging to the tunnel. Bound untrusted proxy headers.
    while !response.ends_with(b"\r\n\r\n") {
        ensure!(
            response.len() < 32 * 1024,
            "Cursor proxy CONNECT response headers exceed the size limit"
        );
        let mut byte = [0; 1];
        io.read_exact(&mut byte)
            .await
            .map_err(|_| anyhow!("Cursor proxy CONNECT failed"))?;
        response.push(byte[0]);
    }
    let status = response
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    ensure!(
        status.starts_with(b"HTTP/1.1 200 ")
            || status.starts_with(b"HTTP/1.0 200 ")
            || status == b"HTTP/1.1 200\r"
            || status == b"HTTP/1.0 200\r",
        "Cursor proxy CONNECT was rejected; redirects are not supported"
    );
    Ok(())
}

#[derive(Clone)]
struct Proxy {
    url: Url,
    authorization: Option<HeaderValue>,
}

impl Proxy {
    fn parse(raw: &str) -> Result<Self> {
        ensure!(
            !raw.bytes()
                .any(|byte| byte <= b' ' || byte == 0x7f || byte == b'\\'),
            "Invalid Cursor proxy URL"
        );
        ensure!(raw.contains("://"), "Invalid Cursor proxy URL");
        let url = Url::parse(raw).map_err(|_| anyhow!("Invalid Cursor proxy URL"))?;
        ensure!(
            matches!(url.scheme(), "http" | "https"),
            "Unsupported Cursor proxy type; only HTTP(S) CONNECT proxies are supported"
        );
        ensure!(
            url.host().is_some()
                && url.port_or_known_default().is_some_and(|port| port != 0)
                && matches!(url.path(), "" | "/")
                && url.query().is_none()
                && url.fragment().is_none(),
            "Invalid Cursor proxy URL"
        );
        let authorization = if !url.username().is_empty() || url.password().is_some() {
            let user = proxy_credential(url.username())?;
            ensure!(!user.contains(':'), "Invalid proxy username");
            let password = proxy_credential(url.password().unwrap_or_default())?;
            let basic =
                base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
            let mut value = HeaderValue::from_str(&format!("Basic {basic}"))
                .map_err(|_| anyhow!("Invalid proxy authorization"))?;
            value.set_sensitive(true);
            Some(value)
        } else {
            None
        };
        Ok(Self { url, authorization })
    }
}

fn proxy_credential(encoded: &str) -> Result<String> {
    let mut decoded = Vec::new();
    let mut bytes = encoded.bytes();
    while let Some(byte) = bytes.next() {
        let byte = if byte == b'%' {
            let high = bytes.next().and_then(|byte| (byte as char).to_digit(16));
            let low = bytes.next().and_then(|byte| (byte as char).to_digit(16));
            match (high, low) {
                (Some(high), Some(low)) => (high * 16 + low) as u8,
                _ => bail!("Invalid proxy credentials"),
            }
        } else {
            byte
        };
        ensure!(!byte.is_ascii_control(), "Invalid proxy credentials");
        decoded.push(byte);
    }
    String::from_utf8(decoded).map_err(|_| anyhow!("Invalid proxy credentials"))
}

#[derive(Default)]
struct ProxyConfig {
    http: Option<Proxy>,
    https: Option<Proxy>,
    bypass: Vec<Bypass>,
}

impl ProxyConfig {
    fn from_env() -> Result<Self> {
        fn variable(name: &str) -> Result<Option<String>> {
            match std::env::var(name) {
                Ok(value) if !value.is_empty() => Ok(Some(value)),
                Ok(_) | Err(std::env::VarError::NotPresent) => Ok(None),
                Err(_) => bail!("Proxy environment variables must contain valid UTF-8"),
            }
        }
        fn setting(lower: &str, upper: &str) -> Result<Option<String>> {
            if let Some(value) = variable(lower)? {
                return Ok(Some(value));
            }
            // Avoid the CGI HTTP_PROXY/httpoxy trap.
            if upper == "HTTP_PROXY" && std::env::var_os("REQUEST_METHOD").is_some() {
                return Ok(None);
            }
            variable(upper)
        }
        let all = setting("all_proxy", "ALL_PROXY")?;
        let http = setting("http_proxy", "HTTP_PROXY")?.or_else(|| all.clone());
        let https = setting("https_proxy", "HTTPS_PROXY")?.or(all);
        let bypass = setting("no_proxy", "NO_PROXY")?.unwrap_or_default();
        Self::parse(http.as_deref(), https.as_deref(), &bypass)
    }

    fn parse(http: Option<&str>, https: Option<&str>, bypass: &str) -> Result<Self> {
        Ok(Self {
            http: http.map(Proxy::parse).transpose()?,
            https: https.map(Proxy::parse).transpose()?,
            bypass: bypass
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(Bypass::parse)
                .collect::<Result<_>>()?,
        })
    }

    fn proxy_for(&self, endpoint: &Url) -> Option<&Proxy> {
        if self.bypass.iter().any(|rule| rule.matches(endpoint)) {
            None
        } else if endpoint.scheme() == "https" {
            self.https.as_ref()
        } else {
            self.http.as_ref()
        }
    }
}

enum Bypass {
    All,
    Domain(String, Option<u16>),
    Network(IpAddr, u8, Option<u16>),
}

impl Bypass {
    fn parse(raw: &str) -> Result<Self> {
        if raw == "*" {
            return Ok(Self::All);
        }
        if let Some((address, prefix)) = raw.split_once('/') {
            let address: IpAddr = address
                .parse()
                .map_err(|_| anyhow!("Invalid NO_PROXY network"))?;
            let prefix = prefix
                .parse::<u8>()
                .map_err(|_| anyhow!("Invalid NO_PROXY network"))?;
            ensure!(
                prefix <= if address.is_ipv4() { 32 } else { 128 },
                "Invalid NO_PROXY network"
            );
            return Ok(Self::Network(address, prefix, None));
        }
        let (host, port) = if let Some(rest) = raw.strip_prefix('[') {
            let (host, rest) = rest
                .split_once(']')
                .ok_or_else(|| anyhow!("Invalid NO_PROXY host"))?;
            ensure!(
                host.parse::<std::net::Ipv6Addr>().is_ok(),
                "Invalid NO_PROXY host"
            );
            (
                host,
                if rest.is_empty() {
                    None
                } else {
                    Some(
                        rest.strip_prefix(':')
                            .ok_or_else(|| anyhow!("Invalid NO_PROXY port"))?,
                    )
                },
            )
        } else if raw.matches(':').count() == 1 {
            let (host, port) = raw
                .split_once(':')
                .ok_or_else(|| anyhow!("Invalid NO_PROXY host"))?;
            (host, Some(port))
        } else {
            (raw, None)
        };
        let port = port
            .map(|port| {
                port.parse::<u16>()
                    .ok()
                    .filter(|port| *port != 0)
                    .ok_or_else(|| anyhow!("Invalid NO_PROXY port"))
            })
            .transpose()?;
        if let Ok(address) = host.parse::<IpAddr>() {
            return Ok(Self::Network(
                address,
                if address.is_ipv4() { 32 } else { 128 },
                port,
            ));
        }
        let host = host
            .strip_prefix("*.")
            .unwrap_or(host)
            .trim_start_matches('.')
            .trim_end_matches('.');
        ensure!(
            !host.is_empty()
                && host
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')),
            "Unsupported NO_PROXY host pattern"
        );
        Ok(Self::Domain(host.to_ascii_lowercase(), port))
    }

    fn matches(&self, endpoint: &Url) -> bool {
        match self {
            Self::All => true,
            Self::Domain(domain, port) => {
                port.is_none_or(|port| endpoint.port_or_known_default() == Some(port))
                    && matches!(endpoint.host(), Some(Host::Domain(host))
                        if host.trim_end_matches('.') == domain
                            || host.trim_end_matches('.').ends_with(&format!(".{domain}")))
            }
            Self::Network(network, prefix, port) => {
                if port.is_some_and(|port| endpoint.port_or_known_default() != Some(port)) {
                    return false;
                }
                match (network, endpoint.host()) {
                    (IpAddr::V4(network), Some(Host::Ipv4(host))) => {
                        *prefix == 0
                            || u32::from(*network) >> (32 - prefix)
                                == u32::from(host) >> (32 - prefix)
                    }
                    (IpAddr::V6(network), Some(Host::Ipv6(host))) => {
                        *prefix == 0
                            || u128::from(*network) >> (128 - prefix)
                                == u128::from(host) >> (128 - prefix)
                    }
                    _ => false,
                }
            }
        }
    }
}

fn h2_error() -> anyhow::Error {
    // No source chain: h2/TLS/proxy errors may include peer-controlled or credential material.
    anyhow!("Cursor HTTP/2 transport failed; check TLS trust, proxies and h2 ALPN support")
}

/// Start a duplex RPC immediately, before connection establishment or response headers. Only
/// the header wait is timed; cancellation remains effective at every upload/backpressure await.
pub async fn open(
    client: &Client,
    url: &str,
    rpc_path: &str,
    access_token: &str,
    initial: Vec<u8>,
    timeout_ms: u64,
) -> Result<Connection> {
    ensure!(
        initial.len() <= MAX_PAYLOAD,
        "Outgoing Connect payload exceeds 64 MiB"
    );
    ensure!(
        !client.inner.pool.shutdown.is_cancelled(),
        "Cursor HTTP/2 client is shut down"
    );
    let endpoint = destination(url, rpc_path)?;
    let headers = request_headers(access_token, false)?;
    let (incoming_tx, incoming) = mpsc::channel(QUEUE_CAPACITY);
    let (outgoing, outgoing_rx) = mpsc::channel(QUEUE_CAPACITY);
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let pool = client.inner.pool.clone();
    let shutdown = pool.shutdown.clone();
    tokio::spawn(async move {
        let work = async {
            if let Err(error) = stream_rpc(
                &pool,
                endpoint,
                headers,
                initial,
                outgoing_rx,
                &incoming_tx,
                timeout_ms,
            )
            .await
            {
                let _ = incoming_tx.send(Err(error)).await;
            }
        };
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => {},
            _ = task_cancel.cancelled() => {},
            _ = incoming_tx.closed() => {},
            _ = work => {},
        }
    });
    Ok(Connection {
        incoming,
        outgoing,
        cancel,
    })
}

/// The handle is owned outside all upload/header futures. Dropping any of those futures
/// explicitly resets the individual stream; RST_STREAM is not subject to DATA flow control.
struct RequestStream {
    send: h2::SendStream<Bytes>,
    half_closed: bool,
    complete: bool,
}

impl RequestStream {
    fn close_upload(&mut self) -> Result<()> {
        if !self.half_closed {
            self.send.reserve_capacity(0);
            self.send
                .send_data(Bytes::new(), true)
                .map_err(|_| h2_error())?;
            self.half_closed = true;
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<()> {
        self.close_upload()?;
        self.complete = true;
        Ok(())
    }
}

impl Drop for RequestStream {
    fn drop(&mut self) {
        if !self.complete {
            self.send.send_reset(h2::Reason::CANCEL);
        }
    }
}

async fn stream_rpc(
    pool: &H2Pool,
    endpoint: Url,
    headers: HeaderMap,
    initial: Vec<u8>,
    mut outgoing: mpsc::Receiver<Vec<u8>>,
    incoming: &mpsc::Sender<Result<Frame>>,
    timeout_ms: u64,
) -> Result<()> {
    let deadline = if timeout_ms == 0 {
        None
    } else {
        Some(
            tokio::time::Instant::now()
                .checked_add(Duration::from_millis(timeout_ms))
                .ok_or_else(|| anyhow!("Cursor HTTP/2 timeout is too large"))?,
        )
    };
    let mut sender = before_deadline(deadline, pool.ready(&endpoint)).await??;
    let mut request = http::Request::builder()
        .method(http::Method::POST)
        .uri(endpoint.as_str())
        .version(Version::HTTP_2)
        .body(())
        .map_err(|_| anyhow!("Cannot build Cursor HTTP/2 streaming request"))?;
    *request.headers_mut() = headers;
    let (response, send) = sender
        .send_request(request, false)
        .map_err(|_| h2_error())?;
    let mut stream = RequestStream {
        send,
        half_closed: false,
        complete: false,
    };
    {
        let upload = async {
            send_message(&mut stream.send, initial).await?;
            while let Some(message) = outgoing.recv().await {
                send_message(&mut stream.send, message).await?;
            }
            stream.close_upload()
        };
        let receive = async {
            let response = before_deadline(deadline, response)
                .await?
                .map_err(|_| h2_error())?;
            ensure!(
                response.status().is_success(),
                "Cursor HTTP/2 request failed with HTTP {}",
                response.status().as_u16()
            );
            receive_stream(response.into_body(), incoming).await
        };
        tokio::pin!(upload, receive);
        tokio::select! {
            result = &mut receive => result?,
            result = &mut upload => {
                result?;
                receive.await?;
            }
        }
    }
    // A complete response ends the RPC even if its upload was still waiting on capacity.
    stream.finish()
}

async fn before_deadline<F: std::future::Future>(
    deadline: Option<tokio::time::Instant>,
    future: F,
) -> Result<F::Output> {
    match deadline {
        Some(deadline) => tokio::time::timeout_at(deadline, future)
            .await
            .map_err(|_| anyhow!("Cursor HTTP/2 request timed out")),
        None => Ok(future.await),
    }
}

async fn send_message(send: &mut h2::SendStream<Bytes>, message: Vec<u8>) -> Result<()> {
    let mut frame = encode_message(message)?;
    while !frame.is_empty() {
        // Never hand an unbounded DATA buffer to h2. Cancellation can drop this future at
        // poll_capacity while RequestStream retains the independent reset handle.
        send.reserve_capacity(frame.len().min(16 * 1024));
        let capacity = poll_fn(|cx| send.poll_capacity(cx))
            .await
            .ok_or_else(h2_error)?
            .map_err(|_| h2_error())?;
        let length = capacity.min(frame.len()).min(16 * 1024);
        send.send_data(frame.split_to(length), false)
            .map_err(|_| h2_error())?;
    }
    Ok(())
}

async fn receive_stream(
    mut body: h2::RecvStream,
    incoming: &mpsc::Sender<Result<Frame>>,
) -> Result<()> {
    let mut decoder = Decoder::default();
    let mut end = None;
    while let Some(chunk) = body.data().await {
        let chunk = chunk.map_err(|_| h2_error())?;
        let mut remaining = chunk.as_ref();
        while !remaining.is_empty() {
            match decoder.next(&mut remaining)? {
                Some(Frame::End(value)) => end = Some(value),
                Some(frame) => incoming
                    .send(Ok(frame))
                    .await
                    .map_err(|_| anyhow!("Cursor response receiver closed"))?,
                None => break,
            }
        }
        // Backpressure from the bounded parsed-frame queue reaches the peer's stream window.
        body.flow_control()
            .release_capacity(chunk.len())
            .map_err(|_| h2_error())?;
    }
    body.trailers().await.map_err(|_| h2_error())?;
    // Do not expose End before HTTP EOF/trailer validation; trailing bytes must still fail.
    decoder.finish(true)?;
    if let Some(end) = end {
        incoming
            .send(Ok(Frame::End(end)))
            .await
            .map_err(|_| anyhow!("Cursor response receiver closed"))?;
    }
    Ok(())
}

/// Unary Connect uses a raw protobuf request, not a Connect envelope. The timeout covers the
/// entire response; dropping this future also drops the request/response, with no detached task.
pub async fn unary(
    client: &Client,
    url: &str,
    rpc_path: &str,
    access_token: &str,
    body: Vec<u8>,
    timeout_ms: u64,
) -> Result<Vec<u8>> {
    ensure!(
        body.len() <= MAX_PAYLOAD,
        "Cursor unary request exceeds 64 MiB"
    );
    ensure!(
        !client.inner.pool.shutdown.is_cancelled(),
        "Cursor HTTP/2 client is shut down"
    );
    let request = client
        .inner
        .unary
        .post(destination(url, rpc_path)?)
        .version(Version::HTTP_2)
        .headers(request_headers(access_token, true)?)
        .body(body)
        .build()
        .map_err(|_| anyhow!("Cannot build Cursor HTTP/2 unary request"))?;
    let work = with_timeout(timeout_ms, async {
        let mut response = client
            .inner
            .unary
            .execute(request)
            .await
            .map_err(transport_error)?;
        validate_response(&response)?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_UNARY_WIRE as u64)
        {
            bail!("Cursor unary response exceeds the size limit");
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
            ensure!(
                chunk.len() <= MAX_UNARY_WIRE - body.len(),
                "Cursor unary response exceeds the size limit"
            );
            body.extend_from_slice(&chunk);
        }
        decode_unary(body)
    });
    tokio::select! {
        biased;
        _ = client.inner.pool.shutdown.cancelled() => bail!("Cursor HTTP/2 client is shut down"),
        result = work => result?,
    }
}

/// A narrow read-only JSON API, deliberately not a generic authenticated RPC.
/// The destination and empty request cannot be overridden by input or environment.
/// Uses this client's native trust/proxy policy, no redirects, and no automatic retry.
pub(crate) async fn get_usage(client: &Client, access_token: &str) -> Result<Value> {
    execute_usage(client, usage_request(client, access_token)?).await
}

fn usage_request(client: &Client, access_token: &str) -> Result<reqwest::Request> {
    let mut headers = request_headers(access_token, true)?;
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    client
        .inner
        .unary
        .post(destination_with_policy(
            "https://api2.cursor.sh",
            USAGE_PATH,
            false,
        )?)
        .version(Version::HTTP_2)
        .headers(headers)
        .body("{}")
        .build()
        .map_err(|_| anyhow!("Cannot build Cursor usage request"))
}

async fn execute_usage(client: &Client, request: reqwest::Request) -> Result<Value> {
    let work = with_timeout(10_000, async {
        let mut response = client
            .inner
            .unary
            .execute(request)
            .await
            .map_err(transport_error)?;
        validate_response(&response)?;
        ensure!(
            !response
                .content_length()
                .is_some_and(|length| length > MAX_USAGE_RESPONSE as u64),
            "Cursor usage response exceeds 1 MiB"
        );
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
            ensure!(
                chunk.len() <= MAX_USAGE_RESPONSE - body.len(),
                "Cursor usage response exceeds 1 MiB"
            );
            body.extend_from_slice(&chunk);
        }
        let value: Value =
            serde_json::from_slice(&body).map_err(|_| anyhow!("Invalid Cursor usage JSON"))?;
        ensure!(
            value.is_object(),
            "Cursor usage response must be a JSON object"
        );
        Ok(value)
    });
    tokio::select! {
        biased;
        _ = client.inner.pool.shutdown.cancelled() => bail!("Cursor HTTP/2 client is shut down"),
        result = work => result?,
    }
}

async fn with_timeout<F: std::future::Future>(timeout_ms: u64, future: F) -> Result<F::Output> {
    if timeout_ms == 0 {
        Ok(future.await)
    } else {
        tokio::time::timeout(Duration::from_millis(timeout_ms), future)
            .await
            .map_err(|_| anyhow!("Cursor HTTP/2 request timed out"))
    }
}

fn request_headers(access_token: &str, unary: bool) -> Result<HeaderMap> {
    ensure!(!access_token.is_empty(), "Cursor access token is empty");
    let mut authorization = HeaderValue::from_str(&format!("Bearer {access_token}"))
        .map_err(|_| anyhow!("Cursor access token is not a valid HTTP header value"))?;
    authorization.set_sensitive(true);
    let version = std::env::var("CURSOR_NATIVE_CLIENT_VERSION")
        .or_else(|_| std::env::var("OPENCODE_CURSOR_CLIENT_VERSION"))
        .or_else(|_| std::env::var("PI_CURSOR_CLIENT_VERSION"))
        .unwrap_or_default();
    let version = if version.trim().is_empty() {
        DEFAULT_CLIENT_VERSION
    } else {
        version.trim()
    };
    let version = HeaderValue::from_str(version)
        .map_err(|_| anyhow!("Cursor client version is not a valid HTTP header value"))?;
    let request_id = HeaderValue::from_str(&uuid::Uuid::new_v4().to_string())
        .map_err(|_| anyhow!("Cannot initialize Cursor request ID"))?;
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, authorization);
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static(if unary {
            "application/proto"
        } else {
            "application/connect+proto"
        }),
    );
    headers.insert("connect-protocol-version", HeaderValue::from_static("1"));
    headers.insert(TE, HeaderValue::from_static("trailers"));
    headers.insert("x-ghost-mode", HeaderValue::from_static("true"));
    headers.insert("x-cursor-client-type", HeaderValue::from_static("cli"));
    headers.insert("x-cursor-client-version", version);
    headers.insert("x-request-id", request_id);
    Ok(headers)
}

fn destination(url: &str, rpc_path: &str) -> Result<Url> {
    destination_with_policy(
        url,
        rpc_path,
        std::env::var("CURSOR_NATIVE_ALLOW_CUSTOM_URL")
            .or_else(|_| std::env::var("OPENCODE_CURSOR_ALLOW_CUSTOM_URL"))
            .is_ok_and(|value| value == "1"),
    )
}

fn destination_with_policy(raw: &str, rpc_path: &str, allow_custom: bool) -> Result<Url> {
    // Reject URL-parser normalization of whitespace, backslashes and empty userinfo too.
    ensure!(
        !raw.bytes()
            .any(|byte| byte <= b' ' || byte == 0x7f || byte == b'\\'),
        "Invalid Cursor destination URL"
    );
    let mut url = Url::parse(raw).map_err(|_| anyhow!("Invalid Cursor destination URL"))?;
    let authority = raw
        .split_once("://")
        .and_then(|(_, rest)| rest.split(['/', '?', '#']).next())
        .ok_or_else(|| anyhow!("Invalid Cursor destination URL"))?;
    ensure!(
        url.username().is_empty() && url.password().is_none() && !authority.contains('@'),
        "Cursor destination URL must not contain userinfo"
    );
    ensure!(
        url.query().is_none() && url.fragment().is_none(),
        "Cursor destination URL must not contain a query or fragment"
    );
    let host = url
        .host()
        .ok_or_else(|| anyhow!("Cursor destination URL has no host"))?;
    ensure!(
        url.port_or_known_default().is_some_and(|port| port != 0),
        "Invalid Cursor destination port"
    );
    let loopback = match host {
        Host::Domain(host) => host == "localhost",
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    };
    ensure!(
        url.scheme() == "https" || (url.scheme() == "http" && loopback),
        "Cursor destination requires HTTPS (HTTP is allowed only for loopback tests)"
    );
    let trusted = match host {
        Host::Domain(host) => {
            host == "cursor.sh"
                || host.ends_with(".cursor.sh")
                || host == "cursor.com"
                || host.ends_with(".cursor.com")
        }
        _ => false,
    };
    ensure!(
        trusted || loopback || allow_custom,
        "Cursor destination host is not allowed; custom HTTPS hosts require CURSOR_NATIVE_ALLOW_CUSTOM_URL=1"
    );
    ensure!(
        rpc_path.starts_with('/')
            && !rpc_path.starts_with("//")
            && !rpc_path
                .bytes()
                .any(|byte| byte <= b' ' || byte == 0x7f || matches!(byte, b'?' | b'#' | b'\\')),
        "Cursor RPC path must be an absolute path without a query, fragment or authority"
    );
    // Like node:http2's :path, rpc_path replaces any path on the connection URL; it cannot
    // replace the validated scheme/authority, unlike joining an arbitrary URL string.
    url.set_path(rpc_path);
    Ok(url)
}

fn validate_response(response: &Response) -> Result<()> {
    ensure!(
        response.version() == Version::HTTP_2,
        "Cursor requires HTTP/2; no HTTP/1 fallback is supported (check proxy ALPN support)"
    );
    ensure!(
        response.status().is_success(),
        "Cursor HTTP/2 request failed with HTTP {}",
        response.status().as_u16()
    );
    Ok(())
}

fn transport_error(error: reqwest::Error) -> anyhow::Error {
    // Do not attach the original source: it can contain URLs, credentials, proxy diagnostics,
    // or arbitrary server bytes. Error chains and Debug output must be safe as well as Display.
    if error.is_timeout() {
        anyhow!("Cursor HTTP/2 request timed out")
    } else if error.is_connect() {
        anyhow!("Cursor HTTP/2 connection failed; check TLS trust, proxies and h2 ALPN support")
    } else if error.is_body() {
        anyhow!(
            "Cursor HTTP/2 body transfer failed (outgoing Connect payloads must be at most 64 MiB)"
        )
    } else {
        anyhow!("Cursor HTTP/2 transport failed; HTTP/1 fallback is not supported")
    }
}

fn encode_message(message: Vec<u8>) -> Result<Bytes, std::io::Error> {
    if message.len() > MAX_PAYLOAD {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Outgoing Connect payload exceeds 64 MiB",
        ));
    }
    let mut frame = BytesMut::with_capacity(FRAME_HEADER + message.len());
    frame.put_u8(0);
    frame.put_u32(message.len() as u32);
    frame.extend_from_slice(&message);
    Ok(frame.freeze())
}

/// A single-pass parser: copy each payload once, never drain/rescan an accumulated prefix.
/// At most one declared (bounded) payload is buffered, even if a chunk has many frames.
#[derive(Default)]
struct Decoder {
    header: [u8; FRAME_HEADER],
    header_len: usize,
    payload_len: usize,
    payload: Vec<u8>,
    ended: bool,
}

impl Decoder {
    fn next(&mut self, input: &mut &[u8]) -> Result<Option<Frame>> {
        ensure!(
            !self.ended || input.is_empty(),
            "Bytes received after Connect end-stream frame"
        );
        if input.is_empty() {
            return Ok(None);
        }
        if self.header_len < FRAME_HEADER {
            let count = (FRAME_HEADER - self.header_len).min(input.len());
            self.header[self.header_len..self.header_len + count].copy_from_slice(&input[..count]);
            self.header_len += count;
            *input = &input[count..];
            if self.header_len < FRAME_HEADER {
                return Ok(None);
            }
            match self.header[0] {
                0 | 2 => {}
                1 | 3 => bail!("Compressed Connect frames are not supported"),
                _ => bail!("Invalid Connect frame flags"),
            }
            self.payload_len = u32::from_be_bytes([
                self.header[1],
                self.header[2],
                self.header[3],
                self.header[4],
            ]) as usize;
            ensure!(
                self.payload_len <= MAX_PAYLOAD,
                "Incoming Connect payload exceeds 64 MiB"
            );
            self.payload = Vec::with_capacity(self.payload_len);
        }
        let count = (self.payload_len - self.payload.len()).min(input.len());
        self.payload.extend_from_slice(&input[..count]);
        *input = &input[count..];
        if self.payload.len() < self.payload_len {
            return Ok(None);
        }
        let payload = std::mem::take(&mut self.payload);
        self.header_len = 0;
        if self.header[0] == 2 {
            let end: Value = serde_json::from_slice(&payload)
                .map_err(|_| anyhow!("Invalid Connect end-stream JSON"))?;
            ensure!(end.is_object(), "Connect end-stream JSON must be an object");
            self.ended = true;
            Ok(Some(Frame::End(end)))
        } else {
            Ok(Some(Frame::Message(payload)))
        }
    }

    fn finish(&self, require_end: bool) -> Result<()> {
        if self.header_len != 0 {
            if self.header_len < FRAME_HEADER {
                bail!("Truncated Connect frame header at EOF");
            }
            bail!("Truncated Connect frame payload at EOF");
        }
        ensure!(
            !require_end || self.ended,
            "Connect stream ended without an end-stream frame"
        );
        Ok(())
    }
}

fn decode_unary(body: Vec<u8>) -> Result<Vec<u8>> {
    // Do not treat a leading 0/2 byte as proof of framing. A candidate must parse completely,
    // with exactly one message and an optional final JSON end envelope (or an error-only end).
    let mut decoder = Decoder::default();
    let mut remaining = body.as_slice();
    let mut message = None;
    let mut end = None;
    let candidate = (|| -> Result<()> {
        while !remaining.is_empty() {
            match decoder.next(&mut remaining)? {
                Some(Frame::Message(value)) if message.is_none() => message = Some(value),
                Some(Frame::End(value)) => end = Some(value),
                Some(Frame::Message(_)) => bail!("Multiple unary messages"),
                None => break,
            }
        }
        decoder.finish(false)?;
        ensure!(
            message.is_some() || end.is_some(),
            "Not a framed unary response"
        );
        Ok(())
    })();
    if candidate.is_ok() {
        if end
            .as_ref()
            .and_then(|value| value.get("error"))
            .is_some_and(|error| !error.is_null())
        {
            bail!("Cursor unary RPC returned a Connect error");
        }
        if let Some(message) = message {
            return Ok(message);
        }
    }
    ensure!(
        body.len() <= MAX_PAYLOAD,
        "Cursor unary response exceeds 64 MiB"
    );
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{ErrorKind, Write},
        net::{TcpListener, TcpStream},
        thread::{self, JoinHandle},
        time::Instant,
    };

    // Minimal h2c fixture, using only existing dependencies. It does not decode/log HPACK
    // request headers; the separate header tests cover them without exposing authorization.
    struct Wire {
        socket: TcpStream,
        stream_id: u32,
    }

    impl Wire {
        fn send(&mut self, kind: u8, flags: u8, stream_id: u32, payload: &[u8]) -> Result<()> {
            let length = (payload.len() as u32).to_be_bytes();
            self.socket.write_all(&length[1..])?;
            self.socket.write_all(&[kind, flags])?;
            self.socket.write_all(&stream_id.to_be_bytes())?;
            self.socket.write_all(payload)?;
            Ok(())
        }

        fn read(&mut self) -> std::io::Result<(u8, u8, u32, Vec<u8>)> {
            let mut header = [0; 9];
            self.socket.read_exact(&mut header)?;
            let length = u32::from_be_bytes([0, header[0], header[1], header[2]]) as usize;
            if length > 1024 * 1024 {
                return Err(std::io::Error::new(
                    ErrorKind::InvalidData,
                    "Oversized test H2 frame",
                ));
            }
            let stream_id =
                u32::from_be_bytes([header[5], header[6], header[7], header[8]]) & 0x7fff_ffff;
            let mut payload = vec![0; length];
            self.socket.read_exact(&mut payload)?;
            // Acknowledge SETTINGS and PING without interfering with application frames.
            if header[3] == 4 && header[4] & 1 == 0 {
                self.send(4, 1, 0, &[]).map_err(std::io::Error::other)?;
            } else if header[3] == 6 && header[4] & 1 == 0 {
                self.send(6, 1, 0, &payload)
                    .map_err(std::io::Error::other)?;
            }
            if header[3] == 1 {
                self.stream_id = stream_id;
            }
            Ok((header[3], header[4], stream_id, payload))
        }

        fn request_bytes(&mut self, length: usize) -> Result<Vec<u8>> {
            let mut body = Vec::new();
            while body.len() < length {
                let (kind, _, stream_id, payload) = self.read()?;
                if kind == 0 && stream_id == self.stream_id {
                    body.extend(payload);
                }
                ensure!(
                    kind != 3 && kind != 7,
                    "Fixture request was reset before upload"
                );
            }
            Ok(body)
        }

        fn headers(&mut self) -> Result<()> {
            // HPACK static-table index 8: :status 200; END_HEADERS, but not END_STREAM.
            self.send(1, 4, self.stream_id, &[0x88])
        }

        fn data(&mut self, payload: &[u8], end_stream: bool) -> Result<()> {
            self.send(0, u8::from(end_stream), self.stream_id, payload)
        }

        fn await_upload_end(&mut self) -> Result<()> {
            loop {
                let (kind, flags, stream_id, _) = self.read()?;
                if stream_id == self.stream_id && (kind == 3 || (kind == 0 && flags & 1 != 0)) {
                    return Ok(());
                }
            }
        }

        fn await_reset(&mut self) -> Result<()> {
            self.socket.set_read_timeout(Some(Duration::from_secs(1)))?;
            loop {
                match self.read() {
                    Ok((3, _, stream_id, payload)) if stream_id == self.stream_id => {
                        ensure!(
                            payload == u32::from(h2::Reason::CANCEL).to_be_bytes(),
                            "Expected wire RST_STREAM(CANCEL)"
                        );
                        return Ok(());
                    }
                    Ok(_) => {}
                    // EOF/connection teardown is not proof that the individual RPC was reset.
                    Err(error) => return Err(error.into()),
                }
            }
        }
    }

    fn fixture(
        work: impl FnOnce(&mut Wire) -> Result<()> + Send + 'static,
    ) -> Result<(String, JoinHandle<Result<()>>)> {
        fixture_with_connect(false, work)
    }

    fn fixture_with_connect(
        proxy: bool,
        work: impl FnOnce(&mut Wire) -> Result<()> + Send + 'static,
    ) -> Result<(String, JoinHandle<Result<()>>)> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let url = format!("http://{}", listener.local_addr()?);
        listener.set_nonblocking(true)?;
        let thread = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            let socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        ensure!(Instant::now() < deadline, "Fixture accept timed out");
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => return Err(error.into()),
                }
            };
            socket.set_nonblocking(false)?;
            socket.set_read_timeout(Some(Duration::from_secs(3)))?;
            socket.set_write_timeout(Some(Duration::from_secs(3)))?;
            socket.set_nodelay(true)?;
            let mut wire = Wire {
                socket,
                stream_id: 0,
            };
            if proxy {
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    ensure!(request.len() < 4096, "Oversized CONNECT request");
                    let mut byte = [0; 1];
                    wire.socket.read_exact(&mut byte)?;
                    request.push(byte[0]);
                }
                ensure!(
                    request.starts_with(b"CONNECT 127.0.0.1:9 HTTP/1.1\r\n"),
                    "Invalid CONNECT authority"
                );
                ensure!(
                    request
                        .windows(b"Proxy-Authorization: Basic Zml4dHVyZTpwQHNz\r\n".len())
                        .any(|window| window == b"Proxy-Authorization: Basic Zml4dHVyZTpwQHNz\r\n"),
                    "Missing proxy authentication"
                );
                wire.socket
                    .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")?;
            }
            let mut preface = [0; 24];
            wire.socket.read_exact(&mut preface)?;
            ensure!(
                &preface == b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
                "Missing H2 prior-knowledge preface"
            );
            wire.send(4, 0, 0, &[])?;
            work(&mut wire)
        });
        Ok((url, thread))
    }

    fn fixture_client() -> Result<Client> {
        // Do not depend on the test runner's corporate proxy/NO_PROXY configuration.
        build_client(ProxyConfig::default())
    }

    async fn joined(thread: JoinHandle<Result<()>>) -> Result<()> {
        tokio::task::spawn_blocking(move || thread.join().map_err(|_| anyhow!("Fixture panicked")))
            .await???;
        Ok(())
    }

    async fn incoming(connection: &mut Connection) -> Result<Frame> {
        with_timeout(3000, connection.incoming.recv())
            .await?
            .ok_or_else(|| anyhow!("Fixture response ended unexpectedly"))?
    }

    fn envelope(flags: u8, payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(FRAME_HEADER + payload.len());
        frame.push(flags);
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(payload);
        frame
    }

    fn collect(chunks: &[&[u8]], require_end: bool) -> Result<Vec<Frame>> {
        let mut decoder = Decoder::default();
        let mut frames = Vec::new();
        for chunk in chunks {
            let mut remaining = *chunk;
            while !remaining.is_empty() {
                if let Some(frame) = decoder.next(&mut remaining)? {
                    frames.push(frame);
                }
            }
        }
        decoder.finish(require_end)?;
        Ok(frames)
    }

    #[tokio::test]
    async fn h2c_is_truly_duplex_and_frames_raw_outgoing_messages() -> Result<()> {
        let (url, thread) = fixture(|wire| {
            let first = envelope(0, b"initial");
            ensure!(
                wire.request_bytes(first.len())? == first,
                "Initial upload was not Connect framed"
            );
            wire.headers()?;
            wire.data(&envelope(0, b"first response"), false)?;
            // The second request message is sent only after the first response is consumed.
            let second = envelope(0, b"follow-up");
            ensure!(
                wire.request_bytes(second.len())? == second,
                "Follow-up upload was not Connect framed"
            );
            wire.data(&envelope(2, b"{}"), true)?;
            // A real H2 peer retains the connection while the client half-closes its upload.
            wire.await_upload_end()
        })?;
        let client = fixture_client()?;
        let mut connection = open(
            &client,
            &url,
            "/rpc",
            "fixture-token",
            b"initial".to_vec(),
            3000,
        )
        .await?;
        assert!(
            matches!(incoming(&mut connection).await?, Frame::Message(value) if value == b"first response")
        );
        connection.outgoing.send(b"follow-up".to_vec()).await?;
        assert!(
            matches!(incoming(&mut connection).await?, Frame::End(value) if value == serde_json::json!({}))
        );
        assert!(with_timeout(1000, connection.incoming.recv())
            .await?
            .is_none());
        with_timeout(1000, connection.outgoing.closed()).await?;
        joined(thread).await
    }

    #[tokio::test]
    async fn h2c_unary_sends_raw_and_accepts_raw_or_valid_framed_response() -> Result<()> {
        for framed in [false, true] {
            let reply = vec![8, 1, 18, 2, b'o', b'k'];
            let expected = reply.clone();
            let (url, thread) = fixture(move |wire| {
                ensure!(
                    wire.request_bytes(3)? == b"raw",
                    "Unary request was not raw protobuf"
                );
                wire.headers()?;
                let body = if framed {
                    [envelope(0, &reply), envelope(2, b"{}")].concat()
                } else {
                    reply
                };
                wire.data(&body, true)
            })?;
            assert_eq!(
                unary(
                    &fixture_client()?,
                    &url,
                    "/rpc",
                    "fixture-token",
                    b"raw".to_vec(),
                    3000
                )
                .await?,
                expected
            );
            joined(thread).await?;
        }
        Ok(())
    }

    #[test]
    fn usage_request_is_one_fixed_read_only_json_endpoint() -> Result<()> {
        let client = fixture_client()?;
        let request = usage_request(&client, "fixture-token")?;
        assert_eq!(request.method(), http::Method::POST);
        assert_eq!(
            request.url().as_str(),
            format!("https://api2.cursor.sh{USAGE_PATH}")
        );
        assert_eq!(request.version(), Version::HTTP_2);
        assert_eq!(request.headers()[CONTENT_TYPE], "application/json");
        assert_eq!(request.headers()[AUTHORIZATION], "Bearer fixture-token");
        assert!(request.headers()[AUTHORIZATION].is_sensitive());
        assert!(!request.headers().contains_key(http::header::COOKIE));
        assert_eq!(
            request.body().and_then(reqwest::Body::as_bytes),
            Some(b"{}".as_slice())
        );
        assert!(usage_request(&client, "fixture\r\ntoken").is_err());
        Ok(())
    }

    // The public usage operation never accepts a URL. Only this private test helper
    // substitutes loopback after constructing the fixed request, to avoid live calls.
    fn usage_fixture_request(client: &Client, url: &str) -> Result<reqwest::Request> {
        let mut request = usage_request(client, "fixture-token")?;
        *request.url_mut() = destination_with_policy(url, USAGE_PATH, false)?;
        Ok(request)
    }

    #[tokio::test]
    async fn usage_returns_raw_period_json_without_protobuf_framing() -> Result<()> {
        let expected = serde_json::json!({
            "billingCycleEnd": "1793746800000",
            "planUsage": {"totalPercentUsed": 21.5, "includedSpend": 1200, "limit": null},
            "spendLimitUsage": {"limitType": "team"}
        });
        let reply = serde_json::to_vec(&expected)?;
        let (url, thread) = fixture(move |wire| {
            ensure!(
                wire.request_bytes(2)? == b"{}",
                "Usage request must be empty JSON"
            );
            wire.headers()?;
            wire.data(&reply, true)
        })?;
        let client = fixture_client()?;
        assert_eq!(
            execute_usage(&client, usage_fixture_request(&client, &url)?).await?,
            expected
        );
        joined(thread).await
    }

    #[tokio::test]
    async fn usage_rejects_invalid_json_redirects_and_oversize_without_echoing_body() -> Result<()>
    {
        for case in 0..4 {
            let (url, thread) = fixture(move |wire| {
                ensure!(
                    wire.request_bytes(2)? == b"{}",
                    "Usage request must be empty JSON"
                );
                match case {
                    0 => {
                        wire.headers()?;
                        wire.data(b"private-response-fixture", true)
                    }
                    1 => {
                        wire.headers()?;
                        wire.data(b"[]", true)
                    }
                    // HPACK literal :status 302. Redirects must not be followed.
                    2 => wire.send(1, 5, wire.stream_id, &[0x08, 0x03, b'3', b'0', b'2']),
                    // HPACK literal content-length 1048577 (static name index 28).
                    _ => wire.send(
                        1,
                        4,
                        wire.stream_id,
                        &[
                            0x88, 0x0f, 0x0d, 0x07, b'1', b'0', b'4', b'8', b'5', b'7', b'7',
                        ],
                    ),
                }
            })?;
            let client = fixture_client()?;
            let error = execute_usage(&client, usage_fixture_request(&client, &url)?)
                .await
                .err()
                .ok_or_else(|| anyhow!("Expected usage rejection"))?;
            let text = format!("{error:?}");
            assert!(!text.contains("private-response-fixture"));
            assert!(!text.contains("fixture-token"));
            let expected = [
                "Invalid Cursor usage JSON",
                "JSON object",
                "HTTP 302",
                "exceeds 1 MiB",
            ][case];
            assert!(
                text.contains(expected),
                "Unexpected sanitized error: {text}"
            );
            joined(thread).await?;
        }
        Ok(())
    }

    #[tokio::test]
    async fn usage_shutdown_cancels_a_pending_http2_request() -> Result<()> {
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (url, thread) = fixture(move |wire| {
            ensure!(
                wire.request_bytes(2)? == b"{}",
                "Usage request must be empty JSON"
            );
            let _ = ready_tx.send(());
            wire.await_reset()
        })?;
        let client = fixture_client()?;
        let request = usage_fixture_request(&client, &url)?;
        let work = execute_usage(&client, request);
        tokio::pin!(work);
        tokio::select! {
            result = &mut work => bail!("Usage unexpectedly completed: {result:?}"),
            result = ready_rx => result?,
        }
        client.shutdown();
        let result = with_timeout(1000, work).await?;
        assert!(result.is_err());
        joined(thread).await
    }

    #[tokio::test]
    async fn cancellation_drops_request_while_waiting_for_headers() -> Result<()> {
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (url, thread) = fixture(move |wire| {
            // Exhaust both default H2 request windows, without ever sending response headers
            // or WINDOW_UPDATE. Reset must not depend on either headers or upload capacity.
            ensure!(
                wire.request_bytes(65_535)?.len() == 65_535,
                "Expected zero request window"
            );
            let _ = ready_tx.send(());
            wire.await_reset()
        })?;
        let client = fixture_client()?;
        let mut connection = open(
            &client,
            &url,
            "/rpc",
            "fixture-token",
            vec![0; 1024 * 1024],
            0,
        )
        .await?;
        with_timeout(3000, ready_rx).await??;
        connection.cancel.cancel();
        assert!(with_timeout(1000, connection.incoming.recv())
            .await?
            .is_none());
        with_timeout(1000, connection.outgoing.closed()).await?;
        joined(thread).await
    }

    #[tokio::test]
    async fn cancellation_interrupts_full_incoming_queue() -> Result<()> {
        let (url, thread) = fixture(|wire| {
            wire.request_bytes(FRAME_HEADER)?;
            wire.headers()?;
            let messages = envelope(0, b"message").repeat(QUEUE_CAPACITY + 2);
            wire.data(&messages, false)?;
            wire.await_reset()
        })?;
        let client = fixture_client()?;
        let mut connection = open(&client, &url, "/rpc", "fixture-token", Vec::new(), 0).await?;
        with_timeout(3000, async {
            while connection.incoming.len() < QUEUE_CAPACITY {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        connection.cancel.cancel();
        with_timeout(1000, async {
            while !connection.incoming.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        with_timeout(1000, connection.outgoing.closed()).await?;
        while let Some(frame) = connection.incoming.recv().await {
            assert!(matches!(frame?, Frame::Message(_)));
        }
        joined(thread).await
    }

    #[tokio::test]
    async fn cancellation_unblocks_a_full_outgoing_queue() -> Result<()> {
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (url, thread) = fixture(move |wire| {
            ensure!(
                wire.request_bytes(65_535)?.len() == 65_535,
                "Expected zero request window"
            );
            wire.headers()?;
            let _ = ready_tx.send(());
            // Never restore either window: only an actual RST_STREAM(CANCEL), not socket
            // closure or a local closed channel, passes this regression.
            wire.await_reset()
        })?;
        let client = fixture_client()?;
        let mut connection = open(
            &client,
            &url,
            "/rpc",
            "fixture-token",
            vec![0; 1024 * 1024],
            0,
        )
        .await?;
        with_timeout(3000, ready_rx).await??;
        for _ in 0..QUEUE_CAPACITY {
            connection.outgoing.try_send(vec![1])?;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
        while connection.outgoing.try_send(vec![1]).is_ok() {}
        let blocked_send = connection.outgoing.send(vec![2]);
        tokio::pin!(blocked_send);
        assert!(futures_util::poll!(&mut blocked_send).is_pending());
        connection.cancel.cancel();
        assert!(with_timeout(1000, &mut blocked_send).await?.is_err());
        assert!(with_timeout(1000, connection.incoming.recv())
            .await?
            .is_none());
        joined(thread).await
    }

    #[tokio::test]
    async fn header_timeout_drops_the_request() -> Result<()> {
        let (url, thread) = fixture(|wire| {
            wire.request_bytes(FRAME_HEADER)?;
            wire.await_reset()
        })?;
        let client = fixture_client()?;
        let mut connection = open(&client, &url, "/rpc", "fixture-token", Vec::new(), 200).await?;
        let error = incoming(&mut connection)
            .await
            .err()
            .ok_or_else(|| anyhow!("Expected header timeout"))?;
        assert!(error.to_string().contains("timed out"));
        with_timeout(1000, connection.outgoing.closed()).await?;
        joined(thread).await
    }

    #[tokio::test]
    async fn completed_streams_reuse_one_pooled_connection() -> Result<()> {
        // This fixture accepts exactly one TCP connection; a reconnect cannot satisfy turn 2.
        let (url, thread) = fixture(|wire| {
            let mut previous = 0;
            for _ in 0..3 {
                ensure!(
                    wire.request_bytes(FRAME_HEADER)? == envelope(0, b""),
                    "Invalid upload"
                );
                ensure!(
                    wire.stream_id > previous,
                    "Expected a new RPC stream on the same connection"
                );
                previous = wire.stream_id;
                wire.headers()?;
                wire.data(&envelope(2, b"{}"), true)?;
                wire.await_upload_end()?;
            }
            Ok(())
        })?;
        let client = fixture_client()?;
        for _ in 0..3 {
            let mut connection =
                open(&client, &url, "/rpc", "fixture-token", Vec::new(), 1000).await?;
            assert!(matches!(incoming(&mut connection).await?, Frame::End(_)));
            assert!(with_timeout(1000, connection.incoming.recv())
                .await?
                .is_none());
            with_timeout(1000, connection.outgoing.closed()).await?;
        }
        joined(thread).await
    }

    async fn h2_request_message(body: &mut h2::RecvStream, expected: &[u8]) -> Result<()> {
        let expected = envelope(0, expected);
        let mut actual = Vec::new();
        while actual.len() < expected.len() {
            let chunk = body
                .data()
                .await
                .ok_or_else(|| anyhow!("Missing request DATA"))??;
            body.flow_control().release_capacity(chunk.len())?;
            actual.extend_from_slice(&chunk);
        }
        ensure!(actual == expected, "Invalid request protobuf framing");
        Ok(())
    }

    #[tokio::test]
    async fn cancelling_one_pooled_stream_preserves_the_other_scope_and_headers() -> Result<()> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let (requests_tx, mut requests_rx) = mpsc::channel(2);
        let stop = CancellationToken::new();
        let driver_stop = stop.clone();
        let driver = tokio::spawn(async move {
            // Accept exactly once. Both independent scopes must multiplex this connection.
            let (socket, _) = listener.accept().await?;
            let mut connection = h2::server::handshake(socket).await?;
            loop {
                tokio::select! {
                    _ = driver_stop.cancelled() => return Ok::<(), anyhow::Error>(()),
                    request = connection.accept() => match request {
                        Some(request) => requests_tx.send(request?).await?,
                        None => return Ok(()),
                    },
                }
            }
        });
        let peer = tokio::spawn(async move {
            let (first, mut first_response) = requests_rx
                .recv()
                .await
                .ok_or_else(|| anyhow!("Missing first RPC"))?;
            ensure!(
                first.headers()[AUTHORIZATION] == "Bearer fixture-one",
                "Wrong first scope authorization"
            );
            let first_id = first.headers()["x-request-id"].clone();
            let mut first_body = first.into_body();
            h2_request_message(&mut first_body, b"one").await?;
            let mut first_send = first_response.send_response(http::Response::new(()), false)?;
            first_send.send_data(Bytes::from(envelope(0, b"one response")), false)?;

            let (second, mut second_response) = requests_rx
                .recv()
                .await
                .ok_or_else(|| anyhow!("Missing second RPC"))?;
            ensure!(
                second.headers()[AUTHORIZATION] == "Bearer fixture-two",
                "Authorization leaked across pooled scopes"
            );
            ensure!(
                second.headers()["x-request-id"] != first_id,
                "Request ID reused across streams"
            );
            let mut second_body = second.into_body();
            h2_request_message(&mut second_body, b"two").await?;
            let mut second_send = second_response.send_response(http::Response::new(()), false)?;
            second_send.send_data(Bytes::from(envelope(0, b"two response")), false)?;
            ensure!(
                poll_fn(|cx| first_send.poll_reset(cx)).await? == h2::Reason::CANCEL,
                "Missing per-stream CANCEL"
            );
            h2_request_message(&mut second_body, b"still alive").await?;
            second_send.send_data(Bytes::from(envelope(2, b"{}")), true)?;
            while let Some(chunk) = second_body.data().await {
                ensure!(
                    chunk?.is_empty(),
                    "Unexpected DATA after second upload completed"
                );
            }
            Ok::<(), anyhow::Error>(())
        });
        let client = fixture_client()?;
        let mut first = open(&client, &url, "/one", "fixture-one", b"one".to_vec(), 1000).await?;
        assert!(matches!(incoming(&mut first).await?, Frame::Message(_)));
        let mut second = open(&client, &url, "/two", "fixture-two", b"two".to_vec(), 1000).await?;
        assert!(matches!(incoming(&mut second).await?, Frame::Message(_)));
        first.cancel.cancel();
        with_timeout(1000, first.outgoing.closed()).await?;
        assert!(with_timeout(1000, first.incoming.recv()).await?.is_none());
        second.outgoing.send(b"still alive".to_vec()).await?;
        assert!(matches!(incoming(&mut second).await?, Frame::End(_)));
        with_timeout(3000, peer).await???;
        stop.cancel();
        with_timeout(1000, driver).await???;
        Ok(())
    }

    #[tokio::test]
    async fn zero_window_reset_keeps_the_other_pooled_stream_alive() -> Result<()> {
        let (reset_tx, reset_rx) = tokio::sync::oneshot::channel();
        let (url, thread) = fixture(move |wire| {
            ensure!(
                wire.request_bytes(65_535)?.len() == 65_535,
                "Expected zero request window"
            );
            let first = wire.stream_id;
            // Replenish ONLY the connection window so a different RPC can send. The first
            // stream's window remains exactly zero for the rest of its lifetime.
            wire.send(8, 0, 0, &65_535_u32.to_be_bytes())?;
            wire.headers()?;
            wire.data(&envelope(0, b"first"), false)?;
            ensure!(
                wire.request_bytes(FRAME_HEADER)? == envelope(0, b""),
                "Invalid second upload"
            );
            let second = wire.stream_id;
            ensure!(second != first, "RPC streams were not independent");
            wire.headers()?;
            wire.data(&envelope(0, b"second"), false)?;
            wire.stream_id = first;
            wire.await_reset()?;
            let _ = reset_tx.send(());
            wire.stream_id = second;
            ensure!(
                wire.request_bytes(envelope(0, b"survived").len())? == envelope(0, b"survived"),
                "Other pooled stream was interrupted"
            );
            wire.data(&envelope(2, b"{}"), true)?;
            wire.await_upload_end()
        })?;
        let client = fixture_client()?;
        let mut first = open(
            &client,
            &url,
            "/one",
            "fixture-one",
            vec![0; 1024 * 1024],
            1000,
        )
        .await?;
        assert!(matches!(incoming(&mut first).await?, Frame::Message(_)));
        let mut second = open(&client, &url, "/two", "fixture-two", Vec::new(), 1000).await?;
        assert!(matches!(incoming(&mut second).await?, Frame::Message(_)));
        first.cancel.cancel();
        with_timeout(1000, first.outgoing.closed()).await?;
        assert!(with_timeout(1000, first.incoming.recv()).await?.is_none());
        with_timeout(1000, reset_rx).await??;
        second.outgoing.send(b"survived".to_vec()).await?;
        assert!(matches!(incoming(&mut second).await?, Frame::End(_)));
        with_timeout(1000, second.outgoing.closed()).await?;
        joined(thread).await
    }

    #[tokio::test]
    async fn shutdown_and_last_client_drop_cancel_owned_drivers() -> Result<()> {
        for explicit in [false, true] {
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let (url, thread) = fixture(move |wire| {
                wire.request_bytes(FRAME_HEADER)?;
                let _ = ready_tx.send(());
                // Shutdown must close the whole owned socket, not merely forget the pool.
                loop {
                    match wire.read() {
                        Ok(_) => {}
                        Err(error)
                            if matches!(
                                error.kind(),
                                ErrorKind::UnexpectedEof | ErrorKind::ConnectionReset
                            ) =>
                        {
                            return Ok(())
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
            })?;
            let client = fixture_client()?;
            let mut connection =
                open(&client, &url, "/rpc", "fixture-token", Vec::new(), 0).await?;
            with_timeout(3000, ready_rx).await??;
            let clone = client.clone();
            drop(client);
            // A live clone still owns this connection.
            assert!(!connection.incoming.is_closed());
            let retained = if explicit {
                clone.shutdown();
                assert!(open(&clone, &url, "/rpc", "fixture-token", Vec::new(), 0)
                    .await
                    .is_err());
                clone.shutdown(); // idempotent
                Some(clone)
            } else {
                drop(clone);
                None
            };
            assert!(with_timeout(1000, connection.incoming.recv())
                .await?
                .is_none());
            with_timeout(1000, connection.outgoing.closed()).await?;
            joined(thread).await?;
            drop(retained);
        }
        Ok(())
    }

    #[tokio::test]
    async fn dropping_incoming_resets_a_flow_controlled_stream() -> Result<()> {
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (url, thread) = fixture(move |wire| {
            ensure!(
                wire.request_bytes(65_535)?.len() == 65_535,
                "Expected zero request window"
            );
            let _ = ready_tx.send(());
            wire.await_reset()
        })?;
        let client = fixture_client()?;
        let connection = open(
            &client,
            &url,
            "/rpc",
            "fixture-token",
            vec![0; 1024 * 1024],
            0,
        )
        .await?;
        with_timeout(3000, ready_rx).await??;
        drop(connection.incoming);
        with_timeout(1000, connection.outgoing.closed()).await?;
        joined(thread).await
    }

    #[tokio::test]
    async fn streaming_uses_authenticated_http_connect_proxy() -> Result<()> {
        let (proxy_url, thread) = fixture_with_connect(true, |wire| {
            ensure!(
                wire.request_bytes(FRAME_HEADER)? == envelope(0, b""),
                "Invalid proxied upload"
            );
            wire.headers()?;
            wire.data(&envelope(2, b"{}"), true)?;
            wire.await_upload_end()
        })?;
        let proxy_url = proxy_url.replacen("http://", "http://fixture:p%40ss@", 1);
        let client = build_client(ProxyConfig::parse(Some(&proxy_url), None, "")?)?;
        let mut connection = open(
            &client,
            "http://127.0.0.1:9",
            "/rpc",
            "fixture-token",
            Vec::new(),
            1000,
        )
        .await?;
        assert!(matches!(incoming(&mut connection).await?, Frame::End(_)));
        with_timeout(1000, connection.outgoing.closed()).await?;
        joined(thread).await
    }

    #[tokio::test]
    async fn no_proxy_bypasses_a_configured_proxy_for_loopback() -> Result<()> {
        let (url, thread) = fixture(|wire| {
            wire.request_bytes(FRAME_HEADER)?;
            wire.headers()?;
            wire.data(&envelope(2, b"{}"), true)?;
            wire.await_upload_end()
        })?;
        let client = build_client(ProxyConfig::parse(
            Some("http://127.0.0.1:9"),
            None,
            "127.0.0.0/8",
        )?)?;
        let mut connection = open(&client, &url, "/rpc", "fixture-token", Vec::new(), 1000).await?;
        assert!(matches!(incoming(&mut connection).await?, Frame::End(_)));
        with_timeout(1000, connection.outgoing.closed()).await?;
        joined(thread).await
    }

    #[test]
    fn proxy_validation_and_no_proxy_matching_are_explicit_and_redacted() -> Result<()> {
        for proxy in [
            "socks5://localhost:9",
            "ftp://localhost:9",
            "http:localhost",
            "http://localhost:0",
            "http://localhost/path",
            "http://localhost?private",
            "http://private:secret%0a@localhost",
            " http://localhost",
        ] {
            let error = Proxy::parse(proxy)
                .err()
                .ok_or_else(|| anyhow!("Accepted invalid proxy"))?;
            assert!(!format!("{error:?}").contains("private"));
            assert!(!format!("{error:?}").contains("secret"));
        }
        let config = ProxyConfig::parse(
            Some("http://localhost:9"),
            Some("https://localhost:9"),
            ".cursor.sh:443,127.0.0.0/8,[::1],10.2.3.4:8080",
        )?;
        for endpoint in [
            "https://api2.cursor.sh",
            "https://cursor.sh",
            "http://127.5.6.7:1234",
            "http://[::1]:1234",
            "http://10.2.3.4:8080",
        ] {
            assert!(config.proxy_for(&Url::parse(endpoint)?).is_none());
        }
        for endpoint in [
            "https://notcursor.sh",
            "https://cursor.sh.evil.example",
            "https://cursor.sh:444",
            "http://cursor.sh",
            "http://10.2.3.4:8081",
            "http://192.168.0.1",
        ] {
            assert!(config.proxy_for(&Url::parse(endpoint)?).is_some());
        }
        for invalid in ["*:443", "10.0.0.0/33", "[::1]:no", "host:0", "host/private"] {
            assert!(ProxyConfig::parse(None, None, invalid).is_err());
        }
        assert!(ProxyConfig::parse(Some("http://localhost:9"), None, "*")?
            .proxy_for(&Url::parse("http://127.0.0.1")?)
            .is_none());
        Ok(())
    }

    #[tokio::test]
    async fn streaming_rejects_redirect_status_without_following_it() -> Result<()> {
        let (url, thread) = fixture(|wire| {
            wire.request_bytes(FRAME_HEADER)?;
            // HPACK literal :status = 302. No redirect or HTTP/1 fallback is permitted.
            wire.send(1, 4, wire.stream_id, &[0x08, 3, b'3', b'0', b'2'])?;
            wire.await_reset()
        })?;
        let client = fixture_client()?;
        let mut connection = open(&client, &url, "/rpc", "fixture-token", Vec::new(), 1000).await?;
        let error = incoming(&mut connection)
            .await
            .err()
            .ok_or_else(|| anyhow!("Expected status failure"))?;
        assert!(error.to_string().contains("HTTP 302"));
        joined(thread).await
    }

    #[test]
    fn client_instances_do_not_share_pools_and_offer_h2_only_alpn() -> Result<()> {
        let first = fixture_client()?;
        let clone = first.clone();
        let second = fixture_client()?;
        assert!(Arc::ptr_eq(&first.inner.pool, &clone.inner.pool));
        assert!(!Arc::ptr_eq(&first.inner.pool, &second.inner.pool));
        assert_eq!(first.inner.pool.tls.alpn_protocols, vec![b"h2".to_vec()]);
        first.shutdown();
        assert!(clone.inner.pool.shutdown.is_cancelled());
        assert!(!second.inner.pool.shutdown.is_cancelled());
        Ok(())
    }

    #[test]
    fn parser_handles_every_split_and_bytewise_fragmentation() -> Result<()> {
        let mut wire = envelope(0, b"protobuf");
        wire.extend(envelope(0, b""));
        wire.extend(envelope(2, br#"{"metadata":{"key":["value"]}}"#));
        for split in 0..=wire.len() {
            let frames = collect(&[&wire[..split], &wire[split..]], true)?;
            assert_eq!(frames.len(), 3);
            assert!(matches!(&frames[0], Frame::Message(value) if value == b"protobuf"));
            assert!(matches!(&frames[1], Frame::Message(value) if value.is_empty()));
            assert!(
                matches!(&frames[2], Frame::End(value) if value["metadata"]["key"][0] == "value")
            );
        }
        let bytewise: Vec<_> = wire.chunks(1).collect();
        assert_eq!(collect(&bytewise, true)?.len(), 3);
        Ok(())
    }

    #[test]
    fn parser_rejects_every_truncated_prefix() {
        let mut wire = envelope(0, b"protobuf");
        wire.extend(envelope(2, b"{}"));
        for length in 0..wire.len() {
            assert!(collect(&[&wire[..length]], true).is_err());
        }
    }

    #[test]
    fn parser_rejects_flags_oversize_and_trailing_data() {
        for flags in 1..=255 {
            if flags != 2 {
                assert!(collect(&[&envelope(flags, b"{}")], false).is_err());
            }
        }
        let length = (MAX_PAYLOAD + 1) as u32;
        let mut oversized = vec![0];
        oversized.extend(length.to_be_bytes());
        assert!(collect(&[&oversized], false).is_err());
        let mut wire = envelope(2, b"{}");
        wire.extend(envelope(0, b"later"));
        assert!(collect(&[&wire], true).is_err());
        assert!(collect(&[&envelope(2, b"{}"), b"x"], true).is_err());
        assert!(collect(&[&envelope(2, b"{}"), &envelope(2, b"{}")], true).is_err());
    }

    #[test]
    fn parser_errors_never_echo_end_payload() {
        for payload in [
            b"server-private-data".as_slice(),
            b"[]",
            br#""private""#,
            b"null",
            b"",
        ] {
            let error = collect(&[&envelope(2, payload)], true).err();
            assert!(error.is_some());
            if let Some(error) = error {
                assert!(!format!("{error:?}").contains("private"));
            }
        }
    }

    #[test]
    fn message_encoding_is_uncompressed_and_big_endian() -> Result<()> {
        let encoded = encode_message(b"abc".to_vec())?;
        assert_eq!(encoded.as_ref(), &[0, 0, 0, 0, 3, b'a', b'b', b'c']);
        assert_eq!(encode_message(Vec::new())?.as_ref(), &[0; 5]);
        Ok(())
    }

    #[test]
    fn unary_only_unwraps_complete_valid_single_message_framing() -> Result<()> {
        let raw_cases = [
            vec![],
            vec![8, 1, 18, 3, b'a', b'b', b'c'],
            vec![0, 0, 0, 0, 99, 1],
            vec![0, 0, 0, 0, 0, 99],
            envelope(1, b"compressed"),
            envelope(2, b"not json"),
            [envelope(0, b"one"), envelope(0, b"two")].concat(),
            [envelope(0, b"one"), envelope(2, b"{}"), vec![0]].concat(),
        ];
        for body in raw_cases {
            assert_eq!(decode_unary(body.clone())?, body);
        }
        assert_eq!(decode_unary(envelope(0, b"reply"))?, b"reply");
        assert_eq!(
            decode_unary([envelope(0, b"reply"), envelope(2, b"{}")].concat())?,
            b"reply"
        );
        assert!(decode_unary(envelope(0, b"")).is_ok_and(|body| body.is_empty()));
        let error = decode_unary(envelope(2, br#"{"error":{"message":"private-token"}}"#));
        assert!(error.is_err());
        if let Err(error) = error {
            assert!(!format!("{error:?}").contains("private-token"));
        }
        Ok(())
    }

    #[test]
    fn destination_accepts_cursor_and_only_real_loopback_http() -> Result<()> {
        for base in [
            "https://api2.cursor.sh",
            "https://agentn.us.api5.cursor.sh",
            "https://cursor.com",
            "https://api.cursor.com",
            "https://cursor.sh",
            "https://API2.CURSOR.SH:443/ignored",
            "http://localhost:8123",
            "http://127.0.0.1:8123",
            "http://127.5.6.7:8123",
            "http://[::1]:8123",
        ] {
            let url = destination_with_policy(base, "/agent.v1.AgentService/Run", false)?;
            assert_eq!(url.path(), "/agent.v1.AgentService/Run");
        }
        Ok(())
    }

    #[test]
    fn destination_rejects_exfiltration_and_url_normalization_tricks() {
        for base in [
            "https://evil.example",
            "https://notcursor.sh",
            "https://cursor.sh.evil.example",
            "https://cursor.com.evil.example",
            "http://api2.cursor.sh",
            "http://192.168.0.1",
            "http://localhost.evil.example",
            "http://[::ffff:127.0.0.1]",
            "file:///tmp/cursor",
            "https://user:private-token@api2.cursor.sh",
            "https://@api2.cursor.sh",
            "https://api2.cursor.sh?",
            "https://api2.cursor.sh/#",
            "https://api2.cursor.sh?token=secret",
            " https://api2.cursor.sh",
            "https://api2.cur\rsor.sh",
            "https:\\api2.cursor.sh",
            "https://api2.cursor.sh/\\evil.example",
            "not a URL private-token",
        ] {
            let result = destination_with_policy(base, "/rpc", false);
            assert!(result.is_err(), "unexpectedly accepted test URL");
            if let Err(error) = result {
                assert!(!format!("{error:?}").contains("private-token"));
                assert!(!format!("{error:?}").contains("secret"));
            }
        }
        assert!(destination_with_policy("https://custom.example", "/rpc", true).is_ok());
        assert!(destination_with_policy("http://custom.example", "/rpc", true).is_err());
        assert!(destination_with_policy("https://user@custom.example", "/rpc", true).is_err());
        for path in [
            "rpc",
            "//evil.example/rpc",
            "/rpc?secret",
            "/rpc#secret",
            "/\\evil",
            "/r\npc",
        ] {
            assert!(destination_with_policy("https://api2.cursor.sh", path, true).is_err());
        }
    }

    #[test]
    fn request_headers_match_cursor_and_mark_authorization_sensitive() -> Result<()> {
        for unary in [false, true] {
            let headers = request_headers("fixture-token", unary)?;
            assert!(headers[AUTHORIZATION].is_sensitive());
            assert_eq!(
                headers[CONTENT_TYPE],
                if unary {
                    "application/proto"
                } else {
                    "application/connect+proto"
                }
            );
            assert_eq!(headers["connect-protocol-version"], "1");
            assert_eq!(headers[TE], "trailers");
            assert_eq!(headers["x-ghost-mode"], "true");
            assert_eq!(headers["x-cursor-client-type"], "cli");
            assert!(uuid::Uuid::parse_str(headers["x-request-id"].to_str()?).is_ok());
        }
        assert!(request_headers("private\r\ntoken", false).is_err());
        Ok(())
    }

    #[test]
    fn extra_ca_accepts_public_roots_but_rejects_mixed_identities() -> Result<()> {
        let certificate = rustls_native_certs::load_native_certs()
            .certs
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("Missing native test root"))?;
        let pem = format!(
            "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
            base64::engine::general_purpose::STANDARD.encode(certificate.as_ref())
        );
        assert_eq!(public_ca_certificates(pem.as_bytes())?.len(), 1);
        let mixed =
            format!("{pem}-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----\n");
        assert!(public_ca_certificates(mixed.as_bytes()).is_err());
        Ok(())
    }

    #[test]
    fn extra_ca_bundle_rejects_private_material_and_empty_files() {
        for pem in [
            b"".as_slice(),
            b"-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----",
            b"not certificates",
            b"-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----",
            b"-----BEGIN CERTIFICATE-----\ntruncated",
            b"-----END CERTIFICATE-----",
        ] {
            let result = public_ca_certificates(pem);
            assert!(result.is_err());
            if let Err(error) = result {
                assert!(!format!("{error:?}").contains("-----BEGIN"));
            }
        }
    }
}
