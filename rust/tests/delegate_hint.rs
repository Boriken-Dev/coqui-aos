//! A harness's `delegate` hint, read from a manifest.

use coqui_aos::{DelegateHint, Document, harness_delegate_of, validate};
use serde_json::{Value, json};

fn object(value: &Value) -> Document {
    value.as_object().expect("an object").clone()
}

#[test]
fn a_hint_with_every_key_is_read_and_valid() {
    let manifest = object(&json!({"harness": {"codex": {"delegate": {
        "default": "Claude", "sources": ["Claude", "Pi"], "max_running": 4
    }}}}));
    assert!(validate(&manifest, None).is_empty());
    let hint = harness_delegate_of(&manifest, "codex").expect("a hint");
    assert_eq!(hint.default.as_deref(), Some("Claude"));
    assert_eq!(
        hint.sources,
        Some(vec!["Claude".to_owned(), "Pi".to_owned()])
    );
    assert_eq!(hint.max_running, Some(4));
}

#[test]
fn a_key_left_out_is_none_and_an_empty_list_is_kept() {
    let manifest = object(&json!({"harness": {"codex": {"delegate": {"sources": []}}}}));
    let hint = harness_delegate_of(&manifest, "codex").expect("a hint");
    assert_eq!(hint.default, None);
    assert_eq!(hint.sources, Some(Vec::new()));
    assert_eq!(hint.max_running, None);
}

#[test]
fn no_hint_is_none() {
    let manifest = object(&json!({"harness": {"codex": {"skills": false}}}));
    assert_eq!(harness_delegate_of(&manifest, "codex"), None);
    assert_eq!(harness_delegate_of(&manifest, "claude-code"), None);
    assert_eq!(harness_delegate_of(&Document::new(), "codex"), None);
    let empty: DelegateHint = DelegateHint::default();
    assert_eq!(empty.max_running, None);
}

#[test]
fn a_float_limit_is_integer_required() {
    let manifest = object(&json!({"harness": {"codex": {"delegate": {"max_running": 4.0}}}}));
    let issues = validate(&manifest, None);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].at, "/harness/codex/delegate/max_running");
    assert_eq!(issues[0].code.as_str(), "integer-required");
}
