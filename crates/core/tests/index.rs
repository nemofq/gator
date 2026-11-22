use gator_core::Index;
use serde_json::{Value, json};

fn state() -> Value {
    json!({ "providers": [
        {
            "id": "tavily",
            "name": "Tavily",
            "description": "Web search and recent news",
            "category": ["search"],
            "mcp_url": "https://mcp.tavily.com/mcp",
            "auth": { "header": "Authorization", "format": "Bearer {key}" },
            "has_key": true,
            "tools": [{
                "name": "tavily_search",
                "description": "Search the web.",
                "input_schema": {
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "query": { "type": "string" },
                        "max_results": { "type": "integer", "minimum": 1 }
                    }
                },
                "read_only": true
            }]
        },
        {
            "id": "notes",
            "name": "Notes",
            "description": "Personal notes",
            "mcp_url": "https://notes.example.com/mcp",
            "key_required": false,
            "tools": [
                { "name": "add.note", "description": "Add a note.", "input_schema": { "type": "object" } },
                { "name": "big", "input_schema": { "type": "object", "required": ["a"], "description": "x".repeat(2000) } }
            ]
        },
        {
            "id": "locked",
            "name": "Locked",
            "description": "Needs a key that was never set",
            "mcp_url": "https://locked.example.com/mcp",
            "auth": { "header": "X-API-Key", "format": "{key}" },
            "tools": [{ "name": "peek", "description": "Peek at the web.", "input_schema": {} }]
        }
    ] })
}

fn index() -> Index {
    Index::new(&state().to_string()).unwrap()
}

fn parse(json: String) -> Value {
    serde_json::from_str(&json).unwrap()
}

#[test]
fn rejects_malformed_state() {
    for state in ["", "not json", "[]", "{}", r#"{"providers":[{"id":"x"}]}"#] {
        assert!(Index::new(state).is_err(), "{state:?} should be rejected");
    }
    assert!(Index::new(r#"{"providers":[]}"#).is_ok());
}

#[test]
fn an_empty_index_answers_without_tools() {
    let index = Index::new(r#"{"providers":[]}"#).unwrap();
    assert_eq!(
        parse(index.search("anything", None, 5)),
        json!({ "total": 0, "tools": [], "providers": [] })
    );
    assert_eq!(
        parse(index.describe("a.b")),
        json!({ "error": "unknown_tool" })
    );
}

#[test]
fn describes_a_tool_in_full() {
    assert_eq!(
        parse(index().describe("tavily.tavily_search")),
        json!({
            "id": "tavily.tavily_search",
            "name": "tavily_search",
            "description": "Search the web.",
            "input_schema": state()["providers"][0]["tools"][0]["input_schema"],
            "read_only": true,
            "provider": { "name": "Tavily", "description": "Web search and recent news" }
        })
    );
    assert_eq!(
        parse(index().describe("notes.add.note"))["read_only"],
        false
    );
}

#[test]
fn a_read_only_provider_makes_its_tools_read_only() {
    let mut state = state();
    state["providers"][1]["read_only"] = json!(true);
    let index = Index::new(&state.to_string()).unwrap();
    assert_eq!(parse(index.describe("notes.add.note"))["read_only"], true);
}

#[test]
fn routes_a_valid_call() {
    let call = index().prepare_call(
        "tavily.tavily_search",
        r#"{"query":"rust","max_results":3}"#,
    );
    assert_eq!(
        parse(call),
        json!({
            "provider": "tavily",
            "provider_name": "Tavily",
            "tool": "tavily_search",
            "url": "https://mcp.tavily.com/mcp",
            "auth": { "header": "Authorization", "format": "Bearer {key}" },
            "params": {}
        })
    );
    let keyless = parse(index().prepare_call("notes.add.note", "{}"));
    assert_eq!(keyless["auth"], Value::Null);
    assert_eq!(keyless["tool"], "add.note");
}

#[test]
fn lists_what_is_wrong_with_the_arguments() {
    let call = index().prepare_call("tavily.tavily_search", r#"{"max_results":0}"#);
    assert_eq!(
        parse(call),
        json!({
            "error": "invalid_arguments",
            "problems": ["query: is required", "max_results: must be at least 1"]
        })
    );
    for arguments in ["", "null", "[]", "\"query\"", "{not json"] {
        let call = parse(index().prepare_call("tavily.tavily_search", arguments));
        assert_eq!(call["error"], "invalid_arguments", "{arguments:?}");
        assert!(
            call["problems"][0]
                .as_str()
                .unwrap()
                .starts_with("arguments: expected object")
        );
    }
}

#[test]
fn unknown_and_keyless_tools_are_errors() {
    for id in [
        "",
        "tavily",
        "tavily.",
        "tavily.nope",
        "nope.tavily_search",
        "TAVILY.tavily_search",
    ] {
        assert_eq!(
            parse(index().prepare_call(id, "{}")),
            json!({ "error": "unknown_tool" }),
            "{id:?}"
        );
        assert_eq!(
            parse(index().describe(id)),
            json!({ "error": "unknown_tool" }),
            "{id:?}"
        );
    }
    let missing = json!({ "error": "missing_key", "provider_name": "Locked" });
    assert_eq!(parse(index().prepare_call("locked.peek", "{}")), missing);
    assert_eq!(parse(index().describe("locked.peek")), missing);
    // A provider may list no tools at all until it has its key.
    assert_eq!(
        parse(index().prepare_call("locked.never_listed", "{}")),
        missing
    );
    assert_eq!(parse(index().describe("locked.")), missing);
}

#[test]
fn a_tool_without_a_key_is_not_searchable() {
    let result = parse(index().search("peek at the web", None, 5));
    assert_eq!(result["total"], 3);
    assert_eq!(result["tools"][0]["id"], "tavily.tavily_search");
    assert_eq!(result["tools"].as_array().unwrap().len(), 1);
}

#[test]
fn an_empty_query_lists_the_callable_providers() {
    let expected = json!({
        "total": 3,
        "tools": [],
        "providers": [
            { "id": "tavily", "name": "Tavily", "description": "Web search and recent news", "tools": 1 },
            { "id": "notes", "name": "Notes", "description": "Personal notes", "tools": 2 }
        ]
    });
    assert_eq!(parse(index().search("", None, 5)), expected);
    assert_eq!(parse(index().search("  ?! ", None, 5)), expected);
    assert_eq!(parse(index().search("zzzzqqqq", None, 5)), expected);
}

#[test]
fn search_results_carry_the_schema_unless_it_is_large() {
    let result = parse(index().search("note", None, 5));
    let ids: Vec<&str> = result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["notes.add.note", "notes.big"]);
    assert_eq!(
        result["tools"][0],
        json!({
            "id": "notes.add.note",
            "provider": "notes",
            "name": "add.note",
            "description": "Add a note.",
            "input_schema": { "type": "object" }
        })
    );
    assert_eq!(result["tools"][1].get("input_schema"), None);
    assert_eq!(result["tools"][1]["required"], json!(["a"]));
    assert_eq!(result["tools"][0].get("required"), None);
    assert!(parse(index().describe("notes.big"))["input_schema"].is_object());
}

#[test]
fn search_clips_long_descriptions_on_a_character_boundary() {
    let mut state = state();
    state["providers"][0]["tools"][0]["description"] = json!("search é".repeat(100));
    let index = Index::new(&state.to_string()).unwrap();
    let result = parse(index.search("search", None, 1));
    let description = result["tools"][0]["description"].as_str().unwrap();
    assert_eq!(description.chars().count(), 401);
    assert!(description.ends_with('…'));
    let full = parse(index.describe("tavily.tavily_search"));
    assert_eq!(full["description"].as_str().unwrap().chars().count(), 800);
}

#[test]
fn collects_header_parameters_for_current_spec_servers() {
    let mut state = state();
    state["providers"][0]["tools"][0]["input_schema"] = json!({
        "type": "object",
        "properties": {
            "region": { "type": "string", "x-mcp-header": "Region" },
            "page": { "type": "integer", "x-mcp-header": "Page" },
            "dry": { "type": "boolean", "x-mcp-header": "Dry-Run" },
            "ratio": { "type": "number", "x-mcp-header": "Ratio" },
            "absent": { "type": "string", "x-mcp-header": "Absent" },
            "nothing": { "x-mcp-header": "Nothing" },
            "scope": { "type": "object", "properties": {
                "tenant": { "type": "string", "x-mcp-header": "Tenant" }
            } },
            "list": { "type": "array", "items": { "type": "string", "x-mcp-header": "Item" } }
        }
    });
    let index = Index::new(&state.to_string()).unwrap();
    let arguments = json!({
        "region": "eu", "page": 2, "dry": false, "ratio": 0.5, "nothing": null,
        "scope": { "tenant": "acme" }, "list": ["a"]
    });
    let call = parse(index.prepare_call("tavily.tavily_search", &arguments.to_string()));
    assert_eq!(
        call["params"],
        json!({ "Region": "eu", "Page": 2, "Dry-Run": false, "Tenant": "acme" })
    );
}
