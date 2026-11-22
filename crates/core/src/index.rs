//! The tool index: every enabled tool of every enabled provider, held in memory for one isolate.

use crate::{schema, search};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// A search result leaves out a schema longer than this; `describe` always returns it.
const INLINE_SCHEMA_LIMIT: usize = 2000;

#[derive(Deserialize)]
struct State {
    providers: Vec<Provider>,
}

#[derive(Deserialize)]
pub(crate) struct Provider {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub category: Vec<String>,
    mcp_url: String,
    auth: Option<Value>,
    #[serde(default)]
    read_only: bool,
    #[serde(default = "yes")]
    key_required: bool,
    #[serde(default)]
    has_key: bool,
    #[serde(default)]
    tools: Vec<Tool>,
    #[serde(skip)]
    pub terms: HashSet<String>,
}

#[derive(Deserialize)]
pub(crate) struct Tool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Kept as text: parsing every schema up front was a fifth of building the index, and most
    /// are never looked at.
    input_schema: Box<RawValue>,
    #[serde(skip)]
    parsed: OnceLock<Value>,
    #[serde(default)]
    read_only: bool,
}

impl Tool {
    pub(crate) fn schema(&self) -> &Value {
        self.parsed.get_or_init(|| {
            serde_json::from_str(self.input_schema.get()).expect("a RawValue is valid JSON")
        })
    }
}

pub(crate) struct Entry {
    pub id: String,
    pub provider: usize,
    pub tool: Tool,
    pub inline_schema: bool,
    /// Weighted number of indexed terms.
    pub length: f32,
}

pub struct Index {
    pub(crate) providers: Vec<Provider>,
    pub(crate) tools: Vec<Entry>,
    pub(crate) postings: HashMap<String, Vec<(usize, f32)>>,
    /// Number of tools that can be called.
    pub(crate) total: usize,
    pub(crate) average_length: f32,
    ids: HashMap<String, usize>,
}

fn yes() -> bool {
    true
}

impl Provider {
    pub(crate) fn callable(&self) -> bool {
        self.has_key || !self.key_required
    }
}

impl Index {
    /// Builds the index from `{"providers": [{...manifest, "has_key", "tools": [...]}]}`,
    /// which must hold only enabled providers and their enabled, approved tools.
    pub fn new(state: &str) -> Result<Index, String> {
        let state: State = serde_json::from_str(state).map_err(|e| e.to_string())?;
        let mut index = Index {
            providers: Vec::new(),
            tools: Vec::new(),
            postings: HashMap::new(),
            total: 0,
            average_length: 1.0,
            ids: HashMap::new(),
        };
        let mut total_length = 0.0;
        for mut provider in state.providers {
            provider.terms = search::provider_terms(&provider);
            for tool in std::mem::take(&mut provider.tools) {
                let position = index.tools.len();
                let length = if provider.callable() {
                    index.total += 1;
                    search::add(&mut index.postings, position, &tool)
                } else {
                    0.0
                };
                total_length += length;
                let id = format!("{}.{}", provider.id, tool.name);
                index.ids.insert(id.clone(), position);
                index.tools.push(Entry {
                    id,
                    provider: index.providers.len(),
                    inline_schema: tool.input_schema.get().len() <= INLINE_SCHEMA_LIMIT,
                    tool,
                    length,
                });
            }
            index.providers.push(provider);
        }
        if index.total > 0 {
            index.average_length = total_length / index.total as f32;
        }
        Ok(index)
    }

    /// The full definition of one tool, or `{"error": ...}`.
    pub fn describe(&self, id: &str) -> String {
        let (entry, provider) = match self.find(id) {
            Ok(found) => found,
            Err(error) => return error.to_string(),
        };
        json!({
            "id": entry.id,
            "name": entry.tool.name,
            "description": entry.tool.description,
            "input_schema": entry.tool.schema(),
            "read_only": provider.read_only || entry.tool.read_only,
            "provider": { "name": provider.name, "description": provider.description },
        })
        .to_string()
    }

    /// Validates the arguments of a call and says where to send it:
    /// `{"provider", "provider_name", "tool", "url", "auth", "params"}`, or `{"error": ...}`.
    /// `auth` is the manifest's `{"header", "format"}`; the caller substitutes the key.
    /// `params` are the values a current-spec server expects as `Mcp-Param-*` headers.
    pub fn prepare_call(&self, id: &str, arguments: &str) -> String {
        let (entry, provider) = match self.find(id) {
            Ok(found) => found,
            Err(error) => return error.to_string(),
        };
        let arguments = serde_json::from_str(arguments).unwrap_or(Value::Null);
        let problems: Vec<String> = schema::validate(entry.tool.schema(), &arguments)
            .into_iter()
            .map(|p| match p.path.as_str() {
                "" => format!("arguments: {}", p.message),
                path => format!("{path}: {}", p.message),
            })
            .collect();
        if !problems.is_empty() {
            return json!({ "error": "invalid_arguments", "problems": problems }).to_string();
        }
        let mut params = Map::new();
        header_params(entry.tool.schema(), &arguments, &mut params);
        json!({
            "provider": provider.id,
            "provider_name": provider.name,
            "tool": entry.tool.name,
            "url": provider.mcp_url,
            "auth": provider.auth,
            "params": params,
        })
        .to_string()
    }

    fn find(&self, id: &str) -> Result<(&Entry, &Provider), Value> {
        let missing_key =
            |provider: &Provider| json!({ "error": "missing_key", "provider_name": provider.name });
        let Some(&position) = self.ids.get(id) else {
            // A provider that lists no tools without its key has none stored, so its tools are
            // unknown here. The missing key is still the thing to report.
            let provider = id.split_once('.').map(|(provider, _)| provider);
            let keyless = self
                .providers
                .iter()
                .find(|p| Some(p.id.as_str()) == provider);
            return Err(match keyless.filter(|p| !p.callable()) {
                Some(provider) => missing_key(provider),
                None => json!({ "error": "unknown_tool" }),
            });
        };
        let entry = &self.tools[position];
        let provider = &self.providers[entry.provider];
        if provider.callable() {
            Ok((entry, provider))
        } else {
            Err(missing_key(provider))
        }
    }
}

/// Collects the arguments whose schema carries `x-mcp-header`, which the MCP spec allows on
/// string, integer and boolean properties reached through `properties` alone.
fn header_params(schema: &Value, arguments: &Value, params: &mut Map<String, Value>) {
    let properties = schema.get("properties").and_then(Value::as_object);
    for (name, property) in properties.into_iter().flatten() {
        let Some(argument) = arguments.get(name) else {
            continue;
        };
        let header = property.get("x-mcp-header").and_then(Value::as_str);
        let scalar = argument.is_string() || argument.is_boolean() || argument.is_i64();
        if let Some(header) = header.filter(|_| scalar) {
            params.insert(header.to_string(), argument.clone());
        }
        header_params(property, argument, params);
    }
}
