//! The specification's conformance vectors (`vectors/`, copied byte for byte), run through the
//! crate's exported runner. Each test runs every case of one file and names each failing case.

use std::path::PathBuf;

use coqui_aos::vectors::Runner;
use coqui_aos::{Document, Effective, Error, Facts, NonDefaultId, NonDefaultSetting, effective};

fn vectors() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vectors")
}

fn run(file: &str) {
    let report = Runner::new(vectors()).run_file(file).expect("a known file");
    eprintln!(
        "{file}: {} passed, {} skipped, {} failed",
        report.passed,
        report.skipped.len(),
        report.failed.len()
    );
    assert!(report.skipped.is_empty());
    assert!(report.passed > 0);
    report.assert_clean();
}

#[test]
fn reading() {
    run("reading.json");
}

#[test]
fn validation() {
    run("validation.json");
}

#[test]
fn names() {
    run("names.json");
}

#[test]
fn source() {
    run("source.json");
}

#[test]
fn digest() {
    run("digest.json");
}

#[test]
fn compose_vectors() {
    run("compose.json");
}

#[test]
fn effective_vectors() {
    run("effective.json");
}

#[test]
fn catalogs_and_icons() {
    run("catalog.json");
}

#[test]
fn front_matter() {
    run("front_matter.json");
}

#[test]
fn hooks() {
    run("hooks.json");
}

#[test]
fn templating() {
    run("templating.json");
}

#[test]
fn skills_from_elsewhere() {
    run("skills.json");
}

/// What a host does: `effective`, and its own settings on top.
fn with_host_settings(
    host: &[NonDefaultSetting],
) -> impl Fn(&Document, &Facts) -> Result<Effective, Error> + use<> {
    let host = host.to_vec();
    move |manifest, facts| {
        let mut result = effective(manifest, facts)?;
        result.non_defaults.extend(host.iter().cloned());
        Ok(result)
    }
}

#[test]
fn a_host_wrapper_adding_declared_settings_passes_the_vectors() {
    let host = vec![
        NonDefaultSetting::new(NonDefaultId::Hook, "read-only"),
        NonDefaultSetting::new(NonDefaultId::Unpinned, String::new()),
    ];
    assert_eq!(host[0].id, NonDefaultId::Hook);
    assert_eq!(host[0].subject, "read-only");
    let report = Runner::new(vectors())
        .effective(with_host_settings(&host))
        .host_non_defaults(host)
        .run_file("effective.json")
        .expect("a known file");
    assert!(report.passed > 0);
    report.assert_clean();
}

#[test]
fn a_host_setting_it_did_not_declare_fails_the_vectors() {
    let host = vec![NonDefaultSetting::new(NonDefaultId::Hook, "read-only")];
    let report = Runner::new(vectors())
        .effective(with_host_settings(&host))
        .run_file("effective.json")
        .expect("a known file");
    assert!(!report.is_clean());
}

#[test]
fn a_skip_is_named_in_the_report() {
    let report = Runner::new(vectors())
        .skip(|file, _| (file == "names.json").then_some("for the test"))
        .run_file("names.json")
        .expect("a known file");
    assert_eq!(report.passed, 0);
    assert!(!report.skipped.is_empty());
}

#[test]
fn a_host_defined_weakening_goes_through_the_runner() {
    let host = vec![NonDefaultSetting::host(
        "read-only-not-enforced",
        "workspace",
    )];
    assert_eq!(host[0].id.as_str(), "read-only-not-enforced");
    assert_eq!(host[0].id.to_string(), "read-only-not-enforced");
    assert_eq!(host[0].subject, "workspace");
    // A word AOS defines is that AOS id, not a second spelling of it.
    assert_eq!(
        NonDefaultSetting::host("unpinned", "").id,
        NonDefaultId::Unpinned
    );
    let report = Runner::new(vectors())
        .effective(with_host_settings(&host))
        .host_non_defaults(host)
        .run_file("effective.json")
        .expect("a known file");
    assert!(report.passed > 0);
    report.assert_clean();
}
