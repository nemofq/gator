//! Validates `catalog/providers/*.toml` and bundles them into `catalog/catalog.json`.

use serde_json::Value;
use std::{fs, process::ExitCode};

const BUNDLE: &str = "catalog/catalog.json";

fn main() -> ExitCode {
    let mut paths: Vec<_> = fs::read_dir("catalog/providers")
        .expect("run from the repository root")
        .map(|entry| entry.expect("readable directory entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "toml"))
        .collect();
    paths.sort();

    let mut providers = Vec::new();
    let mut failed = false;
    for path in paths {
        let file = path.display();
        let text = fs::read_to_string(&path).expect("readable manifest");
        let manifest: Value = match toml::from_str(&text) {
            Ok(manifest) => manifest,
            Err(error) => {
                eprintln!("{file}: {error}");
                failed = true;
                continue;
            }
        };
        let problems = gator_core::validate_catalog_entry(&manifest);
        let stem = path.file_stem().and_then(|stem| stem.to_str());
        if manifest.get("id").and_then(Value::as_str) != stem {
            eprintln!("{file}: id: must match the file name");
            failed = true;
        }
        for problem in problems {
            eprintln!("{file}: {}: {}", problem.path, problem.message);
            failed = true;
        }
        providers.push(manifest);
    }
    failed |= !icons_ok(&providers);
    if failed {
        return ExitCode::FAILURE;
    }

    let bundle = serde_json::to_string_pretty(&providers).expect("serializable manifests") + "\n";
    fs::write(BUNDLE, bundle).expect("writable bundle");
    println!("{} providers OK", providers.len());
    ExitCode::SUCCESS
}

const ICONS: &str = "catalog/icons";
const ICON_SIDE: u32 = 64;
const ICON_MAX_BYTES: usize = 8 * 1024;

/// Every file in `catalog/icons` is `<id>.png` for a catalog provider: an opaque square PNG of
/// 64 × 64 pixels (no alpha channel), at most 8 KB. The dashboard rounds its corners like an app
/// icon. An icon is optional; the dashboard shows a letter tile without one.
fn icons_ok(providers: &[Value]) -> bool {
    let Ok(entries) = fs::read_dir(ICONS) else {
        return true;
    };
    let ids: Vec<&str> = providers.iter().filter_map(|p| p["id"].as_str()).collect();
    let mut ok = true;
    for entry in entries {
        let path = entry.expect("readable directory entry").path();
        let file = path.display();
        let id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default();
        let problem = if path.extension().is_none_or(|ext| ext != "png") {
            Some("must be a .png file".to_string())
        } else if !ids.contains(&id) {
            Some("is named after no provider in catalog/providers".to_string())
        } else {
            png_problem(&fs::read(&path).expect("readable icon"))
        };
        if let Some(problem) = problem {
            eprintln!("{file}: {problem}");
            ok = false;
        }
    }
    ok
}

/// Reads the size from the PNG header: the signature, then the IHDR chunk's width and height.
fn png_problem(bytes: &[u8]) -> Option<String> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 26 || &bytes[..8] != SIGNATURE || &bytes[12..16] != b"IHDR" {
        return Some("is not a PNG image".into());
    }
    let side = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().expect("4 bytes"));
    let (width, height) = (side(16), side(20));
    // Colour type 2 is RGB and 0 is greyscale: the two without transparency.
    if !matches!(bytes[25], 0 | 2) {
        return Some("must be opaque: save it as RGB, without an alpha channel".into());
    }
    if (width, height) != (ICON_SIDE, ICON_SIDE) {
        return Some(format!(
            "must be {ICON_SIDE} × {ICON_SIDE} pixels, not {width} × {height}"
        ));
    }
    if bytes.len() > ICON_MAX_BYTES {
        return Some(format!(
            "must be at most {ICON_MAX_BYTES} bytes, not {}",
            bytes.len()
        ));
    }
    None
}
