//! Validation against the subset of JSON Schema that MCP tool schemas use.
//!
//! Supported: `type`, `enum`, `const`, `required`, `properties`, `additionalProperties`,
//! `items`, `minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`,
//! `exclusiveMinimum`, `exclusiveMaximum`, `anyOf`, `oneOf`, `allOf` and local `$ref`.
//! Every other keyword is ignored, so validation here is never stricter than the schema.
//! `oneOf` is treated as `anyOf`.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, PartialEq, Serialize)]
pub struct Problem {
    /// Where the problem is, such as `filters.tags[0]`. Empty for the value itself.
    pub path: String,
    pub message: String,
}

impl Problem {
    pub(crate) fn new(path: &str, message: impl Into<String>) -> Problem {
        Problem {
            path: path.to_string(),
            message: message.into(),
        }
    }
}

/// Stops a schema whose `$ref`s form a cycle.
const MAX_DEPTH: u8 = 32;

pub fn validate(schema: &Value, value: &Value) -> Vec<Problem> {
    let mut problems = Vec::new();
    check(schema, schema, value, "", 0, &mut problems);
    problems
}

fn check(
    root: &Value,
    schema: &Value,
    value: &Value,
    path: &str,
    depth: u8,
    problems: &mut Vec<Problem>,
) {
    let Some(schema) = schema.as_object() else {
        return;
    };
    if depth > MAX_DEPTH {
        return;
    }
    let depth = depth + 1;
    let mut fail = |path: &str, message: String| problems.push(Problem::new(path, message));

    if let Some(expected) = schema.get("type") {
        let allowed: Vec<&str> = match expected {
            Value::Array(types) => types.iter().filter_map(Value::as_str).collect(),
            other => other.as_str().into_iter().collect(),
        };
        let actual = type_name(value);
        let matches = |t: &&str| *t == actual || (*t == "number" && actual == "integer");
        if !allowed.is_empty() && !allowed.iter().any(matches) {
            fail(
                path,
                format!("expected {}, got {actual}", allowed.join(" or ")),
            );
            return;
        }
    }
    if let Some(options) = schema.get("enum").and_then(Value::as_array)
        && !options.contains(value)
    {
        fail(path, format!("must be one of {}", list(options)));
    }
    if let Some(constant) = schema.get("const")
        && constant != value
    {
        fail(path, format!("must be {constant}"));
    }

    let limit = |keyword: &str| schema.get(keyword).and_then(Value::as_f64);
    match value {
        Value::String(text) => {
            let length = text.chars().count() as f64;
            if let Some(min) = limit("minLength").filter(|min| length < *min) {
                fail(path, at_least(min, "characters"));
            }
            if let Some(max) = limit("maxLength").filter(|max| length > *max) {
                fail(path, format!("must be at most {max} characters"));
            }
        }
        Value::Number(number) => {
            let number = number.as_f64().unwrap_or(f64::NAN);
            if let Some(min) = limit("minimum").filter(|min| number < *min) {
                fail(path, format!("must be at least {min}"));
            }
            if let Some(max) = limit("maximum").filter(|max| number > *max) {
                fail(path, format!("must be at most {max}"));
            }
            if let Some(min) = limit("exclusiveMinimum").filter(|min| number <= *min) {
                fail(path, format!("must be greater than {min}"));
            }
            if let Some(max) = limit("exclusiveMaximum").filter(|max| number >= *max) {
                fail(path, format!("must be less than {max}"));
            }
        }
        Value::Array(items) => {
            let length = items.len() as f64;
            if let Some(min) = limit("minItems").filter(|min| length < *min) {
                fail(path, at_least(min, "items"));
            }
            if let Some(max) = limit("maxItems").filter(|max| length > *max) {
                fail(path, format!("must have at most {max} items"));
            }
            if let Some(item_schema) = schema.get("items") {
                for (i, item) in items.iter().enumerate() {
                    let path = format!("{path}[{i}]");
                    check(root, item_schema, item, &path, depth, problems);
                }
            }
        }
        Value::Object(fields) => {
            let properties = schema.get("properties").and_then(Value::as_object);
            let required = schema.get("required").and_then(Value::as_array);
            for name in required.into_iter().flatten().filter_map(Value::as_str) {
                if !fields.contains_key(name) {
                    fail(&join(path, name), "is required".to_string());
                }
            }
            for (name, field) in fields {
                let path = join(path, name);
                if let Some(property) = properties.and_then(|p| p.get(name)) {
                    check(root, property, field, &path, depth, problems);
                } else if let Some(extra) = schema.get("additionalProperties") {
                    if extra == &Value::Bool(false) {
                        let known: Vec<&str> = properties
                            .into_iter()
                            .flat_map(|p| p.keys().map(String::as_str))
                            .collect();
                        let message = format!("is not a known property ({})", known.join(", "));
                        problems.push(Problem::new(&path, message));
                    } else {
                        check(root, extra, field, &path, depth, problems);
                    }
                }
            }
        }
        Value::Null | Value::Bool(_) => {}
    }

    let target = schema
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|reference| reference.strip_prefix('#'))
        .and_then(|pointer| root.pointer(pointer));
    if let Some(target) = target {
        check(root, target, value, path, depth, problems);
    }
    for branch in schema
        .get("allOf")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        check(root, branch, value, path, depth, problems);
    }
    for keyword in ["anyOf", "oneOf"] {
        // Report the branch that came closest; a branch that matches reports nothing.
        let closest = schema
            .get(keyword)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|branch| {
                let mut found = Vec::new();
                check(root, branch, value, path, depth, &mut found);
                found
            })
            .min_by_key(Vec::len);
        problems.extend(closest.into_iter().flatten());
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(n) if n.as_f64().is_some_and(|f| f.fract() == 0.0) => "integer",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn at_least(min: f64, unit: &str) -> String {
    if min == 1.0 {
        "must not be empty".to_string()
    } else {
        format!("must have at least {min} {unit}")
    }
}

fn join(path: &str, name: &str) -> String {
    if path.is_empty() {
        name.to_string()
    } else {
        format!("{path}.{name}")
    }
}

fn list(values: &[Value]) -> String {
    let shown: Vec<String> = values.iter().map(Value::to_string).collect();
    shown.join(", ")
}
