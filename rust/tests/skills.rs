//! `skills.json`: where the skills of the active overlays come from, and the check of a skill that
//! was fetched; and the caller-supplied source a plan is fetched through.

mod support;

use std::collections::BTreeMap;

use coqui_aos::{
    Catalog, Class, Document, Error, OverlayTree, Settings, SkillSource, Source, fetch_planned,
    read_catalog, read_fetched_skill, resolve_skills,
};
use serde_json::{Value, json};
use support::{object, run, strings};

fn trees(case: &Value) -> BTreeMap<String, OverlayTree> {
    case["files"]
        .as_object()
        .map(|files| {
            files
                .iter()
                .map(|(identity, files)| {
                    let tree = match files {
                        Value::Array(paths) => OverlayTree::from_paths(
                            paths
                                .iter()
                                .map(|path| path.as_str().expect("a path").to_owned()),
                        ),
                        Value::Object(texts) => {
                            OverlayTree::from_texts(texts.iter().map(|(path, text)| {
                                (path.clone(), text.as_str().expect("text").to_owned())
                            }))
                        }
                        _ => OverlayTree::default(),
                    };
                    (identity.clone(), tree)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn pairs(list: &[(String, String)]) -> Vec<Value> {
    list.iter().map(|(a, b)| json!([a, b])).collect()
}

fn resolve_case(case: &Value) -> Result<(), String> {
    let settings = Settings::default();
    let overlays: BTreeMap<String, Document> = case["overlays"]
        .as_object()
        .expect("overlays")
        .iter()
        .map(|(identity, manifest)| (identity.clone(), object(manifest)))
        .collect();
    let read: Vec<(String, Catalog)> = case["catalogs"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            (
                item["label"].as_str().expect("label").to_owned(),
                read_catalog(
                    item["text"].as_str().expect("text").as_bytes(),
                    item["name"].as_str().expect("name"),
                    item["base"].as_str(),
                    &settings,
                )
                .expect("a catalog"),
            )
        })
        .collect();
    let catalogs: Vec<(&str, &Catalog)> = read.iter().map(|(l, c)| (l.as_str(), c)).collect();
    let order = strings(&case["order"]);
    let order: Vec<&str> = order.iter().map(String::as_str).collect();
    let fetches = case["fetches"].as_bool().unwrap_or(true);
    let plan = resolve_skills(
        &overlays,
        &strings(&case["requested"]),
        &trees(case),
        &catalogs,
        &order,
        fetches,
        &settings,
    )
    .map_err(|error| error.to_string())?;
    let skills: Vec<Value> = plan
        .skills
        .iter()
        .map(|skill| {
            let mut out = json!({"name": skill.name, "origin": skill.origin.as_str(),
                                 "overlay": skill.overlay});
            for (key, value) in [
                ("source", &skill.source),
                ("pin", &skill.pin),
                ("catalog", &skill.catalog),
            ] {
                if let Some(value) = value {
                    out[key] = json!(value);
                }
            }
            if let Some(labels) = &skill.catalogs {
                out["catalogs"] = json!(labels);
            }
            out
        })
        .collect();
    let got = json!({
        "skills": skills,
        "missing": pairs(&plan.missing),
        "ambiguous": plan.ambiguous.iter().map(|(a, b, c)| json!([a, b, c])).collect::<Vec<_>>(),
        "unpinned": pairs(&plan.unpinned),
        "non_defaults": plan.non_defaults.iter().map(|(a, b, c)| json!([a, b, c])).collect::<Vec<_>>(),
        "not_fetched": pairs(&plan.not_fetched),
        "name_mismatch": pairs(&plan.name_mismatch),
        "shadowing": pairs(&plan.shadowing),
        "delivered": plan.delivered,
        "collisions": plan.collisions,
    });
    (got == case["expect"])
        .then_some(())
        .ok_or(format!("{got}"))
}

fn fetched_case(case: &Value) -> Result<(), String> {
    let files: Vec<(String, Vec<u8>)> = case["fetched"]
        .as_object()
        .expect("fetched")
        .iter()
        .map(|(path, content)| {
            let bytes = match content.get("base64").and_then(Value::as_str) {
                Some(encoded) => support::decode(encoded),
                None => content.as_str().expect("text").as_bytes().to_vec(),
            };
            (path.clone(), bytes)
        })
        .collect();
    let expect = &case["expect"];
    match read_fetched_skill(
        case["name"].as_str().expect("name"),
        &files,
        case["pin"].as_str(),
        &support::settings_of(case),
    ) {
        Ok(read) => {
            let got = json!({"digest": read.digest.to_string(), "reported": read.reported});
            (got == *expect).then_some(()).ok_or(format!("{got}"))
        }
        Err(error) => (support::expected_errors(expect)
            .iter()
            .any(|class| class == error.class.as_str()))
        .then_some(())
        .ok_or(format!("refused {error}, expected {expect}")),
    }
}

#[test]
fn skills_from_elsewhere() {
    run(
        "skills.json",
        |case| {
            if case.get("fetched").is_some() {
                fetched_case(case)
            } else {
                resolve_case(case)
            }
        },
        support::none,
    );
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
