//! Compares a provider's stored tool snapshot with a fresh `tools/list`.

use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Input {
    /// The tools already stored, each with the hash of its latest seen version.
    stored: Vec<Stored>,
    /// The `tools` array as the provider returned it.
    fresh: Vec<Fresh>,
    #[serde(default)]
    default_enabled_tools: Vec<String>,
    #[serde(default)]
    default_disabled_tools: Vec<String>,
    /// True for a provider that is not in the catalog.
    #[serde(default)]
    custom: bool,
}

#[derive(Deserialize)]
struct Stored {
    name: String,
    hash: String,
}

#[derive(Deserialize)]
struct Fresh {
    name: String,
    description: Option<String>,
    #[serde(rename = "inputSchema")]
    input_schema: Value,
    annotations: Option<Annotations>,
}

#[derive(Deserialize)]
struct Annotations {
    #[serde(rename = "readOnlyHint")]
    read_only: Option<bool>,
}

/// Returns `{"added": [...], "changed": [...], "removed": [names]}`. Added and changed tools are
/// `{"name", "description", "input_schema", "read_only", "hash"}`; added ones also say whether
/// they start `enabled`.
pub fn diff_tools(input: &str) -> Result<String, String> {
    let input: Input = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let first_snapshot = input.stored.is_empty();
    let (mut added, mut changed) = (Vec::new(), Vec::new());
    for tool in &input.fresh {
        let description = tool.description.as_deref().unwrap_or_default();
        let read_only = tool.annotations.as_ref().and_then(|a| a.read_only) == Some(true);
        let hash = hash(description, &tool.input_schema, read_only);
        let mut entry = json!({
            "name": tool.name,
            "description": description,
            "input_schema": tool.input_schema,
            "read_only": read_only,
            "hash": hash,
        });
        match input.stored.iter().find(|stored| stored.name == tool.name) {
            Some(stored) if stored.hash == hash => {}
            Some(_) => changed.push(entry),
            None => {
                // With every call going through one gateway tool, the client no longer asks the
                // owner before a write. So a tool is on by default only where the catalog says
                // so, or, for a custom provider, where the provider marks it read-only; and only
                // in the first snapshot. A tool that appears later stays off until the owner
                // switches it on.
                let by_default = if input.default_enabled_tools.is_empty() {
                    read_only || !input.custom
                } else {
                    input.default_enabled_tools.contains(&tool.name)
                };
                entry["enabled"] = Value::Bool(
                    first_snapshot
                        && by_default
                        && !input.default_disabled_tools.contains(&tool.name),
                );
                added.push(entry);
            }
        }
    }
    let removed: Vec<&str> = input
        .stored
        .iter()
        .filter(|stored| input.fresh.iter().all(|tool| tool.name != stored.name))
        .map(|stored| stored.name.as_str())
        .collect();
    Ok(json!({ "added": added, "changed": changed, "removed": removed }).to_string())
}

/// FNV-1a over what the owner approves. It only has to notice a change: the approved text is
/// what agents are shown, so a forged collision would gain a provider nothing.
fn hash(description: &str, input_schema: &Value, read_only: bool) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in format!("{description}\0{input_schema}\0{read_only}").bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}
