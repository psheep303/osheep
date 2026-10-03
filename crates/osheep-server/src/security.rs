use crate::error::ApiError;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderMap},
    middleware::Next,
    response::Response,
};
use std::collections::HashSet;
use std::sync::Arc;
use thiserror::Error;
use url::Url;
use uuid::Uuid;

const SESSION_COOKIE: &str = "osheep_session";

#[derive(Debug, Error)]
pub enum SecurityError {
    #[error("CORS_ORIGIN cannot be '*'; configure explicit trusted origins")]
    WildcardOrigin,
    #[error("Invalid CORS_ORIGIN value: {0}")]
    InvalidOrigin(String),
    #[error("OSHEEP_AUTH_TOKEN is required when OSHEEP_HOST is not loopback")]
    MissingRemoteToken,
    #[error("OSHEEP_AUTH_TOKEN must contain at least 32 characters for remote access")]
    ShortRemoteToken,
    #[error("CORS_ORIGIN must list trusted origins when OSHEEP_HOST is not loopback")]
    MissingRemoteOrigin,
}

#[derive(Debug)]
pub struct Security {
    remote_access: bool,
    origins: HashSet<String>,
    session_token: String,
}

impl Security {
    pub fn new(
        host: &str,
        origins: &[String],
        auth_token: Option<String>,
    ) -> Result<Self, SecurityError> {
        let remote_access = !is_loopback_host(host);
        let mut normalized_origins = HashSet::new();
        for value in origins {
            if value == "*" {
                return Err(SecurityError::WildcardOrigin);
            }
            let normalized = normalized_origin(value)
                .ok_or_else(|| SecurityError::InvalidOrigin(value.clone()))?;
            normalized_origins.insert(normalized);
        }
        if remote_access && auth_token.is_none() {
            return Err(SecurityError::MissingRemoteToken);
        }
        if remote_access && auth_token.as_ref().map_or(0, String::len) < 32 {
            return Err(SecurityError::ShortRemoteToken);
        }
        if remote_access && normalized_origins.is_empty() {
            return Err(SecurityError::MissingRemoteOrigin);
        }
        let session_token = auth_token
            .unwrap_or_else(|| format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()));
        Ok(Self {
            remote_access,
            origins: normalized_origins,
            session_token,
        })
    }

    pub fn is_trusted_origin(&self, origin: &str) -> bool {
        let Some(normalized) = normalized_origin(origin) else {
            return false;
        };
        (!self.remote_access && is_loopback_origin(&normalized))
            || self.origins.contains(&normalized)
    }

    pub fn has_trusted_request_origin(&self, headers: &HeaderMap) -> bool {
        if let Some(origin) = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
        {
            return self.is_trusted_origin(origin);
        }
        headers
            .get("sec-fetch-site")
            .and_then(|value| value.to_str().ok())
            != Some("cross-site")
    }

    pub fn has_session(&self, headers: &HeaderMap) -> bool {
        cookie_value(headers, SESSION_COOKIE)
            .is_some_and(|value| secrets_equal(value, &self.session_token))
    }

    pub fn has_bearer(&self, headers: &HeaderMap) -> bool {
        headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(bearer_token)
            .is_some_and(|value| secrets_equal(value, &self.session_token))
    }

    pub fn session_cookie(&self, secure: bool) -> String {
        let secure = if secure { "; Secure" } else { "" };
        format!(
            "{SESSION_COOKIE}={}; Path=/; HttpOnly; SameSite=Strict{secure}",
            self.session_token
        )
    }

    pub fn remote_access(&self) -> bool {
        self.remote_access
    }
}

pub async fn require_origin(
    State(security): State<Arc<Security>>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, ApiError> {
    if !security.has_trusted_request_origin(request.headers()) {
        return Err(ApiError::origin_not_allowed());
    }
    Ok(next.run(request).await)
}

pub async fn require_session(
    State(security): State<Arc<Security>>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, ApiError> {
    if !security.has_session(request.headers()) {
        return Err(ApiError::auth_required("需要有效的本地 Osheep 会话"));
    }
    Ok(next.run(request).await)
}

fn is_loopback_host(host: &str) -> bool {
    let normalized = host.trim().to_ascii_lowercase();
    normalized == "localhost"
        || normalized == "::1"
        || normalized == "[::1]"
        || normalized.starts_with("127.")
}

fn normalized_origin(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.origin().ascii_serialization())
}

fn is_loopback_origin(origin: &str) -> bool {
    Url::parse(origin)
        .ok()
        .and_then(|url| url.host_str().map(is_loopback_host))
        .unwrap_or(false)
}

fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let header = headers.get(header::COOKIE)?.to_str().ok()?;
    header.split(';').find_map(|item| {
        let (key, value) = item.split_once('=')?;
        (key.trim() == name).then(|| value.trim())
    })
}

fn bearer_token(header: &str) -> Option<&str> {
    let (scheme, token) = header.trim().split_once(char::is_whitespace)?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

fn secrets_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_security_accepts_loopback_origins_only() {
        let security = Security::new("127.0.0.1", &[], None).unwrap();
        assert!(security.is_trusted_origin("http://localhost:5173"));
        assert!(security.is_trusted_origin("http://127.0.0.1:4178"));
        assert!(!security.is_trusted_origin("https://example.com"));
    }

    #[test]
    fn remote_security_requires_token_and_origins() {
        assert!(matches!(
            Security::new("0.0.0.0", &[], None),
            Err(SecurityError::MissingRemoteToken)
        ));
    }
}
