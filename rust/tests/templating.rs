//! The templating functions beyond the vectors: a sensitive option's value given by the user and
//! the front matter of a context file.

use coqui_aos::{
    Class, Document, Settings, TemplateFacts, context_text, skill_text, template, template_values,
};
use serde_json::{Value, json};

fn manifest() -> Document {
    let Value::Object(map) = json!({
        "options": {
            "depth": {"type": "string", "default": "normal"},
            "token": {"type": "string", "sensitive": true}
        }
    }) else {
        unreachable!()
    };
    map
}

fn facts() -> TemplateFacts {
    let Value::Object(options) = json!({"token": "s3cret", "depth": "deep"}) else {
        unreachable!()
    };
    TemplateFacts::new()
        .root("/o/team")
        .name("team")
        .options(options)
}

#[test]
fn a_sensitive_option_stays_as_written_even_with_a_configured_value() {
    let values = template_values(&manifest(), &facts()).expect("values");
    assert_eq!(values.get("token"), None);
    let text = template("${token} ${depth} ${AOS_OVERLAY_ROOT}", &values);
    assert_eq!(text, "${token} deep /o/team");
}

#[test]
fn a_wrong_typed_configured_value_is_refused() {
    let Value::Object(options) = json!({"depth": 3}) else {
        unreachable!()
    };
    let error =
        template_values(&manifest(), &TemplateFacts::new().options(options)).expect_err("refused");
    assert_eq!(error.class, Class::InvalidOption);
    assert_eq!(error.subject, "depth");
}

#[test]
fn context_drops_front_matter_and_a_skill_keeps_it() {
    let values = template_values(&manifest(), &facts()).expect("values");
    let file = b"---\nk: ${name}\n---\nroot ${AOS_OVERLAY_ROOT}\n";
    let settings = Settings::default();
    assert_eq!(
        context_text(file, &values, &settings).expect("text"),
        "root /o/team\n"
    );
    assert_eq!(
        skill_text(file, &values, &settings).expect("text"),
        "---\nk: ${name}\n---\nroot /o/team\n"
    );
}
