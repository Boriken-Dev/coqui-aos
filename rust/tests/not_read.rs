//! The vector files this crate does not read yet: every case is counted and named as skipped, so
//! a new case or file is noticed, and the list below is the whole of what is not covered.

mod support;

use serde_json::Value;

fn skipped(file: &str, reason: &'static str) {
    support::run(file, |_| Ok(()), |_| Some(reason));
}

#[test]
fn skills_from_elsewhere_are_not_resolved_yet() {
    skipped(
        "skills.json",
        "skills from elsewhere: catalogs, pins and fetched skills are not read by this crate yet",
    );
}

#[test]
fn hooks_are_not_read_yet() {
    skipped(
        "hooks.json",
        "the Hooks class: hooks are not read by this crate yet",
    );
}

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
