use gator_core::{https_host, validate_catalog_entry, validate_provider};
use serde_json::{Value, json};

fn manifest() -> Value {
    json!({
        "id": "tavily",
        "name": "Tavily",
        "description": "Web search and recent news",
        "category": ["search"],
        "mcp_url": "https://mcp.tavily.com/mcp",
        "signup_url": "https://tavily.com",
        "read_only": true,
        "auth": { "header": "Authorization", "format": "Bearer {key}" }
    })
}

fn with(field: &str, value: Value) -> Value {
    let mut manifest = manifest();
    manifest[field] = value;
    manifest
}

fn without(field: &str) -> Value {
    let mut manifest = manifest();
    manifest.as_object_mut().unwrap().remove(field);
    manifest
}

fn problems(manifest: &Value) -> Vec<String> {
    validate_catalog_entry(manifest)
        .into_iter()
        .map(|p| format!("{}: {}", p.path, p.message))
        .collect()
}

#[test]
fn accepts_a_complete_manifest() {
    assert!(problems(&manifest()).is_empty());
    let optional = json!({
        "docs_url": "https://docs.tavily.com", "key_required": false, "key_hint": "Starts with tvly-",
        "default_enabled_tools": ["a"], "default_disabled_tools": ["b"]
    });
    let mut full = manifest();
    full.as_object_mut()
        .unwrap()
        .extend(optional.as_object().unwrap().clone());
    assert!(problems(&full).is_empty());
}

#[test]
fn reports_missing_and_mistyped_fields() {
    assert_eq!(problems(&without("mcp_url")), ["mcp_url: is required"]);
    assert_eq!(
        problems(&with("name", json!(7))),
        ["name: expected string, got integer"]
    );
    assert_eq!(
        problems(&with("category", json!("search"))),
        [
            "category: expected array, got string",
            "category: must have at least one tag"
        ]
    );
    assert_eq!(
        problems(&with("homepage", json!("https://tavily.com")))[0]
            .split(" (")
            .next(),
        Some("homepage: is not a known property")
    );
    assert_eq!(problems(&json!([]))[0], ": expected object, got array");
}

#[test]
fn restricts_the_id() {
    assert_eq!(
        problems(&with("id", json!("Tavily_1"))),
        ["id: may only contain a-z, 0-9 and -"]
    );
    assert_eq!(problems(&with("id", json!(""))), ["id: must not be empty"]);
}

#[test]
fn quota_signals_must_be_specific() {
    assert!(
        problems(&with(
            "quota_signals",
            json!(["exceeds your plan's set usage limit"])
        ))
        .is_empty()
    );
    assert_eq!(
        problems(&with("quota_signals", json!(["limit"]))),
        ["quota_signals[0]: must have at least 16 characters"]
    );
}

#[test]
fn keeps_descriptions_short() {
    let long = "x".repeat(121);
    assert_eq!(
        problems(&with("description", json!(long))),
        ["description: must be at most 120 characters"]
    );
}

#[test]
fn requires_public_https_urls() {
    let rejected = [
        "http://mcp.tavily.com/mcp",
        "mcp.tavily.com/mcp",
        "https://",
        "https://localhost/mcp",
        "https://localhost:8443/mcp",
        "https://api.localhost/mcp",
        "https://intranet/mcp",
        "https://printer.local/mcp",
        "https://db.internal/mcp",
        "https://router.lan",
        "https://1.0.0.127.in-addr.arpa/",
        "https://127.0.0.1/mcp",
        "https://10.0.0.5:8080/mcp",
        "https://2130706433/mcp",
        "https://0x7f.0.0.1/mcp",
        "https://127.1/mcp",
        "https://[::1]/mcp",
        "https://[fd00::1]:8443/mcp",
        "https://user:pass@mcp.tavily.com/mcp",
        "https://mcp.tavily.com@127.0.0.1/mcp",
        "https://mcp.tavily.com\\@127.0.0.1/mcp",
        "https://mcp.tavily.com./mcp",
        "https://mcp..tavily.com/mcp",
        "https://mcp.tavily.com:port/mcp",
        "https://mcp.tavily.com /mcp",
        "https://mcp.tavily.com/mcp\n",
        "https://mcp.tävily.com/mcp",
        "https://mcp%2etavily.com/mcp",
    ];
    for url in rejected {
        assert!(https_host(url).is_err(), "{url} should be rejected");
        assert_eq!(problems(&with("mcp_url", json!(url))).len(), 1, "{url}");
    }
    assert_eq!(
        https_host("https://mcp.tavily.com/mcp"),
        Ok("mcp.tavily.com")
    );
    assert_eq!(
        https_host("https://MCP.Tavily.com:8443/mcp?x=1#y"),
        Ok("MCP.Tavily.com")
    );
    assert_eq!(https_host("https://api.xn--p1ai"), Ok("api.xn--p1ai"));
    assert_eq!(
        problems(&with("signup_url", json!("http://tavily.com"))).len(),
        1
    );
    assert_eq!(
        problems(&with("docs_url", json!("https://127.0.0.1"))).len(),
        1
    );
}

#[test]
fn checks_the_auth_header() {
    let auth =
        |header: &str, format: &str| with("auth", json!({ "header": header, "format": format }));
    assert_eq!(
        problems(&auth("Authorization", "Bearer")),
        ["auth.format: must contain {key}"]
    );
    assert_eq!(
        problems(&auth("X Api Key", "{key}")),
        ["auth.header: is not a valid header name"]
    );
    assert_eq!(
        problems(&auth("X-Api-Key:", "{key}")),
        ["auth.header: is not a valid header name"]
    );
    assert!(problems(&auth("X-API-Key", "{key}")).is_empty());
    assert_eq!(
        problems(&with("auth", json!({ "header": "Authorization" }))),
        ["auth.format: is required"]
    );
}

#[test]
fn auth_is_optional_only_for_keyless_providers() {
    assert_eq!(
        problems(&without("auth")),
        ["auth: is required unless key_required is false"]
    );
    let mut keyless = without("auth");
    keyless["key_required"] = json!(false);
    assert!(problems(&keyless).is_empty());
}

#[test]
fn a_provider_that_can_write_must_list_its_default_tools() {
    let message =
        "default_enabled_tools: must list the tools to enable, because read_only is false";
    assert_eq!(problems(&with("read_only", json!(false))), [message]);
    let mut listed = with("read_only", json!(false));
    listed["default_enabled_tools"] = json!([]);
    assert_eq!(problems(&listed), [message]);
    listed["default_enabled_tools"] = json!(["search"]);
    assert!(problems(&listed).is_empty());
}

#[test]
fn the_catalog_asks_for_more_than_a_custom_provider() {
    let custom = json!({
        "id": "acme",
        "name": "Acme",
        "description": "Internal sales reports",
        "mcp_url": "https://mcp.acme.example/mcp",
        "auth": { "header": "X-API-Key", "format": "{key}" }
    });
    assert!(validate_provider(&custom).is_empty());
    assert_eq!(
        problems(&custom),
        [
            "signup_url: is required",
            "read_only: is required",
            "category: must have at least one tag"
        ]
    );
}
