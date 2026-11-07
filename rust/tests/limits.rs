//! What a hostile overlay's text cannot do to the reader: grow a value without bound, nest
//! expressions past the stack, or make a pattern take forever; the settings that bound it; and
//! the vectors' own digests.

use std::time::{Duration, Instant};

use coqui_aos::{
    Digest, Environment, Error, Limit, Settings, read_dotenv, substitute, substitute_with,
};

fn lookup<'a>(env: &'a Environment) -> impl Fn(&str) -> Result<Option<String>, Error> + 'a {
    move |name: &str| Ok(env.get(name).map(str::to_owned))
}

#[test]
fn a_value_that_doubles_line_after_line_is_refused_before_it_is_large() {
    let mut text = String::from("A0=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n");
    for line in 1..48 {
        let before = line - 1;
        text.push_str(&format!("A{line}=${{A{before}}}${{A{before}}}\n"));
    }
    let mut env = Environment::new(Vec::new(), false);
    let started = Instant::now();
    let error = read_dotenv(text.as_bytes(), &mut env).expect_err("refused");
    assert_eq!(error.class.as_str(), "too-large", "{error}");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn expressions_nested_past_the_limit_are_refused_not_followed_down_the_stack() {
    let depth = 200_000;
    let text = "${U:-".repeat(depth) + "x" + &"}".repeat(depth);
    let env = Environment::new(Vec::new(), false);
    let error = substitute(&text, &lookup(&env)).expect_err("refused");
    assert_eq!(error.class.as_str(), "too-deep", "{error}");
}

#[test]
fn a_pattern_that_would_take_forever_is_refused_quickly() {
    let mut env = Environment::new(Vec::new(), false);
    env.set("A", "a".repeat(20_000), false);
    let started = Instant::now();
    let error = substitute("${A//*z/}", &lookup(&env)).expect_err("refused");
    assert_eq!(error.class.as_str(), "too-complex", "{error}");
    assert!(started.elapsed() < Duration::from_secs(5));
    env.set("P", "/usr/bin:/bin".to_owned(), false);
    assert_eq!(
        substitute("${P//:/ }", &lookup(&env)).expect("substituted"),
        "/usr/bin /bin"
    );
}

#[test]
fn a_substitution_limit_is_a_setting_with_no_floor() {
    let env = Environment::new(Vec::new(), false);
    let tight = Settings::default().substitution_depth(Limit::at(1));
    let nested = "${U:-${V:-${W:-x}}}";
    assert_eq!(
        substitute_with(nested, &lookup(&env), &tight)
            .expect_err("refused")
            .class
            .as_str(),
        "too-deep"
    );
    assert_eq!(
        substitute_with(nested, &lookup(&env), &Settings::default()).expect("within the default"),
        "x"
    );
    let lifted = Settings::default().substitution_bytes(Limit::UNBOUNDED);
    assert!(substitute_with("${U:-x}", &lookup(&env), &lifted).is_ok());
}

#[test]
fn a_setting_past_its_default_is_reported_as_data() {
    assert!(Settings::default().non_defaults().is_empty());
    let looser = Settings::default()
        .manifest_depth(Limit::UNBOUNDED)
        .tree_files(Limit::at(10));
    let reported = looser.non_defaults();
    let names: Vec<(&str, &str, &str)> = reported
        .iter()
        .map(|setting| {
            (
                setting.setting.as_str(),
                setting.value.as_str(),
                setting.default.as_str(),
            )
        })
        .collect();
    assert_eq!(
        names,
        [
            ("manifest_depth", "none", "64"),
            ("tree_files", "10", "4096")
        ]
    );
}

#[test]
fn the_vector_files_are_the_ones_the_source_file_names() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../vectors");
    let source: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.join("AOS-SOURCE.json")).expect("the source file"),
    )
    .expect("JSON");
    let files = source["files"].as_object().expect("files");
    assert!(files.len() >= 11, "{} files", files.len());
    for (name, digest) in files {
        let bytes = std::fs::read(dir.join(name)).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(
            Digest::of(&bytes).to_string(),
            digest.as_str().expect("a digest"),
            "{name} differs from the specification's copy"
        );
    }
    let listed: std::collections::BTreeSet<String> = files.keys().cloned().collect();
    let present: std::collections::BTreeSet<String> = std::fs::read_dir(&dir)
        .expect("vectors")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name != "AOS-SOURCE.json")
        .collect();
    assert_eq!(
        listed, present,
        "every vector file is named, and none is missing"
    );
}
