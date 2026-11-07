//! `hooks.json`: which hooks an overlay has and whether they are on, what each event's hook is
//! told, what of its output applies, and which calls a `match` selects.

mod support;

use coqui_aos::{
    Hook, HookEvent, HookFacts, HookRun, HookScope, Limit, OnFailure, OverlayTree, Settings,
    fire_event, hook_matches, hook_payload, hook_plan, hook_result, read_overlay, validate,
};
use serde_json::{Map, Value, json};
use support::{object, run, strings};

fn event_of(case: &Value) -> HookEvent {
    HookEvent::named(case["event"].as_str().expect("event")).expect("a known event")
}

fn settings_of(limits: &Value) -> Settings {
    let mut settings = Settings::default();
    let limit = |key: &str| limits[key].as_u64().map(Limit::at);
    if let Some(value) = limit("timeout") {
        settings = settings.hook_timeout(value);
    }
    if let Some(value) = limit("event_timeout") {
        settings = settings.hook_event_timeout(value);
    }
    if let Some(value) = limit("max_output") {
        settings = settings.hook_output_bytes(value);
    }
    if let Some(value) = limit("max_payload") {
        settings = settings.hook_payload_bytes(value);
    }
    settings
}

fn hook_json(hook: &Hook) -> Value {
    json!({"event": hook.event.as_str(), "path": hook.path, "interpreter": hook.interpreter,
           "runs": hook.runs, "match": hook.select, "sets": hook.sets, "timeout": hook.timeout,
           "on_failure": match hook.on_failure { OnFailure::Refuse => "refuse", _ => "report" },
           "payload": hook.payload})
}

fn plan_case(case: &Value) -> Result<(), String> {
    let facts = &case["facts"];
    let tree = match facts["files"].clone() {
        Value::Array(paths) => OverlayTree::from_paths(
            paths
                .iter()
                .map(|path| path.as_str().expect("a path").to_owned()),
        ),
        Value::Object(texts) => OverlayTree::from_texts(
            texts
                .iter()
                .map(|(path, text)| (path.clone(), text.as_str().expect("text").to_owned())),
        ),
        _ => OverlayTree::default(),
    };
    let settings = settings_of(&facts["limits"]);
    let manifest = match case.get("manifest") {
        Some(manifest) => object(manifest),
        None => {
            read_overlay(&tree, &Settings::default())
                .map_err(|error| error.to_string())?
                .manifest
        }
    };
    let mut known = HookFacts::new(
        facts["os"].as_str().expect("os"),
        facts["identity"].as_str().unwrap_or_default(),
    );
    known.interpreters = facts.get("interpreters").map(strings);
    known.scope = match facts["scope"].as_str() {
        Some("user") => HookScope::User,
        Some("project") => HookScope::Project,
        _ => HookScope::Overlay,
    };
    known.digest = facts["digest"].as_str().map(str::to_owned);
    known.allowed = facts["allowed"].as_str().map(str::to_owned);
    known.tree = facts["tree"].as_object().map(|tree| {
        tree.iter()
            .map(|(path, text)| {
                (
                    path.clone(),
                    text.as_str().expect("text").as_bytes().to_vec(),
                )
            })
            .collect()
    });
    let events = |key: &str| -> Option<Vec<HookEvent>> {
        facts.get(key).map(|list| {
            strings(list)
                .iter()
                .map(|name| HookEvent::named(name).expect("an event"))
                .collect()
        })
    };
    known.fires = events("fires");
    known.partial = events("partial").unwrap_or_default();
    known.timeout = facts["limits"]["timeout"].as_u64();
    let plan = hook_plan(&manifest, &tree, &known, &settings).map_err(|error| error.to_string())?;
    let pairs = |list: &[(String, String)]| -> Vec<Value> {
        list.iter().map(|(a, b)| json!([a, b])).collect()
    };
    let expect = &case["expect"];
    let mut got = json!({
        "hooks": plan.hooks.iter().map(hook_json).collect::<Vec<_>>(),
        "on": plan.on, "activates": plan.activates, "needs": plan.needs,
        "reports": pairs(&plan.reports), "non_defaults": pairs(&plan.non_defaults),
    });
    if expect.get("issues").is_some() {
        got["issues"] = json!(
            validate(&manifest, Some(&tree))
                .into_iter()
                .map(|issue| issue.at)
                .collect::<Vec<_>>()
        );
    }
    (got == *expect).then_some(()).ok_or(format!("{got}"))
}

fn env_json(env: &[(String, Option<String>)]) -> Value {
    Value::Object(
        env.iter()
            .map(|(name, value)| {
                (
                    name.clone(),
                    value.clone().map_or(Value::Null, Value::String),
                )
            })
            .collect::<Map<_, _>>(),
    )
}

fn output_case(case: &Value) -> Result<(), String> {
    let limits = &case["limits"];
    let hook = support::hook_run(&case["run"]);
    let expect = &case["expect"];
    match hook_result(event_of(case), &hook, &settings_of(limits)) {
        Ok(output) => {
            let mut got = Map::new();
            if let Some(decision) = output.decision {
                got.insert("decision".into(), json!(decision.as_str()));
            }
            if let Some(reason) = &output.reason {
                got.insert("reason".into(), json!(reason));
            }
            if let Some(context) = &output.context {
                got.insert("context".into(), json!(context));
            }
            if let Some(env) = &output.env {
                got.insert("env".into(), env_json(env));
            }
            let got = json!({"output": got});
            (got == *expect).then_some(()).ok_or(format!("{got}"))
        }
        Err(failure) => (expect["failed"] == failure.as_str())
            .then_some(())
            .ok_or(format!("failed {}, expected {expect}", failure.as_str())),
    }
}

fn event_case(case: &Value) -> Result<(), String> {
    let runs: Vec<HookRun> = case["runs"]
        .as_array()
        .expect("runs")
        .iter()
        .map(support::hook_run)
        .collect();
    let applies = case.get("applies").map(strings);
    let applies: Option<Vec<&str>> = applies
        .as_ref()
        .map(|list| list.iter().map(String::as_str).collect());
    let windows = case["os"].as_str() == Some("windows");
    let fired = fire_event(
        event_of(case),
        &runs,
        applies.as_deref(),
        &settings_of(&case["limits"]),
        windows,
    );
    let got = json!({
        "ran": fired.ran,
        "decision": fired.decision.map(|decision| decision.as_str()),
        "by": fired.by,
        "reason": fired.reason,
        "context": fired.context.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>(),
        "env": env_json(&fired.env),
        "reports": fired.reports.iter().map(|report| {
            let mut row = vec![json!(report.id)];
            row.extend(report.about.iter().map(|part| json!(part)));
            Value::Array(row)
        }).collect::<Vec<_>>(),
        "non_defaults": fired.non_defaults.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>(),
    });
    (got == case["expect"])
        .then_some(())
        .ok_or(format!("{got}"))
}

#[test]
fn hooks() {
    run(
        "hooks.json",
        |case| {
            let id = case["id"].as_str().expect("id");
            if id.starts_with("plan-") {
                plan_case(case)
            } else if id.starts_with("payload-") {
                let got = Value::Object(hook_payload(event_of(case), &object(&case["known"])));
                (got == case["expect"])
                    .then_some(())
                    .ok_or(format!("{got}"))
            } else if id.starts_with("output-") {
                output_case(case)
            } else if id.starts_with("event-") {
                event_case(case)
            } else {
                let select = case["match"].as_array().map(|_| strings(&case["match"]));
                let got = hook_matches(
                    event_of(case),
                    select.as_deref(),
                    case["value"].as_str().expect("value"),
                );
                (json!({"runs": got}) == case["expect"])
                    .then_some(())
                    .ok_or(format!("{got}"))
            }
        },
        support::none,
    );
}
