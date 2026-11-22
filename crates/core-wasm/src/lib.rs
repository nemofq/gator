//! The core's JavaScript interface: JSON strings in, JSON strings out.

use wasm_bindgen::prelude::*;

/// See `gator_core::Index`. Build one per isolate and reuse it.
#[wasm_bindgen]
pub struct Index(gator_core::Index);

#[wasm_bindgen]
impl Index {
    #[wasm_bindgen(constructor)]
    pub fn new(state: &str) -> Result<Index, JsError> {
        gator_core::Index::new(state)
            .map(Index)
            .map_err(|e| JsError::new(&e))
    }

    pub fn search(&self, query: &str, provider: Option<String>, limit: usize) -> String {
        self.0.search(query, provider.as_deref(), limit)
    }

    pub fn describe(&self, id: &str) -> String {
        self.0.describe(id)
    }

    pub fn prepare_call(&self, id: &str, arguments: &str) -> String {
        self.0.prepare_call(id, arguments)
    }
}

/// Returns the problems with a provider manifest as `[{"path", "message"}]`; empty if it is valid.
#[wasm_bindgen]
pub fn validate_provider(manifest: &str) -> Result<String, JsError> {
    let manifest = serde_json::from_str(manifest)?;
    Ok(serde_json::to_string(&gator_core::validate_provider(
        &manifest,
    ))?)
}

/// See `gator_core::diff_tools`.
#[wasm_bindgen]
pub fn diff_tools(input: &str) -> Result<String, JsError> {
    gator_core::diff_tools(input).map_err(|e| JsError::new(&e))
}
