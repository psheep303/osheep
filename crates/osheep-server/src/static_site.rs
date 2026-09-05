use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::Response,
};
use percent_encoding::percent_decode_str;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

pub async fn serve(root: Option<&Path>, uri: &Uri, headers: &HeaderMap) -> Response {
    let path = uri.path();
    if path == "/api" || path.starts_with("/api/") {
        return json_not_found();
    }
    let Some(root) = root else {
        return text_response(StatusCode::NOT_FOUND, "Not found");
    };
    let Ok(decoded) = percent_decode_str(path).decode_utf8() else {
        return text_response(StatusCode::BAD_REQUEST, "Invalid URL path");
    };
    let relative = Path::new(decoded.trim_start_matches('/'));
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return text_response(StatusCode::NOT_FOUND, "Not found");
    }
    let candidate = root.join(relative);
    if let Some(response) = serve_file(root, &candidate, path, headers).await {
        return response;
    }
    if relative.extension().is_none() {
        if let Some(response) = serve_file(root, &root.join("index.html"), "/", headers).await {
            return response;
        }
    }
    text_response(StatusCode::NOT_FOUND, "Not found")
}

async fn serve_file(
    root: &Path,
    candidate: &Path,
    request_path: &str,
    headers: &HeaderMap,
) -> Option<Response> {
    let canonical_root = tokio::fs::canonicalize(root).await.ok()?;
    let canonical = tokio::fs::canonicalize(candidate).await.ok()?;
    if !canonical.starts_with(&canonical_root) {
        return None;
    }
    let metadata = tokio::fs::metadata(&canonical).await.ok()?;
    if !metadata.is_file() {
        return None;
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |value| value.as_millis());
    let etag = format!("W/\"{:x}-{:x}\"", metadata.len(), modified);
    if request_path.starts_with("/assets/") {
        return Some(
            file_response(
                &canonical,
                candidate,
                "public, max-age=31536000, immutable",
                None,
                headers,
            )
            .await,
        );
    }
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        == Some(etag.as_str())
    {
        return Some(
            Response::builder()
                .status(StatusCode::NOT_MODIFIED)
                .header(header::CACHE_CONTROL, "no-cache")
                .header(header::ETAG, etag)
                .body(Body::empty())
                .unwrap(),
        );
    }
    Some(file_response(&canonical, candidate, "no-cache", Some(etag), headers).await)
}

async fn file_response(
    canonical: &Path,
    original: &Path,
    cache_control: &'static str,
    etag: Option<String>,
    headers: &HeaderMap,
) -> Response {
    let accepts_gzip = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(accepts_gzip);
    let gzip = PathBuf::from(format!("{}.gz", canonical.display()));
    let use_gzip = accepts_gzip && compressible(original) && gzip.is_file();
    let source = if use_gzip { &gzip } else { canonical };
    let Ok(bytes) = tokio::fs::read(source).await else {
        return text_response(StatusCode::NOT_FOUND, "Not found");
    };
    let mime = mime_guess::from_path(original).first_or_octet_stream();
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, cache_control);
    if let Some(etag) = etag {
        builder = builder.header(header::ETAG, etag);
    }
    if compressible(original) && gzip.is_file() {
        builder = builder.header(header::VARY, "accept-encoding");
    }
    if use_gzip {
        builder = builder.header(header::CONTENT_ENCODING, "gzip");
    }
    builder.body(Body::from(bytes)).unwrap()
}

fn accepts_gzip(value: &str) -> bool {
    value.split(',').any(|entry| {
        let mut parts = entry.trim().split(';');
        if !parts
            .next()
            .is_some_and(|coding| coding.trim().eq_ignore_ascii_case("gzip"))
        {
            return false;
        }
        !parts.any(|parameter| parameter.trim() == "q=0")
    })
}

fn compressible(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("css" | "html" | "js" | "json" | "map" | "svg")
    )
}

fn json_not_found() -> Response {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .body(Body::from(
            r#"{"error":{"code":"NOT_FOUND","message":"API route not found"}}"#,
        ))
        .unwrap()
}

fn text_response(status: StatusCode, text: &'static str) -> Response {
    let mut response = Response::new(Body::from(text));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gzip_quality_zero_is_rejected() {
        assert!(accepts_gzip("br, gzip"));
        assert!(!accepts_gzip("gzip;q=0"));
    }
}
