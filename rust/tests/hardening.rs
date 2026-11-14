//! Input that must neither panic, run away nor leak: the cases a reader of someone else's overlay
//! meets.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use coqui_aos::{
    Change, Digest, Environment, Facts, FileKind, FileSystem, IssueCode, Limit, Metadata,
    PartialLock, Settings, Source, TreeEntry, check_requirements, digest_entries, effective,
    environments, read_document, read_dotenv, read_env_script_output, setup_phase, substitute,
    substitute_with, tree_digest, validate,
};
use coqui_aos::{
    Class, Decision, Error, HookEvent, HookFailure, HookRun, OnFailure, SkillSource, fetch_planned,
    fire_event, read_fetched_skill, read_hook_output, resolve_skills,
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
fn an_unclosed_expression_repeated_is_text_in_one_pass_and_a_nested_one_is_charged() {
    let text = "${".repeat(200_000);
    let started = Instant::now();
    assert_eq!(substitute(&text, &|_| Ok(None)).expect("text"), text);
    let nested = format!("{}{}", "${a".repeat(20_000), "}".repeat(20_000));
    let error = substitute(&nested, &|_| Ok(None)).expect_err("refused");
    assert!(["too-complex", "too-deep"].contains(&error.class.as_str()));
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
    for word in ["block", "deny", "ask", "allow", "refuse"] {
        assert_eq!(Decision::named(word).expect("a word").as_str(), word);
    }
    for word in ["not-run", "timeout", "event-timeout", "output"] {
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

fn quick<T>(seconds: u64, work: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let out = work();
    assert!(
        started.elapsed() < Duration::from_secs(seconds),
        "took {:?}",
        started.elapsed()
    );
    out
}

#[test]
fn text_made_of_openers_and_closers_that_start_no_expression_is_one_pass() {
    let text = format!("{}{}", "${@".repeat(30_000), "}".repeat(30_000));
    let got = quick(3, || substitute(&text, &|_| Ok(None)));
    assert_eq!(got.expect("text"), text);
}

#[test]
fn an_expression_is_charged_for_its_size() {
    let text = "${A}".repeat(2000);
    let lookup = |_: &str| Ok(Some("x".to_owned()));
    let tight = Settings::default().substitution_steps(Limit::at(1000));
    let error = substitute_with(&text, &lookup, &tight).expect_err("refused");
    assert_eq!(error.class, Class::TooComplex);
    let got = substitute_with(&text, &lookup, &Settings::default()).expect("text");
    assert_eq!(got, "x".repeat(2000));
}

#[test]
fn a_pattern_of_unmatched_brackets_is_compiled_in_one_pass() {
    let text = format!("${{A/{}/}}", "[".repeat(30_000));
    let got = quick(3, || substitute(&text, &|_| Ok(Some("x".to_owned()))));
    assert_eq!(got.expect("text"), "x");
}

#[test]
fn a_bracket_of_many_members_costs_no_more_than_a_small_one() {
    let members: String = (0..6_000u32)
        .map(|at| char::from_u32(0x100 + at).expect("a character"))
        .collect();
    let text = format!("${{A//[{members}]/}}");
    let value = "z".repeat(600);
    let got = quick(3, || substitute(&text, &|_| Ok(Some(value.clone()))));
    assert_eq!(got.expect("text"), value);
    let lookup = |_: &str| Ok(Some("axbyc".to_owned()));
    assert_eq!(
        substitute("${A//[a-cx]/-}", &lookup).expect("text"),
        "---y-"
    );
    assert_eq!(
        substitute("${A//[!a-c]/-}", &lookup).expect("text"),
        "a-b-c"
    );
}

#[test]
fn a_subject_escapes_control_format_and_separator_characters_and_is_capped() {
    let error = Error::new(
        Class::InvalidReference,
        "a\u{1b}[2Jb\u{202e}c\n\u{e0001}\u{2028}",
    );
    assert_eq!(error.subject, "a\\x1b[2Jb\\u202ec\\x0a\\U000e0001\\u2028");
    assert_eq!(
        Error::new(Class::Io, "plain/ok \u{e9}.txt").subject,
        "plain/ok \u{e9}.txt"
    );
    assert_eq!(
        Error::new(Class::Io, "x".repeat(5000)).subject,
        format!("{}...", "x".repeat(256))
    );
    assert_eq!(Error::new(Class::Io, "x".repeat(256)).subject.len(), 256);
    assert_eq!(
        Error::new(Class::Io, "\u{7}".repeat(100)).subject,
        format!("{}...", "\\x07".repeat(64))
    );
    assert!(format!("{error}").contains("\\x1b"));
}

#[test]
fn a_refused_tree_entry_shows_no_control_character_and_no_os_message() {
    struct Broken;
    impl FileSystem for Broken {
        fn metadata(&self, _: &Path) -> io::Result<Metadata> {
            Err(io::Error::other("C:\\Users\\secret\\file: the OS speaks"))
        }
        fn read(&self, _: &Path, _: u64) -> io::Result<Vec<u8>> {
            Err(io::Error::other("the OS speaks"))
        }
        fn list(&self, _: &Path) -> io::Result<Vec<OsString>> {
            Err(io::Error::other("the OS speaks"))
        }
    }
    let error = tree_digest(&Broken, Path::new("/o"), &Settings::default()).expect_err("refused");
    assert_eq!(error.class, Class::Io);
    assert!(
        !error.subject.contains("speaks") && !error.subject.contains("secret"),
        "{error}"
    );
    let files = Memory {
        kinds: BTreeMap::from([(PathBuf::from("/o/a\u{1b}[2Jb"), FileKind::Symlink)]),
        names: vec![OsString::from("a\u{1b}[2Jb")],
    };
    let error = tree_digest(&files, Path::new("/o"), &Settings::default()).expect_err("refused");
    assert_eq!(error.class, Class::Symlink);
    assert!(!error.subject.contains('\u{1b}'), "{:?}", error.subject);
}

#[test]
fn a_fetched_skill_lists_the_files_its_pin_covers_and_not_the_excluded_entries_it_carries() {
    let skill = b"---\nname: x\ndescription: d\n---\n".to_vec();
    let covered = vec![
        ("SKILL.md".to_owned(), skill),
        ("a/z.md".to_owned(), b"z".to_vec()),
        ("a.md".to_owned(), b"a".to_vec()),
    ];
    let pin = read_fetched_skill("x", &covered, None, &Settings::default())
        .expect("a skill")
        .digest
        .to_string();
    let mut carried = covered.clone();
    carried.push(("node_modules/p/index.js".to_owned(), b"1".to_vec()));
    carried.push(("__pycache__/m.cpython-312.pyc".to_owned(), b"2".to_vec()));
    carried.push(("m.pyc".to_owned(), b"3".to_vec()));
    carried.push((".git/config".to_owned(), b"4".to_vec()));
    let read =
        read_fetched_skill("x", &carried, Some(&pin), &Settings::default()).expect("a skill");
    assert_eq!(read.files, ["SKILL.md", "a.md", "a/z.md"]);
}

#[test]
fn a_source_host_written_as_a_url_parser_reads_it_is_this_machine() {
    let local = |source: &str| {
        let doc = manifest(json!({"skills": [{"name": "x", "source": source}]}));
        validate(&doc, None)
            .iter()
            .any(|issue| issue.code == IssueCode::LocalSource)
    };
    for host in [
        "127.1",
        "2130706433",
        "0x7f.0.0.1",
        "0177.0.0.1",
        "127.0.1",
        "169.254.1",
        "0",
        "127.0.0.1.",
    ] {
        assert!(local(&format!("https://{host}/s.git")), "{host}");
    }
    assert!(local("git@127.1:s.git"));
    for host in ["127.0.0.1.example.org", "127.1.2.256", "1.2.3.4", "8.8.8"] {
        assert!(!local(&format!("https://{host}/s.git")), "{host}");
    }
}

#[test]
fn applying_refuses_a_name_that_is_no_name_and_a_path_that_leaves_the_overlay() {
    let refused =
        |value: Value| effective(&manifest(value), &Facts::new("linux")).expect_err("refused");
    let error = refused(json!({"env": {"A=B": "x"}}));
    assert_eq!(
        (error.class, error.subject.as_str()),
        (Class::InvalidReference, "A=B")
    );
    assert_eq!(refused(json!({"env": {"A\nB": "x"}})).subject, "A\\x0aB");
    for document in [
        json!({"paths": [{"variable": "PATH", "path": "../bin"}]}),
        json!({"env_files": ["../x"]}),
        json!({"env_scripts": [{"interpreter": "sh", "path": "/etc/x"}]}),
        json!({"setup": [{"interpreter": "sh", "path": "../s.sh"}]}),
        json!({"scripts": {"x": "../s.sh"}}),
        json!({"runtime": {"python": [{"lock": "../r.txt"}]}}),
    ] {
        let error = refused(document.clone());
        assert_eq!(error.class, Class::InvalidReference, "{document}");
        assert!(error.subject.contains('/'), "{document}");
    }
    let odd = manifest(json!({"unknown_field": 1, "description": 5, "env": {"A": "x"}}));
    assert!(effective(&odd, &Facts::new("linux")).is_ok());
}

#[test]
fn many_dotenv_lines_and_many_script_variables_are_read_in_linear_time() {
    let lines: String = (0..30_000).map(|at| format!("V{at}=x\n")).collect();
    let read = quick(3, || {
        read_dotenv(lines.as_bytes(), &mut Environment::default())
    });
    assert_eq!(read.expect("lines").len(), 30_000);
    let object: String = (0..30_000)
        .map(|at| format!("\"V{at}\": \"x\""))
        .collect::<Vec<_>>()
        .join(", ");
    let out = quick(3, || {
        read_env_script_output(format!("{{{object}}}").as_bytes(), &Settings::default())
    });
    assert_eq!(out.expect("output").len(), 30_000);
    let again = b"{\"A\": \"1\", \"B\": \"2\"}\n{\"A\": \"3\"}";
    let out = read_env_script_output(again, &Settings::default()).expect("output");
    assert_eq!(
        out,
        [
            ("A".to_owned(), Some("3".to_owned())),
            ("B".to_owned(), Some("2".to_owned()))
        ]
    );
}

#[test]
fn an_environment_of_many_variables_sets_and_reads_in_linear_time() {
    let mut env = Environment::new(Vec::<(String, String)>::new(), true);
    quick(3, || {
        for at in 0..30_000 {
            env.set(&format!("V{at}"), "x".to_owned(), at % 2 == 0);
        }
        for at in 0..30_000 {
            assert_eq!(env.get(&format!("v{at}")), Some("x"));
        }
    });
    env.set("v7", "y".to_owned(), false);
    env.unset("V3");
    assert_eq!(env.get("V7"), Some("y"));
    assert_eq!(env.get("V3"), None);
    assert_eq!(env.get("V4"), Some("x"));
    assert_eq!(env.values().len(), 29_999);
    assert_eq!(env.values()[7], ("V8".to_owned(), "x".to_owned()));
    assert_eq!(env.values()[6], ("V7".to_owned(), "y".to_owned()));
}

#[test]
fn an_allow_carries_a_rewritten_input_and_no_other_output_does() {
    let read = |data: &[u8]| read_hook_output(HookEvent::PreTool, data, &[], &Settings::default());
    let allowed = read(br#"{"decision": "allow", "input": {"command": "true"}}"#).expect("output");
    assert_eq!(allowed.decision, Some(Decision::Allow));
    assert_eq!(allowed.input, Some(manifest(json!({"command": "true"}))));
    for bad in [
        &br#"{"decision": "ask", "input": {}}"#[..],
        br#"{"input": {}}"#,
        br#"{"decision": "allow", "input": []}"#,
        br#"{"decision": "approve"}"#,
    ] {
        assert_eq!(read(bad).expect_err("refused"), HookFailure::Output);
    }
    let allow = read_hook_output(
        HookEvent::Prompt,
        br#"{"decision": "allow"}"#,
        &[],
        &Settings::default(),
    );
    assert_eq!(allow.expect_err("refused"), HookFailure::Output);
}
