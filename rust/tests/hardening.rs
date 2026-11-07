//! Input that must neither panic, run away nor leak: the cases a reader of someone else's overlay
//! meets.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use coqui_aos::{
    Change, Digest, Facts, FileKind, FileSystem, Limit, Metadata, PartialLock, Settings, Source,
    TreeEntry, check_requirements, digest_entries, effective, environments, read_document,
    read_env_script_output, setup_phase, substitute, tree_digest, validate,
};
use coqui_aos::{
    Class, Error, HookEvent, HookRun, OnFailure, SkillSource, fetch_planned, fire_event,
    read_fetched_skill, read_hook_output, resolve_skills,
};
use serde_json::{Value, json};

fn manifest(value: Value) -> serde_json::Map<String, Value> {
    value.as_object().expect("a mapping").clone()
}

#[test]
fn a_node_package_name_shorter_than_package_json_is_not_a_panic() {
    for package in ["x", "é", "pack", ""] {
        let doc = manifest(json!({"runtime": {"node": [{"package": package}]}}));
        let _ = effective(&doc, &Facts::new("linux"));
    }
}

#[test]
fn a_url_that_is_not_ascii_in_its_first_seven_bytes_is_not_a_panic() {
    let doc = manifest(json!({"mcp": {"servers": [
        {"name": "s", "transport": "streamable-http", "url": "ééééé"}]}}));
    let _ = effective(&doc, &Facts::new("linux"));
}

#[test]
fn environments_of_names_nobody_defined_is_not_a_panic() {
    let overlays = BTreeMap::new();
    let trees = BTreeMap::new();
    let got = environments(
        &overlays,
        &["ghost".to_owned()],
        &trees,
        "linux",
        &["gone".to_owned()],
    )
    .expect("nothing to refuse");
    assert!(got.environments.is_empty());
}

#[test]
fn an_env_script_s_output_is_held_to_the_depth_setting() {
    let deep = br#"{"A": [[[[[[]]]]]]}"#;
    let tight = Settings::default().manifest_depth(Limit::at(3));
    assert_eq!(
        read_env_script_output(deep, &tight)
            .expect_err("refused")
            .class
            .as_str(),
        "too-deep"
    );
    assert!(read_env_script_output(br#"{"A": "b"}"#, &tight).is_ok());
}

#[test]
fn an_unclosed_expression_repeated_is_refused_quickly() {
    let text = "${".repeat(200_000);
    let started = Instant::now();
    let error = substitute(&text, &|_| Ok(None)).expect_err("refused");
    assert_eq!(error.class.as_str(), "too-complex");
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn a_refused_requirements_line_is_never_quoted() {
    let error = check_requirements("--index-url https://user:SECRET@host/simple\n", false)
        .expect_err("refused");
    assert_eq!(error.class.as_str(), "invalid-requirements");
    assert_eq!(error.line, Some(1));
    assert!(!format!("{error:?} {error}").contains("SECRET"));
}

#[test]
fn a_source_s_debug_output_shows_no_credential() {
    let source =
        Source::parse("https://user:SECRET@example.org/x.git?token=QUERY").expect("a source");
    let shown = format!("{source:?}");
    assert!(
        !shown.contains("SECRET") && !shown.contains("QUERY"),
        "{shown}"
    );
    assert!(source.holds_credentials());
}

#[test]
fn a_toml_refusal_quotes_nothing_from_the_document() {
    let error =
        read_document(b"password = \"hunter2\"\n= 1\n", &Settings::default()).expect_err("refused");
    assert_eq!(error.class.as_str(), "parse-error");
    assert!(!format!("{error:?} {error}").contains("hunter2"));
    assert!(error.line.is_some());
}

#[test]
fn a_pointer_names_a_key_with_a_slash_by_the_escaped_token() {
    let doc = manifest(json!({"env": {"a/b": "x"}}));
    let at: Vec<String> = validate(&doc, None)
        .into_iter()
        .map(|issue| issue.at)
        .collect();
    assert!(at.iter().any(|at| at == "/env/a~1b"), "{at:?}");
    assert!(!at.iter().any(|at| at == "/env/a/b"), "{at:?}");
}

#[test]
fn a_member_listed_twice_is_refused() {
    let entries = [
        (vec![b"a".as_slice()], TreeEntry::File(b"1".to_vec())),
        (vec![b"a".as_slice()], TreeEntry::File(b"2".to_vec())),
    ];
    let error = digest_entries(entries.iter().map(|(path, entry)| (path.clone(), entry)))
        .expect_err("refused");
    assert_eq!(error.class.as_str(), "duplicate-member");
}

#[test]
fn a_digest_compared_to_a_record_ignores_case() {
    let upper = format!("sha256:{}", "AB".repeat(32));
    let lower = upper.to_ascii_lowercase();
    assert_eq!(
        setup_phase(Change::Activate, Some(&upper), Some(&lower)),
        None
    );
    assert_eq!(
        Digest::parse(&upper).expect("a digest"),
        Digest::parse(&lower).expect("a digest")
    );
}

#[test]
fn a_partial_lock_is_an_error_a_caller_can_show() {
    fn shown<E: std::error::Error>(error: &E) -> String {
        error.to_string()
    }
    assert_eq!(
        shown(&PartialLock("requirements.txt".to_owned())),
        "partial-lock: requirements.txt"
    );
}

/// A tree held in memory, listing whatever its test says.
struct Memory {
    kinds: BTreeMap<PathBuf, FileKind>,
    names: Vec<OsString>,
}

impl FileSystem for Memory {
    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        if path == Path::new("/o") {
            return Ok(Metadata::new(FileKind::Directory, 0));
        }
        Ok(Metadata::new(
            self.kinds.get(path).copied().unwrap_or(FileKind::Directory),
            0,
        ))
    }

    fn read(&self, _: &Path, _: u64) -> io::Result<Vec<u8>> {
        Ok(Vec::new())
    }

    fn list(&self, path: &Path) -> io::Result<Vec<OsString>> {
        // Every directory lists the same names, so the tree is as deep as the walk goes.
        let _ = path;
        Ok(self.names.clone())
    }
}

#[test]
fn directories_nested_past_the_depth_setting_are_refused_not_followed() {
    let files = Memory {
        kinds: BTreeMap::new(),
        names: vec![OsString::from("d")],
    };
    let settings = Settings::default().tree_depth(Limit::at(5));
    let error = tree_digest(&files, Path::new("/o"), &settings).expect_err("refused");
    assert_eq!(error.class.as_str(), "too-large");
    assert!(error.subject.contains("deeper than 5"), "{error}");
}

#[test]
fn a_listed_name_that_is_not_one_path_component_is_refused() {
    for name in ["..", ".", "a/b", "a\\b", ""] {
        let files = Memory {
            kinds: BTreeMap::new(),
            names: vec![OsString::from(name)],
        };
        let error =
            tree_digest(&files, Path::new("/o"), &Settings::default()).expect_err("refused");
        assert_eq!(error.class.as_str(), "invalid-name", "{name:?}");
    }
}

#[test]
fn empty_directories_count_against_the_entry_limit() {
    let files = Memory {
        kinds: BTreeMap::new(),
        names: vec![OsString::from("a"), OsString::from("b")],
    };
    let settings = Settings::default().tree_files(Limit::at(3));
    let error = tree_digest(&files, Path::new("/o"), &settings).expect_err("refused");
    assert_eq!(error.class.as_str(), "too-large");
}

#[test]
fn a_run_that_claims_endless_seconds_does_not_reset_the_event_s_clock() {
    let mut first = HookRun::new("a", Vec::new());
    first.seconds = 1;
    let mut second = HookRun::new("b", Vec::new());
    second.seconds = u64::MAX;
    let third = HookRun::new("c", Vec::new());
    let settings = Settings::default().hook_event_timeout(Limit::at(5));
    let fired = fire_event(
        HookEvent::Prompt,
        &[first, second, third],
        None,
        &settings,
        false,
    );
    assert_eq!(fired.ran, ["a", "b"]);
    assert_eq!(fired.reports.len(), 1);
    assert_eq!(fired.reports[0].about, ["c", "prompt", "event-timeout"]);
}

#[test]
fn a_hook_run_and_what_it_fired_show_no_output_in_debug() {
    let mut run = HookRun::new("a", br#"{"context": "TOKEN-VALUE"}"#.to_vec());
    run.sets = vec!["A".to_owned()];
    let fired = fire_event(
        HookEvent::Prompt,
        &[run.clone()],
        None,
        &Settings::default(),
        false,
    );
    let shown = format!("{run:?} {fired:?}");
    assert!(!shown.contains("TOKEN-VALUE"), "{shown}");
    let output = read_hook_output(
        HookEvent::SessionStart,
        br#"{"env": {"A": "SECRET-VALUE"}}"#,
        &["A".to_owned()],
        &Settings::default(),
    )
    .expect("an output");
    assert!(!format!("{output:?}").contains("SECRET-VALUE"));
}

#[test]
fn a_fetched_skill_past_the_tree_limits_is_refused_before_it_is_hashed() {
    let files = vec![
        ("SKILL.md".to_owned(), b"---\nname: x\n---\n".to_vec()),
        ("big".to_owned(), vec![0; 100]),
    ];
    let tight = Settings::default().file_bytes(Limit::at(50));
    let error = read_fetched_skill("x", &files, None, &tight).expect_err("refused");
    assert_eq!(error.class.as_str(), "too-large");
    let few = Settings::default().tree_files(Limit::at(1));
    assert_eq!(
        read_fetched_skill("x", &files, None, &few)
            .expect_err("refused")
            .class
            .as_str(),
        "too-large"
    );
    assert!(read_fetched_skill("x", &files, None, &Settings::default()).is_ok());
}

#[test]
fn a_skill_source_s_own_error_reaches_the_caller_as_it_is() {
    struct Refusing;
    impl SkillSource for Refusing {
        fn fetch(&self, _: &Source) -> Result<Vec<(String, Vec<u8>)>, Error> {
            Err(Error::new(Class::NotFound, "gone"))
        }
    }
    let overlays = BTreeMap::from([(
        "a".to_owned(),
        manifest(json!({"skills": [{"name": "x", "source": "https://example.org/x.git"}]})),
    )]);
    let plan = resolve_skills(
        &overlays,
        &["a".to_owned()],
        &BTreeMap::new(),
        &[],
        &[],
        true,
        &Settings::default(),
    )
    .expect("a plan");
    let got = fetch_planned(&plan, &Refusing, &Settings::default());
    assert_eq!(
        got[0].outcome.as_ref().expect_err("refused").class,
        Class::NotFound
    );
}

#[test]
fn the_words_of_a_closed_set_read_back() {
    use coqui_aos::{
        CatalogForm, Decision, EntryRefusal, HookFailure, HookScope, IconFormat, PlannedOrigin,
    };
    for word in ["report", "refuse"] {
        assert_eq!(OnFailure::named(word).expect("a word").as_str(), word);
    }
    for word in ["overlay", "user", "project"] {
        assert_eq!(HookScope::named(word).expect("a word").as_str(), word);
    }
    for word in ["block", "deny", "ask", "refuse"] {
        assert_eq!(Decision::named(word).expect("a word").as_str(), word);
    }
    for word in ["not-run", "timeout", "event-timeout", "grant"] {
        assert_eq!(HookFailure::named(word).expect("a word").as_str(), word);
    }
    for word in ["minimal", "full"] {
        assert_eq!(CatalogForm::named(word).expect("a word").as_str(), word);
    }
    assert_eq!(
        EntryRefusal::named("leaves-repository"),
        Some(EntryRefusal::LeavesRepository)
    );
    assert_eq!(IconFormat::named("webp"), Some(IconFormat::Webp));
    assert_eq!(
        PlannedOrigin::named("ambiguous"),
        Some(PlannedOrigin::Ambiguous)
    );
    assert_eq!(OnFailure::named("deny"), None);
}
