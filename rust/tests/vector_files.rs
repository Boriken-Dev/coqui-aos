//! Every vector file has a runner: a new file in `vectors/` fails here until one is written.

mod support;

use serde_json::Value;

#[test]
fn every_vector_file_is_run_or_named_here() {
    let mut files: Vec<String> = std::fs::read_dir(support::vector_dir())
        .expect("vectors")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.ends_with(".json") && name != "AOS-SOURCE.json")
        .collect();
    files.sort();
    assert_eq!(
        files,
        [
            "catalog.json",
            "compose.json",
            "digest.json",
            "effective.json",
            "front_matter.json",
            "hooks.json",
            "names.json",
            "reading.json",
            "skills.json",
            "source.json",
            "validation.json"
        ],
        "a new vector file needs a runner or a named skip"
    );
    let _ = Value::Null;
}
