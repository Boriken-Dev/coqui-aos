//! Env scripts run while an environment is built: where the order of application puts them, what
//! each sees, and what a run that gives nothing leaves.

use std::collections::BTreeMap;

use coqui_aos::serde_json::{Value, json};
use coqui_aos::{
    Document, Environment, Facts, OverlayTree, ScriptCall, ScriptFailure, ScriptResult,
    composed_environment, composed_environment_running,
};

/// An overlay, the script's place and the environment it ran with.
type Call = (String, usize, Vec<(String, String)>);

fn manifest(value: Value) -> Document {
    value.as_object().expect("an object").clone()
}

fn facts(identity: &str, allowed: Option<&str>) -> Facts {
    let mut facts = Facts::new("linux");
    facts.root = format!("/srv/ov/{identity}");
    facts.identity = identity.to_owned();
    facts.pinned = true;
    facts.gate_env_scripts = true;
    facts.digest =
        Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned());
    facts.allowed = allowed.map(str::to_owned);
    facts.tree = OverlayTree::from_paths(["env/a.sh".to_owned(), "env/b.sh".to_owned()]);
    facts
}

fn script(path: &str) -> Value {
    json!({"interpreter": "sh", "path": path})
}

fn value_of(env: &Environment, name: &str) -> Option<String> {
    env.get(name).map(str::to_owned)
}

#[test]
fn a_later_overlay_reads_what_an_earlier_one_s_script_set_and_its_script_reads_its_own_declarations()
 {
    let one = manifest(json!({"env_scripts": [script("env/a.sh")]}));
    let two = manifest(json!({
        "env": {"SEEN": "${FROM_ONE}"},
        "env_scripts": [script("env/b.sh")],
    }));
    let active = [
        (
            &one,
            facts(
                "one",
                Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            ),
        ),
        (
            &two,
            facts(
                "two",
                Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            ),
        ),
    ];
    let mut calls: Vec<Call> = Vec::new();
    let mut run = |call: &ScriptCall<'_>| -> ScriptResult {
        calls.push((call.identity.to_owned(), call.index, call.env.clone()));
        Ok(match call.identity {
            "one" => br#"{"FROM_ONE": "first"}"#.to_vec(),
            _ => br#"{"FROM_TWO": "second"}"#.to_vec(),
        })
    };
    let composed = composed_environment_running(
        &active,
        Environment::new([("BASE".to_owned(), "b".to_owned())], false),
        &BTreeMap::new(),
        &mut Vec::new(),
        &mut run,
    );
    let env = composed.env.expect("built");
    assert_eq!(value_of(&env, "FROM_ONE").as_deref(), Some("first"));
    assert_eq!(value_of(&env, "FROM_TWO").as_deref(), Some("second"));
    // The second overlay's own `env` was substituted after the first one's script ran.
    assert_eq!(value_of(&env, "SEEN").as_deref(), Some("first"));
    assert_eq!(composed.script_reports.len(), 2);
    assert!(composed.script_reports.iter().all(|r| r.failure.is_none()));

    let names =
        |call: &Call| -> Vec<String> { call.2.iter().map(|(name, _)| name.clone()).collect() };
    let get = |call: &Call, name: &str| {
        call.2
            .iter()
            .find(|(each, _)| each == name)
            .map(|(_, value)| value.clone())
    };
    assert_eq!(calls.len(), 2);
    let (first, second) = (&calls[0], &calls[1]);
    // The first sees the base, every root, and its own name; none of the later overlay's.
    assert_eq!(get(first, "BASE").as_deref(), Some("b"));
    assert_eq!(
        get(first, "ONE_OVERLAY_ROOT").as_deref(),
        Some("/srv/ov/one")
    );
    assert_eq!(
        get(first, "TWO_OVERLAY_ROOT").as_deref(),
        Some("/srv/ov/two")
    );
    assert_eq!(get(first, "AOS_OVERLAY_NAME").as_deref(), Some("one"));
    assert!(!names(first).contains(&"SEEN".to_owned()));
    assert!(!names(first).contains(&"FROM_TWO".to_owned()));
    // The second sees the first's output, its own declarations, and its own name.
    assert_eq!(get(second, "FROM_ONE").as_deref(), Some("first"));
    assert_eq!(get(second, "SEEN").as_deref(), Some("first"));
    assert_eq!(get(second, "AOS_OVERLAY_NAME").as_deref(), Some("two"));
    assert_eq!(
        get(second, "AOS_OVERLAY_ROOT").as_deref(),
        Some("/srv/ov/two")
    );
}

#[test]
fn a_script_s_output_goes_on_top_of_what_the_overlay_s_own_declarations_set() {
    let one = manifest(json!({
        "env": {"LEVEL": "declared"},
        "env_scripts": [script("env/a.sh"), script("env/b.sh")],
    }));
    let active = [(
        &one,
        facts(
            "one",
            Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        ),
    )];
    let mut run = |call: &ScriptCall<'_>| -> ScriptResult {
        Ok(match call.index {
            0 => b"{\"LEVEL\": \"script-1\", \"GONE\": \"x\"}\n{\"EXTRA\": \"1\"}\n".to_vec(),
            _ => b"{\"GONE\": null}".to_vec(),
        })
    };
    let composed = composed_environment_running(
        &active,
        Environment::default(),
        &BTreeMap::new(),
        &mut Vec::new(),
        &mut run,
    );
    let env = composed.env.expect("built");
    assert_eq!(value_of(&env, "LEVEL").as_deref(), Some("script-1"));
    assert_eq!(value_of(&env, "EXTRA").as_deref(), Some("1"));
    assert_eq!(value_of(&env, "GONE"), None);
    assert_eq!(
        composed.script_reports[1].set,
        vec![("GONE".to_owned(), false)]
    );
}

#[test]
fn an_overlay_whose_digest_is_not_allowed_runs_no_script() {
    let one = manifest(json!({"env_scripts": [script("env/a.sh")]}));
    for allowed in [
        None,
        Some("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ] {
        let active = [(&one, facts("one", allowed))];
        let mut called = 0;
        let mut run = |_: &ScriptCall<'_>| -> ScriptResult {
            called += 1;
            Ok(b"{\"X\": \"1\"}".to_vec())
        };
        let composed = composed_environment_running(
            &active,
            Environment::default(),
            &BTreeMap::new(),
            &mut Vec::new(),
            &mut run,
        );
        assert_eq!(called, 0);
        assert!(composed.script_reports.is_empty());
        assert_eq!(value_of(&composed.env.expect("built"), "X"), None);
    }
}

#[test]
fn a_run_that_gives_nothing_applies_nothing_and_is_reported() {
    let one = manifest(json!({"env_scripts": [
        script("env/a.sh"),
        script("env/b.sh"),
    ]}));
    let cases: [(ScriptResult, ScriptFailure); 6] = [
        (Err(ScriptFailure::NotRun), ScriptFailure::NotRun),
        (Err(ScriptFailure::Timeout), ScriptFailure::Timeout),
        (Err(ScriptFailure::Exit), ScriptFailure::Exit),
        (Err(ScriptFailure::TooLarge), ScriptFailure::TooLarge),
        (Ok(b"not json".to_vec()), ScriptFailure::Output),
        // A reserved name, which the root variables are.
        (
            Ok(br#"{"ONE_OVERLAY_ROOT": "/elsewhere"}"#.to_vec()),
            ScriptFailure::Output,
        ),
    ];
    for (result, failure) in cases {
        let active = [(
            &one,
            facts(
                "one",
                Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            ),
        )];
        let mut run = |call: &ScriptCall<'_>| -> ScriptResult {
            if call.index == 0 {
                result.clone()
            } else {
                Ok(b"{\"AFTER\": \"yes\"}".to_vec())
            }
        };
        let composed = composed_environment_running(
            &active,
            Environment::default(),
            &BTreeMap::new(),
            &mut Vec::new(),
            &mut run,
        );
        let env = composed
            .env
            .expect("a failed script does not fail the stack");
        assert_eq!(composed.script_reports[0].failure, Some(failure));
        assert!(composed.script_reports[0].set.is_empty());
        // The next script still runs.
        assert_eq!(composed.script_reports[1].failure, None);
        assert_eq!(value_of(&env, "AFTER").as_deref(), Some("yes"));
        assert_eq!(
            value_of(&env, "ONE_OVERLAY_ROOT").as_deref(),
            Some("/srv/ov/one")
        );
    }
}

#[test]
fn an_output_past_the_bound_is_too_large() {
    let one = manifest(json!({"env_scripts": [script("env/a.sh")]}));
    let mut facts = facts(
        "one",
        Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    );
    facts.settings = facts.settings.hook_output_bytes(coqui_aos::Limit::at(8));
    let active = [(&one, facts)];
    let mut run = |_: &ScriptCall<'_>| -> ScriptResult { Ok(b"{\"A\": \"123456\"}".to_vec()) };
    let composed = composed_environment_running(
        &active,
        Environment::default(),
        &BTreeMap::new(),
        &mut Vec::new(),
        &mut run,
    );
    assert_eq!(
        composed.script_reports[0].failure,
        Some(ScriptFailure::TooLarge)
    );
    assert_eq!(value_of(&composed.env.expect("built"), "A"), None);
}

#[test]
fn a_sensitive_variable_is_reported_and_no_value_is() {
    let one = manifest(json!({"env_scripts": [script("env/a.sh")]}));
    let active = [(
        &one,
        facts(
            "one",
            Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        ),
    )];
    let mut run =
        |_: &ScriptCall<'_>| -> ScriptResult { Ok(b"{\"LD_PRELOAD\": \"/x.so\"}".to_vec()) };
    let mut non_defaults = Vec::new();
    let composed = composed_environment_running(
        &active,
        Environment::default(),
        &BTreeMap::new(),
        &mut non_defaults,
        &mut run,
    );
    assert_eq!(
        value_of(&composed.env.expect("built"), "LD_PRELOAD").as_deref(),
        Some("/x.so")
    );
    assert!(
        non_defaults
            .iter()
            .any(|each| each.id.as_str() == "env-sensitive" && each.subject == "LD_PRELOAD"),
        "{non_defaults:?}"
    );
    assert!(!format!("{non_defaults:?}").contains("/x.so"));
}

#[test]
fn composed_environment_runs_no_script() {
    let one = manifest(json!({"env_scripts": [script("env/a.sh")]}));
    let active = [(
        &one,
        facts(
            "one",
            Some("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        ),
    )];
    let composed = composed_environment(
        &active,
        Environment::default(),
        &BTreeMap::new(),
        &mut Vec::new(),
    );
    assert!(composed.script_reports.is_empty());
}
