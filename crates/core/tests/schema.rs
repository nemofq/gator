use gator_core::validate;
use serde_json::{Value, json};

fn problems(schema: Value, value: Value) -> Vec<String> {
    validate(&schema, &value)
        .into_iter()
        .map(|p| format!("{}: {}", p.path, p.message))
        .collect()
}

fn search_schema() -> Value {
    json!({
        "type": "object",
        "required": ["query"],
        "additionalProperties": false,
        "properties": {
            "query": { "type": "string", "minLength": 1, "maxLength": 10 },
            "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
            "score": { "type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1 },
            "sort": { "enum": ["new", "top"] },
            "mode": { "const": "fast" },
            "tags": { "type": "array", "minItems": 1, "maxItems": 2, "items": { "type": "string" } },
            "filter": {
                "type": "object",
                "required": ["field"],
                "properties": { "field": { "type": "string" }, "exact": { "type": "boolean" } }
            }
        }
    })
}

#[test]
fn accepts_valid_arguments() {
    let value = json!({
        "query": "rust", "limit": 5, "score": 0.5, "sort": "top", "mode": "fast",
        "tags": ["a"], "filter": { "field": "title", "exact": true, "anything": 1 }
    });
    assert!(problems(search_schema(), value).is_empty());
}

#[test]
fn reports_each_problem_with_its_path() {
    let value = json!({
        "limit": "5", "score": 1, "sort": "old", "mode": "slow", "tags": [], "filter": {}, "q": "x"
    });
    assert_eq!(
        problems(search_schema(), value),
        [
            "query: is required",
            "filter.field: is required",
            "limit: expected integer, got string",
            "mode: must be \"fast\"",
            "q: is not a known property (filter, limit, mode, query, score, sort, tags)",
            "score: must be less than 1",
            "sort: must be one of \"new\", \"top\"",
            "tags: must not be empty",
        ]
    );
}

#[test]
fn checks_bounds_and_items() {
    let value = json!({ "query": "", "limit": 0, "score": 0, "tags": ["a", 2, "c"] });
    assert_eq!(
        problems(search_schema(), value),
        [
            "limit: must be at least 1",
            "query: must not be empty",
            "score: must be greater than 0",
            "tags: must have at most 2 items",
            "tags[1]: expected string, got integer",
        ]
    );
    let value = json!({ "query": "longer than ten", "limit": 51 });
    assert_eq!(
        problems(search_schema(), value),
        [
            "limit: must be at most 50",
            "query: must be at most 10 characters"
        ]
    );
}

#[test]
fn counts_characters_not_bytes() {
    let schema = json!({ "type": "string", "maxLength": 2 });
    assert!(problems(schema, json!("日本")).is_empty());
}

#[test]
fn integer_accepts_whole_floats_and_number_accepts_integers() {
    assert!(problems(json!({ "type": "integer" }), json!(3.0)).is_empty());
    assert!(problems(json!({ "type": "number" }), json!(3)).is_empty());
    assert_eq!(
        problems(json!({ "type": "integer" }), json!(3.5)),
        [": expected integer, got number"]
    );
}

#[test]
fn accepts_a_list_of_types() {
    let schema = json!({ "type": ["string", "null"] });
    assert!(problems(schema.clone(), json!(null)).is_empty());
    assert_eq!(
        problems(schema, json!(1)),
        [": expected string or null, got integer"]
    );
}

#[test]
fn any_of_reports_the_closest_branch() {
    let schema = json!({ "properties": { "id": { "anyOf": [
        { "type": "string" },
        { "type": "object", "required": ["a", "b"] }
    ] } } });
    assert!(problems(schema.clone(), json!({ "id": "x" })).is_empty());
    assert!(problems(schema.clone(), json!({ "id": { "a": 1, "b": 2 } })).is_empty());
    assert_eq!(
        problems(schema, json!({ "id": 5 })),
        ["id: expected string, got integer"]
    );
    let one_of = json!({ "oneOf": [{ "type": "integer" }, { "type": "number" }] });
    assert!(problems(one_of, json!(1)).is_empty());
}

#[test]
fn all_of_checks_every_branch() {
    let schema = json!({ "allOf": [{ "required": ["a"] }, { "required": ["b"] }] });
    assert_eq!(problems(schema, json!({ "a": 1 })), ["b: is required"]);
}

#[test]
fn follows_local_refs_and_survives_cycles() {
    let schema = json!({
        "type": "object",
        "properties": { "node": { "$ref": "#/$defs/node" } },
        "$defs": { "node": {
            "type": "object",
            "required": ["name"],
            "properties": { "child": { "$ref": "#/$defs/node" } }
        } }
    });
    let value = json!({ "node": { "name": "a", "child": { "child": {} } } });
    assert_eq!(
        problems(schema, value),
        [
            "node.child.name: is required",
            "node.child.child.name: is required"
        ]
    );
    let endless = json!({ "$ref": "#" });
    assert!(problems(endless, json!(1)).is_empty());
}

#[test]
fn validates_additional_properties_against_a_schema() {
    let schema = json!({ "type": "object", "additionalProperties": { "type": "integer" } });
    assert_eq!(
        problems(schema, json!({ "a": 1, "b": "x" })),
        ["b: expected integer, got string"]
    );
}

#[test]
fn ignores_what_it_does_not_understand() {
    let schema = json!({
        "type": "string", "pattern": "^[0-9]+$", "format": "uri", "x-custom": { "deep": true },
        "$ref": "https://example.com/remote.json", "not": {}
    });
    assert!(problems(schema, json!("abc")).is_empty());
    for schema in [
        json!(true),
        json!(false),
        json!(null),
        json!("nonsense"),
        json!([1]),
    ] {
        assert!(problems(schema, json!({ "a": 1 })).is_empty());
    }
    let odd = json!({ "type": 7, "enum": "x", "required": "y", "properties": [], "minimum": "z" });
    assert!(problems(odd, json!({ "a": 1 })).is_empty());
}
