//! The Gator core: catalog validation, the tool index and search, argument validation, routing
//! and snapshot diffing. It performs no I/O, so it runs the same natively, in a Worker and in a
//! browser.

mod catalog;
mod diff;
mod index;
mod schema;
mod search;

pub use catalog::{https_host, validate_catalog_entry, validate_provider};
pub use diff::diff_tools;
pub use index::Index;
pub use schema::{Problem, validate};
