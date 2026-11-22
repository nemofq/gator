//! Provider manifests: the files in `catalog/providers/` and custom providers added in the dashboard.

use crate::schema::{self, Problem};
use serde_json::Value;
use std::sync::LazyLock;

static SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../catalog/schema.json"))
        .expect("catalog/schema.json is valid JSON")
});

/// Top-level names that never resolve on the public internet.
const PRIVATE_TLDS: [&str; 10] = [
    "localhost",
    "local",
    "internal",
    "intranet",
    "lan",
    "home",
    "corp",
    "test",
    "invalid",
    "arpa",
];

/// Checks any provider manifest.
pub fn validate_provider(manifest: &Value) -> Vec<Problem> {
    let mut problems = schema::validate(&SCHEMA, manifest);
    let text = |field: &str| manifest.get(field).and_then(Value::as_str);
    let mut fail = |field: &str, message: &str| problems.push(Problem::new(field, message));

    let id_char = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-';
    if text("id").is_some_and(|id| !id.bytes().all(id_char)) {
        fail("id", "may only contain a-z, 0-9 and -");
    }
    for field in ["mcp_url", "signup_url", "docs_url"] {
        if let Some(Err(message)) = text(field).map(https_host) {
            fail(field, message);
        }
    }
    match manifest.get("auth") {
        Some(auth) => {
            let part = |name: &str| auth.get(name).and_then(Value::as_str);
            if part("header").is_some_and(|header| !is_header_name(header)) {
                fail("auth.header", "is not a valid header name");
            }
            if part("format").is_some_and(|format| !format.contains("{key}")) {
                fail("auth.format", "must contain {key}");
            }
        }
        None if manifest.get("key_required") != Some(&Value::Bool(false)) => {
            fail("auth", "is required unless key_required is false");
        }
        None => {}
    }
    problems
}

/// Checks a manifest for the shared catalog, which asks for more than a custom provider does.
pub fn validate_catalog_entry(manifest: &Value) -> Vec<Problem> {
    let mut problems = validate_provider(manifest);
    let mut fail = |field: &str, message: &str| problems.push(Problem::new(field, message));
    let is_empty_list = |field: &str| {
        manifest
            .get(field)
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
    };

    for field in ["signup_url", "read_only"] {
        if manifest.get(field).is_none() {
            fail(field, "is required");
        }
    }
    if is_empty_list("category") {
        fail("category", "must have at least one tag");
    }
    if manifest.get("read_only") == Some(&Value::Bool(false))
        && is_empty_list("default_enabled_tools")
    {
        fail(
            "default_enabled_tools",
            "must list the tools to enable, because read_only is false",
        );
    }
    problems
}

/// Returns the host of an `https` URL, if that host is a public domain name.
pub fn https_host(url: &str) -> Result<&str, &'static str> {
    const BAD_HOST: &str = "host must be a public domain name";
    let rest = url
        .strip_prefix("https://")
        .ok_or("must start with https://")?;
    if url.contains(|c: char| c.is_whitespace() || c.is_control() || c == '\\') {
        return Err("must not contain spaces, control characters or backslashes");
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        _ => authority,
    };
    let labels: Vec<&str> = host.split('.').collect();
    let is_label =
        |l: &&str| !l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if labels.len() < 2 || !labels.iter().all(is_label) {
        return Err(BAD_HOST);
    }
    // An all-letter last label rules out every spelling of an IP address.
    let tld = labels[labels.len() - 1].to_ascii_lowercase();
    let is_name = tld.bytes().all(|b| b.is_ascii_alphabetic()) || tld.starts_with("xn--");
    if !is_name || PRIVATE_TLDS.contains(&tld.as_str()) {
        return Err(BAD_HOST);
    }
    Ok(host)
}

fn is_header_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}
