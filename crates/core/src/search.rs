//! BM25 ranking over tool names and descriptions, with a flat bonus for each query term that
//! the tool's provider matches in its name, description or category tags.

use crate::index::{Index, Provider, Tool};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const K1: f32 = 1.2;
const B: f32 = 0.75;
/// A match in the tool's name counts for more than one in running text.
const NAME_WEIGHT: f32 = 3.0;
/// Added to every tool of a provider for each query term the provider itself matches.
const PROVIDER_MATCH: f32 = 1.0;
/// How far a query that names every word of a tool's name lifts it: the score is multiplied by
/// one plus this times the share of the name's words the query has.
const NAME_COVERAGE: f32 = 1.0;
/// Puts a tool first when the query is exactly its ID or name.
const EXACT_MATCH: f32 = 1000.0;
const MAX_LIMIT: usize = 20;
/// Words of a spoken request that say nothing about which tool is wanted, as `terms` folds them.
const STOP_WORDS: [&str; 40] = [
    "a", "about", "all", "an", "and", "any", "are", "be", "by", "can", "do", "doe", "for", "from",
    "have", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "some", "that", "the",
    "there", "thi", "to", "wa", "what", "when", "where", "which", "who", "with", "you", "your",
];
/// Search results carry at most this much of a description; `describe` returns all of it.
const DESCRIPTION_LIMIT: usize = 400;
/// Only the start of a description is indexed: what a tool is for comes first, and the parameter
/// notes that follow in a long one match every query a little.
const INDEXED_LIMIT: usize = 1000;

/// Indexes one tool under position `doc` and returns its weighted length.
pub(crate) fn add(
    postings: &mut HashMap<String, Vec<(usize, f32)>>,
    doc: usize,
    tool: &Tool,
) -> f32 {
    let mut frequencies: HashMap<String, f32> = HashMap::new();
    let description = clip(&tool.description, INDEXED_LIMIT);
    for (text, weight) in [(tool.name.as_str(), NAME_WEIGHT), (description, 1.0)] {
        for term in terms(text) {
            *frequencies.entry(term).or_default() += weight;
        }
    }
    let length = frequencies.values().sum();
    for (term, frequency) in frequencies {
        postings.entry(term).or_default().push((doc, frequency));
    }
    length
}

/// The terms a provider is found by.
pub(crate) fn provider_terms(provider: &Provider) -> HashSet<String> {
    let fields = [&provider.name, &provider.description];
    let texts = fields.into_iter().chain(&provider.category);
    texts.flat_map(|text| terms(text)).collect()
}

impl Index {
    /// Ranks callable tools for a query: `{"total", "tools": [...]}`. When nothing matches,
    /// which includes an empty query, the result also lists the providers.
    pub fn search(&self, query: &str, provider: Option<&str>, limit: usize) -> String {
        let mut scores = vec![0.0; self.tools.len()];
        let mut query_terms = terms(query);
        query_terms.retain(|term| !STOP_WORDS.contains(&term.as_str()));
        query_terms.sort();
        query_terms.dedup();
        for term in &query_terms {
            for (doc, entry) in self.tools.iter().enumerate() {
                let provider = &self.providers[entry.provider];
                if provider.callable() && provider.terms.contains(term) {
                    scores[doc] += PROVIDER_MATCH;
                }
            }
            let Some(matches) = self.postings.get(term) else {
                continue;
            };
            let rarity =
                (self.total as f32 - matches.len() as f32 + 0.5) / (matches.len() as f32 + 0.5);
            let idf = (1.0 + rarity).ln();
            for &(doc, frequency) in matches {
                let length = self.tools[doc].length / self.average_length;
                let saturation = frequency + K1 * (1.0 - B + B * length);
                scores[doc] += idf * frequency * (K1 + 1.0) / saturation;
            }
        }

        let query = query.trim();
        let mut hits: Vec<(usize, f32)> = Vec::new();
        for (doc, entry) in self.tools.iter().enumerate() {
            let wanted = provider.is_none_or(|id| id == self.providers[entry.provider].id);
            // With a provider named, its tools that match nothing still follow the ones that do.
            if wanted && (scores[doc] > 0.0 || provider.is_some()) {
                let name = terms(&entry.tool.name);
                let named = name
                    .iter()
                    .filter(|term| query_terms.contains(term))
                    .count();
                let coverage = named as f32 / name.len().max(1) as f32;
                let exact = query == entry.id || query == entry.tool.name;
                let score = scores[doc] * (1.0 + NAME_COVERAGE * coverage);
                hits.push((doc, score + if exact { EXACT_MATCH } else { 0.0 }));
            }
        }
        hits.sort_by(|a, b| b.1.total_cmp(&a.1));
        hits.truncate(limit.clamp(1, MAX_LIMIT));

        let tools: Vec<Value> = hits.iter().map(|&(doc, _)| self.hit(doc)).collect();
        let mut result = json!({ "total": self.total, "tools": tools });
        if hits.is_empty() {
            result["providers"] = self.provider_list();
        }
        result.to_string()
    }

    fn hit(&self, doc: usize) -> Value {
        let entry = &self.tools[doc];
        let description = &entry.tool.description;
        let clipped = clip(description, DESCRIPTION_LIMIT);
        let mut hit = json!({
            "id": entry.id,
            "provider": self.providers[entry.provider].id,
            "name": entry.tool.name,
            "description": if clipped.len() < description.len() {
                format!("{clipped}…")
            } else {
                description.clone()
            },
        });
        if entry.inline_schema {
            hit["input_schema"] = entry.tool.schema().clone();
        } else if let Some(required) = entry.tool.schema().get("required") {
            // Without the schema, a caller should at least know what it cannot leave out.
            hit["required"] = required.clone();
        }
        hit
    }

    fn provider_list(&self) -> Value {
        let list = self
            .providers
            .iter()
            .enumerate()
            .filter_map(|(position, provider)| {
                let tools = self.tools.iter().filter(|t| t.provider == position).count();
                provider.callable().then(|| {
                    json!({
                        "id": provider.id,
                        "name": provider.name,
                        "description": provider.description,
                        "tools": tools,
                    })
                })
            });
        list.collect()
    }
}

/// Splits text into lowercase terms at anything that is not a letter or digit in any script,
/// then folds plurals. A camelCase word gives its parts and the whole word, so that "YouTube" is
/// found by "youtube" as well as by "tube".
fn terms(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let (mut word, mut part) = (String::new(), String::new());
    let mut after_lowercase = false;
    // The trailing space ends the last word.
    for c in text.chars().chain([' ']) {
        if c.is_alphanumeric() {
            if after_lowercase && c.is_uppercase() {
                terms.push(singular(std::mem::take(&mut part)));
            }
            part.extend(c.to_lowercase());
            word.extend(c.to_lowercase());
        } else if !word.is_empty() {
            if part.len() < word.len() {
                terms.push(singular(std::mem::take(&mut part)));
            }
            terms.push(singular(std::mem::take(&mut word)));
            part.clear();
        }
        after_lowercase = c.is_lowercase();
    }
    terms
}

fn singular(mut term: String) -> String {
    if term.len() > 3 && term.ends_with("ies") {
        term.truncate(term.len() - 3);
        term.push('y');
    } else if term.len() > 3 && term.ends_with('s') && !term.ends_with("ss") {
        term.pop();
    }
    term
}

/// The first `limit` characters of `text`.
fn clip(text: &str, limit: usize) -> &str {
    text.char_indices()
        .nth(limit)
        .map_or(text, |(end, _)| &text[..end])
}
