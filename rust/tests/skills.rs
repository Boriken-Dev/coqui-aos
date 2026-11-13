//! The caller-supplied source a skills plan is fetched through.

use std::collections::BTreeMap;

use coqui_aos::{
    Class, Document, Error, Settings, SkillSource, Source, fetch_planned, read_fetched_skill,
    resolve_skills,
};
use serde_json::{Value, json};

fn object(value: &Value) -> Document {
    value.as_object().expect("an object").clone()
}

/// A source that serves skills from memory, and records what it was asked for.
struct Memory(BTreeMap<String, Vec<(String, Vec<u8>)>>);

impl SkillSource for Memory {
    fn fetch(&self, source: &Source) -> Result<Vec<(String, Vec<u8>)>, Error> {
        self.0
            .get(&source.shown())
            .cloned()
            .ok_or_else(|| Error::new(Class::Io, "no such source"))
    }
}

#[test]
fn a_plan_is_fetched_through_the_callers_source_and_checked_against_its_pins() {
    let skill = b"---\nname: review\ndescription: Reviews.\n---\nBody.\n".to_vec();
    let digest = read_fetched_skill(
        "review",
        &[("SKILL.md".to_owned(), skill.clone())],
        None,
        &Settings::default(),
    )
    .expect("a skill")
    .digest
    .to_string();
    let overlays: BTreeMap<String, Document> = BTreeMap::from([(
        "a".to_owned(),
        object(&json!({"skills": [
            {"name": "review", "source": "https://example.org/skills.git#review", "pin": digest},
            {"name": "lint", "source": "https://example.org/skills.git#lint", "pin": digest},
            {"name": "gone", "source": "https://example.org/skills.git#gone"},
        ]})),
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
    assert_eq!(plan.to_fetch.len(), 3);
    let source = Memory(BTreeMap::from([
        (
            "https://example.org/skills.git#review".to_owned(),
            vec![("SKILL.md".to_owned(), skill.clone())],
        ),
        (
            "https://example.org/skills.git#lint".to_owned(),
            vec![("SKILL.md".to_owned(), b"---\nname: lint\n---\n".to_vec())],
        ),
    ]));
    let got = fetch_planned(&plan, &source, &Settings::default());
    let outcome = |name: &str| {
        got.iter()
            .find(|item| item.name == name)
            .map(|item| {
                item.outcome
                    .as_ref()
                    .map(|_| ())
                    .map_err(|error| error.class.as_str())
            })
            .expect("fetched")
    };
    assert_eq!(outcome("review"), Ok(()));
    assert_eq!(outcome("lint"), Err("pin-mismatch"));
    assert_eq!(outcome("gone"), Err("io"));
}

#[test]
fn a_consumer_that_does_not_fetch_is_asked_for_nothing() {
    let overlays: BTreeMap<String, Document> = BTreeMap::from([(
        "a".to_owned(),
        object(&json!({"skills": [{"name": "x", "source": "https://example.org/x.git"}]})),
    )]);
    let plan = resolve_skills(
        &overlays,
        &["a".to_owned()],
        &BTreeMap::new(),
        &[],
        &[],
        false,
        &Settings::default(),
    )
    .expect("a plan");
    assert!(plan.to_fetch.is_empty());
    assert_eq!(plan.not_fetched.len(), 1);
}
