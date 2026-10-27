//! TLS for Postgres on rustls with ring, the stack ureq already brings, following libpq's
//! `sslmode`: `require` encrypts without checking the certificate (Neon, Supabase, RDS work out
//! of the box), `verify-ca` / `verify-full` check it against the web's roots.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_postgres::tls::{ChannelBinding, MakeTlsConnect, TlsConnect};
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use tokio_rustls::rustls::crypto::{CryptoProvider, ring, verify_tls12_signature, verify_tls13_signature};
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Disable,
    Prefer,
    Require,
    Verify,
}

/// The parameters tokio-postgres understands; others (Prisma's `schema`, libpq's cert paths)
/// would make it refuse the URL.
const KNOWN: &[&str] = &[
    "user", "password", "dbname", "options", "application_name", "host", "hostaddr", "port", "connect_timeout",
    "tcp_user_timeout", "keepalives", "keepalives_idle", "keepalives_interval", "keepalives_retries",
    "target_session_attrs", "channel_binding", "load_balance_hosts",
];

/// Take `sslmode` out of the URL (and anything tokio-postgres would reject) and say which mode it asked for.
pub fn take_sslmode(url: &str) -> (String, Mode) {
    let Some((base, query)) = url.split_once('?') else { return (url.to_string(), Mode::Prefer) };
    let mut mode = Mode::Prefer;
    let kept: Vec<&str> = query
        .split('&')
        .filter(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            if k == "sslmode" {
                mode = match v {
                    "disable" => Mode::Disable,
                    "allow" | "prefer" => Mode::Prefer,
                    "verify-ca" | "verify-full" => Mode::Verify,
                    _ => Mode::Require,
                };
            }
            KNOWN.contains(&k)
        })
        .collect();
    let url = if kept.is_empty() { base.to_string() } else { format!("{base}?{}", kept.join("&")) };
    (url, mode)
}

#[derive(Clone)]
pub struct Tls {
    config: Arc<ClientConfig>,
    /// The name to verify instead of the address dialled (the real server behind a tunnel).
    sni: Option<String>,
}

impl Tls {
    pub fn new(mode: Mode, sni: Option<String>) -> Tls {
        let provider = Arc::new(ring::default_provider());
        let builder = ClientConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions().expect("ring supports the default versions");
        let config = if mode == Mode::Verify {
            let roots = RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
            builder.with_root_certificates(roots).with_no_client_auth()
        } else {
            builder.dangerous().with_custom_certificate_verifier(Arc::new(AnyCert(provider))).with_no_client_auth()
        };
        Tls { config: Arc::new(config), sni }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> MakeTlsConnect<S> for Tls {
    type Stream = Stream<S>;
    type TlsConnect = Connect;
    type Error = io::Error;

    fn make_tls_connect(&mut self, domain: &str) -> io::Result<Connect> {
        let name = self.sni.clone().unwrap_or_else(|| domain.to_string());
        let name = ServerName::try_from(name).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        Ok(Connect { config: self.config.clone(), name })
    }
}

pub struct Connect {
    config: Arc<ClientConfig>,
    name: ServerName<'static>,
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> TlsConnect<S> for Connect {
    type Stream = Stream<S>;
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = io::Result<Stream<S>>> + Send>>;

    fn connect(self, stream: S) -> Self::Future {
        Box::pin(async move { Ok(Stream(TlsConnector::from(self.config).connect(self.name, stream).await?)) })
    }
}

pub struct Stream<S>(tokio_rustls::client::TlsStream<S>);

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for Stream<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for Stream<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> tokio_postgres::tls::TlsStream for Stream<S> {
    fn channel_binding(&self) -> ChannelBinding {
        ChannelBinding::none()
    }
}

/// `sslmode=require`: encrypt, but take any certificate (libpq does the same).
#[derive(Debug)]
struct AnyCert(Arc<CryptoProvider>);

impl ServerCertVerifier for AnyCert {
    fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, tokio_rustls::rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sslmode_is_taken_out() {
        assert_eq!(take_sslmode("postgres://h/db"), ("postgres://h/db".into(), Mode::Prefer));
        assert_eq!(take_sslmode("postgres://h/db?sslmode=require&schema=x&application_name=a"), ("postgres://h/db?application_name=a".into(), Mode::Require));
        assert_eq!(take_sslmode("postgres://h/db?sslmode=verify-full").1, Mode::Verify);
        assert_eq!(take_sslmode("postgres://h/db?sslmode=disable").1, Mode::Disable);
    }
}
