use gator_core::diff_tools;
use serde_json::{Value, json};

fn tool(name: &str, description: &str) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } } }
    })
}

fn read_only(name: &str) -> Value {
    let mut tool = tool(name, "Reads.");
    tool["annotations"] = json!({ "readOnlyHint": true });
    tool
}

fn diff(input: Value) -> Value {
    serde_json::from_str(&diff_tools(&input.to_string()).unwrap()).unwrap()
}

/// The stored form of a fresh list: what the shell keeps after applying a first diff.
fn stored(fresh: &Value) -> Value {
    let first = diff(json!({ "stored": [], "fresh": fresh }));
    let entry = |tool: &Value| json!({ "name": tool["name"], "hash": tool["hash"] });
    first["added"]
        .as_array()
        .unwrap()
        .iter()
        .map(entry)
        .collect()
}

fn enabled(result: &Value) -> Vec<(&str, bool)> {
    let added = result["added"].as_array().unwrap().iter();
    added
        .map(|t| (t["name"].as_str().unwrap(), t["enabled"].as_bool().unwrap()))
        .collect()
}

#[test]
fn a_first_snapshot_adds_every_tool_in_stored_form() {
    let result = diff(json!({ "stored": [], "fresh": [read_only("search")] }));
    assert_eq!(result["changed"], json!([]));
    assert_eq!(result["removed"], json!([]));
    let added = &result["added"][0];
    assert_eq!(added["name"], "search");
    assert_eq!(added["description"], "Reads.");
    assert_eq!(added["input_schema"]["properties"]["q"]["type"], "string");
    assert_eq!(added["read_only"], true);
    assert_eq!(added["enabled"], true);
    assert_eq!(added["hash"].as_str().unwrap().len(), 16);
}

#[test]
fn an_unchanged_list_reports_nothing() {
    let fresh = json!([tool("a", "A."), read_only("b")]);
    let result = diff(json!({ "stored": stored(&fresh), "fresh": fresh }));
    assert_eq!(result, json!({ "added": [], "changed": [], "removed": [] }));
}

#[test]
fn the_hash_ignores_key_order_and_unrelated_fields() {
    let fresh = json!([tool("a", "A.")]);
    let reordered: Value = serde_json::from_str(
        r#"[{"title":"New title","icons":[],"inputSchema":{"properties":{"q":{"type":"string"}},"type":"object"},"description":"A.","name":"a"}]"#,
    )
    .unwrap();
    let result = diff(json!({ "stored": stored(&fresh), "fresh": reordered }));
    assert_eq!(result, json!({ "added": [], "changed": [], "removed": [] }));
}

#[test]
fn reports_added_changed_and_removed_tools() {
    let before = json!([
        tool("keep", "Same."),
        tool("edit", "Old text."),
        tool("drop", "Gone soon.")
    ]);
    let after = json!([
        tool("keep", "Same."),
        tool("edit", "New text."),
        tool("new", "Fresh.")
    ]);
    let result = diff(json!({ "stored": stored(&before), "fresh": after }));
    assert_eq!(enabled(&result), [("new", false)]);
    assert_eq!(result["removed"], json!(["drop"]));
    assert_eq!(result["changed"].as_array().unwrap().len(), 1);
    assert_eq!(result["changed"][0]["name"], "edit");
    assert_eq!(result["changed"][0]["description"], "New text.");
    assert_eq!(result["changed"][0].get("enabled"), None);
}

#[test]
fn a_change_to_the_schema_or_the_read_only_hint_is_a_change() {
    let before = json!([read_only("a"), read_only("b"), read_only("c")]);
    let mut after = before.clone();
    after[0]["inputSchema"]["properties"]["q"]["type"] = json!("integer");
    after[1]["annotations"]["readOnlyHint"] = json!(false);
    after[2]["annotations"] = json!({ "readOnlyHint": true, "title": "C" });
    let result = diff(json!({ "stored": stored(&before), "fresh": after }));
    let changed: Vec<&str> = result["changed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(changed, ["a", "b"]);
    assert_eq!(result["changed"][1]["read_only"], false);
}

#[test]
fn a_catalog_provider_starts_with_its_default_tools() {
    let fresh = json!([tool("a", ""), tool("b", ""), tool("c", "")]);
    let all = diff(json!({ "stored": [], "fresh": fresh }));
    assert_eq!(enabled(&all), [("a", true), ("b", true), ("c", true)]);
    let denied = diff(json!({ "stored": [], "fresh": fresh, "default_disabled_tools": ["b"] }));
    assert_eq!(enabled(&denied), [("a", true), ("b", false), ("c", true)]);
    let allowed = diff(json!({
        "stored": [], "fresh": fresh,
        "default_enabled_tools": ["a", "b"], "default_disabled_tools": ["b"]
    }));
    assert_eq!(enabled(&allowed), [("a", true), ("b", false), ("c", false)]);
}

#[test]
fn a_tool_that_appears_later_waits_for_the_owner_even_if_the_catalog_names_it() {
    let before = json!([tool("a", "")]);
    let after = json!([tool("a", ""), tool("b", ""), read_only("c")]);
    let unnamed = diff(json!({ "stored": stored(&before), "fresh": after }));
    assert_eq!(enabled(&unnamed), [("b", false), ("c", false)]);
    let named = diff(json!({
        "stored": stored(&before), "fresh": after, "default_enabled_tools": ["a", "c"]
    }));
    assert_eq!(enabled(&named), [("b", false), ("c", false)]);
}

#[test]
fn a_custom_provider_starts_with_only_its_read_only_tools() {
    let fresh = json!([tool("write", ""), read_only("read")]);
    let first = diff(json!({ "stored": [], "fresh": fresh, "custom": true }));
    assert_eq!(enabled(&first), [("write", false), ("read", true)]);
    let later = diff(json!({
        "stored": stored(&json!([tool("old", "")])), "fresh": fresh, "custom": true
    }));
    assert_eq!(enabled(&later), [("write", false), ("read", false)]);
}

#[test]
fn tolerates_missing_optional_fields() {
    let fresh = json!([
        { "name": "bare", "inputSchema": {} },
        { "name": "nulls", "description": null, "inputSchema": { "type": "object" }, "annotations": null },
        { "name": "hintless", "inputSchema": {}, "annotations": { "destructiveHint": true } }
    ]);
    let result = diff(json!({ "stored": [], "fresh": fresh, "custom": true }));
    assert_eq!(
        enabled(&result),
        [("bare", false), ("nulls", false), ("hintless", false)]
    );
    assert_eq!(result["added"][0]["description"], "");
}

#[test]
fn rejects_malformed_input() {
    for input in [
        "",
        "{}",
        "[]",
        r#"{"stored":[],"fresh":[{}]}"#,
        r#"{"stored":[],"fresh":[{"name":"x"}]}"#,
        r#"{"stored":[{"name":"x"}],"fresh":[]}"#,
    ] {
        assert!(diff_tools(input).is_err(), "{input:?} should be rejected");
    }
}
