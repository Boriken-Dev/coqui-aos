//! `hooks_declared`: whether an overlay declares a hook on any OS with any interpreter.

use coqui_aos::serde_json::{Value, json};
use coqui_aos::{Document, INTERPRETERS, OverlayTree, hooks_declared, hooks_of};

fn manifest(value: Value) -> Document {
    value.as_object().expect("an object").clone()
}

fn tree(paths: &[&str]) -> OverlayTree {
    OverlayTree::from_paths(paths.iter().map(|path| (*path).to_owned()))
}

#[test]
fn an_overlay_with_no_hooks_declares_none() {
    assert!(!hooks_declared(&manifest(json!({})), &tree(&["SKILL.md"])));
    assert!(!hooks_declared(&manifest(json!({"hooks": {}})), &tree(&[])));
    let off: Value = [
        "pre-env",
        "session-start",
        "session-end",
        "prompt",
        "turn-end",
        "cd",
        "pre-compact",
        "pre-tool",
        "post-tool",
    ]
    .iter()
    .map(|event| ((*event).to_owned(), json!(false)))
    .collect::<coqui_aos::serde_json::Map<_, _>>()
    .into();
    assert!(!hooks_declared(
        &manifest(json!({"hooks": off})),
        &tree(&["hook.sh"])
    ));
    assert!(!hooks_declared(
        &manifest(json!({"defaults": {"hooks": false}})),
        &tree(&["hook.py"])
    ));
}

#[test]
fn a_default_script_declares_a_hook_whatever_its_os() {
    for script in ["hook.sh", "hook.bash", "hook.ps1", "hook.py", "hook.js"] {
        assert!(
            hooks_declared(&manifest(json!({})), &tree(&[script])),
            "{script}"
        );
    }
}

#[test]
fn a_table_entry_declares_a_hook() {
    assert!(hooks_declared(
        &manifest(json!({"hooks": {"pre-tool": {"run": "guard.py"}}})),
        &tree(&["guard.py"])
    ));
    assert!(hooks_declared(
        &manifest(json!({"hooks": {"prompt": "guard.ps1"}})),
        &tree(&["guard.ps1"])
    ));
}

#[test]
fn it_agrees_with_hooks_of_on_every_os() {
    let cases = [
        (json!({}), vec!["hook.ps1"]),
        (json!({"hooks": {"cd": {"run": "x.sh"}}}), vec![]),
        (json!({"hooks": {"cd": false}}), vec!["hook.sh"]),
    ];
    let interpreters: Vec<String> = INTERPRETERS.iter().map(|name| (*name).to_owned()).collect();
    for (value, paths) in cases {
        let manifest = manifest(value);
        let tree = tree(&paths);
        let any = ["windows", "linux", "macos"].iter().any(|os| {
            let (hooks, not_run) = hooks_of(&manifest, &tree, os, &interpreters);
            !hooks.is_empty() || !not_run.is_empty()
        });
        assert_eq!(hooks_declared(&manifest, &tree), any, "{manifest:?}");
    }
}
