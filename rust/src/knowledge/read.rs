//! `kb_read`: which file, its text rendered when it is a template, and which lines of it.

use alloc::collections::BTreeMap;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use serde_json::{Map, Value, json};

use super::mustache::mustache;
use super::settings::KnowledgeSettings;
use super::text::{inert, knowledge_lines, needs_writing_out};
use super::tree::{Engine, KnowledgeEntry, KnowledgeOverlay, ServedFile, SkipReason};
use super::{ErrorClass, KnowledgeError};
use crate::front_matter::split_front_matter;
use crate::names::{is_sensitive_variable, normalize_name, valid_relative_path};
use crate::template::{template, template_values, value_is};

/// What a template knows of the call's caller: the role and profile the consumer has the agent
/// in, as its own labels, and the environment variables the user allowed templates to read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct CallerFacts {
    /// The role, as the consumer labels it.
    pub role: Option<String>,
    /// The profile in use, likewise.
    pub profile: Option<String>,
    /// The consumer's environment.
    pub env: BTreeMap<String, String>,
    /// The names of the variables the user allowed templates to read. A sensitive variable is
    /// never given, though it is named here.
    pub env_allow: Vec<String>,
}

impl CallerFacts {
    /// Facts with no role, no profile and no variable.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the role.
    #[must_use]
    pub fn role(mut self, role: impl Into<String>) -> Self {
        self.role = Some(role.into());
        self
    }

    /// Sets the profile.
    #[must_use]
    pub fn profile(mut self, profile: impl Into<String>) -> Self {
        self.profile = Some(profile.into());
        self
    }

    /// Sets a variable of the environment.
    #[must_use]
    pub fn env(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(name.into(), value.into());
        self
    }

    /// Allows templates to read the variable `name`.
    #[must_use]
    pub fn allow(mut self, name: impl Into<String>) -> Self {
        self.env_allow.push(name.into());
        self
    }

    fn allowed(&self) -> BTreeMap<&str, &str> {
        self.env_allow
            .iter()
            .filter(|name| !is_sensitive_variable(name))
            .filter_map(|name| {
                self.env
                    .get(name)
                    .map(|value| (name.as_str(), value.as_str()))
            })
            .collect()
    }
}

pub(crate) fn error(class: ErrorClass, message: impl Into<String>) -> KnowledgeError {
    KnowledgeError::new(class, message)
}

/// The overlays an `overlay` argument names: all of them, or the one it names.
pub(crate) fn choose<'a>(
    overlays: &'a [KnowledgeOverlay],
    wanted: Option<&str>,
) -> Result<Vec<&'a KnowledgeOverlay>, KnowledgeError> {
    let Some(wanted) = wanted else {
        return Ok(overlays.iter().collect());
    };
    let normal = normalize_name(wanted);
    let chosen: Vec<_> = overlays
        .iter()
        .filter(|overlay| normalize_name(&overlay.identity) == normal)
        .collect();
    if chosen.is_empty() {
        return Err(error(ErrorClass::UnknownOverlay, wanted));
    }
    Ok(chosen)
}

fn render(
    overlay: &KnowledgeOverlay,
    file: &ServedFile<'_>,
    engine: Engine,
    context: &Map<String, Value>,
    caller: &CallerFacts,
    settings: &KnowledgeSettings,
) -> Result<String, KnowledgeError> {
    let mut facts = overlay.facts.clone();
    if facts.name.is_none() {
        facts.name = Some(normalize_name(&overlay.identity));
    }
    let split = split_front_matter(file.raw, &overlay.reading);
    let body = core::str::from_utf8(split.body(file.raw))
        .map_err(|_| error(ErrorClass::NotText, "the body"))?;
    let values = template_values(&overlay.manifest, &facts)
        .map_err(|failure| error(ErrorClass::InvalidOption, failure.subject))?;
    let env = caller.allowed();
    let out = match engine {
        Engine::Envsubst => {
            let mut values = values;
            for (name, value) in [
                ("AOS_CALLER_ROLE", &caller.role),
                ("AOS_CALLER_PROFILE", &caller.profile),
            ] {
                if let Some(value) = value {
                    values = values.with(name, value.as_str());
                }
            }
            for (name, value) in &env {
                values = values.with(alloc::format!("AOS_ENV_{name}"), *value);
            }
            for (key, value) in context {
                let text = match value {
                    Value::Bool(flag) => flag.to_string(),
                    Value::Number(number) => number.to_string(),
                    Value::String(text) => text.clone(),
                    _ => continue,
                };
                values = values.with(alloc::format!("AOS_ARG_{key}"), text);
            }
            template(body, &values)
        }
        Engine::Mustache => {
            let mut options = Map::new();
            let configured = &facts.options;
            if let Some(declared) = overlay.manifest.get("options").and_then(Value::as_object) {
                for (name, entry) in declared {
                    let Some(entry) = entry.as_object() else {
                        continue;
                    };
                    if entry.get("sensitive") == Some(&Value::Bool(true)) {
                        continue;
                    }
                    if let Some(value) = configured.get(name) {
                        let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
                        if !value_is(kind, value) {
                            return Err(error(ErrorClass::InvalidOption, name.as_str()));
                        }
                        options.insert(name.clone(), value.clone());
                    } else if let Some(default) = entry.get("default") {
                        options.insert(name.clone(), default.clone());
                    }
                }
            }
            let mut overlay_facts = Map::new();
            for (key, value) in [
                ("root", &facts.root),
                ("state", &facts.state),
                ("name", &facts.name),
                ("scope", &facts.scope),
            ] {
                if let Some(value) = value {
                    overlay_facts.insert(key.into(), json!(value));
                }
            }
            let mut caller_facts = Map::new();
            for (key, value) in [("role", &caller.role), ("profile", &caller.profile)] {
                if let Some(value) = value {
                    caller_facts.insert(key.into(), json!(value));
                }
            }
            let data = json!({
                "overlay": overlay_facts,
                "project": facts.project.as_ref().map_or_else(|| json!({}), |root| json!({"root": root})),
                "caller": caller_facts,
                "env": env,
                "options": options,
                "context": context,
            });
            mustache(body, &data, settings)?
        }
    };
    if !settings.max_rendered_bytes.allows(out.len()) {
        return Err(error(ErrorClass::TooLarge, "the rendered text"));
    }
    Ok(out)
}

fn skip_class(reason: SkipReason) -> ErrorClass {
    match reason {
        SkipReason::Name => ErrorClass::InvalidPath,
        SkipReason::TooLarge => ErrorClass::TooLarge,
        SkipReason::NotText => ErrorClass::NotText,
        SkipReason::Template => ErrorClass::UnknownTemplate,
    }
}

/// The order of priority of the classes more than one overlay could answer with.
fn priority(class: ErrorClass) -> usize {
    [
        ErrorClass::Link,
        ErrorClass::NotText,
        ErrorClass::TooLarge,
        ErrorClass::UnknownTemplate,
        ErrorClass::NotFound,
    ]
    .iter()
    .position(|other| *other == class)
    .unwrap_or(usize::MAX)
}

pub(crate) fn path_problem(path: &str) -> bool {
    !valid_relative_path(path) || needs_writing_out(path)
}

fn linked(overlay: &KnowledgeOverlay, path: &str) -> bool {
    let mut end = 0;
    for part in path.split('/') {
        end += part.len();
        if matches!(
            overlay.tree.get(&path[..end]),
            Some(KnowledgeEntry::Symlink)
        ) {
            return true;
        }
        end += 1;
    }
    false
}

/// The result of a `kb_read` whose arguments were checked.
pub(crate) fn read(
    overlays: &[KnowledgeOverlay],
    arguments: &Map<String, Value>,
    settings: &KnowledgeSettings,
    caller: &CallerFacts,
) -> Result<Value, KnowledgeError> {
    let path = arguments["path"].as_str().unwrap_or_default();
    if path_problem(path) {
        return Err(error(ErrorClass::InvalidPath, inert(path)));
    }
    let wanted = arguments.get("overlay").and_then(Value::as_str);
    let mut found = Vec::new();
    let mut problems = Vec::new();
    let sets: Vec<_> = choose(overlays, wanted)?
        .into_iter()
        .map(|overlay| (overlay, overlay.set(settings)))
        .collect();
    for (overlay, set) in &sets {
        if linked(overlay, path) {
            problems.push(ErrorClass::Link);
        } else if let Some(file) = set.files.get(path) {
            found.push((*overlay, *file));
        } else {
            problems.push(set.skip_of(path).map_or(ErrorClass::NotFound, skip_class));
        }
    }
    if found.len() > 1 {
        return Err(error(
            ErrorClass::Ambiguous,
            "more than one overlay has that path",
        ));
    }
    let Some((overlay, file)) = found.pop() else {
        let class = problems
            .into_iter()
            .min_by_key(|class| priority(*class))
            .unwrap_or(ErrorClass::NotFound);
        return Err(error(class, inert(path)));
    };
    let empty = Map::new();
    let rendered;
    let text = if let Some(engine) = file.engine {
        let context = arguments
            .get("context")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        rendered = render(overlay, &file, engine, context, caller, settings)?;
        rendered.as_str()
    } else {
        file.text
    };
    let lines = knowledge_lines(text);
    let total = lines.len();
    let start = arguments.get("from").and_then(Value::as_u64).unwrap_or(1);
    let stop = arguments.get("to").and_then(Value::as_u64);
    let start_index = usize::try_from(start).unwrap_or(usize::MAX);
    if stop.is_some_and(|stop| stop < start) || start_index > total.max(1) {
        return Err(error(
            ErrorClass::LineRange,
            alloc::format!("the file has {total} lines"),
        ));
    }
    let last = stop.map_or(total, |stop| {
        usize::try_from(stop).unwrap_or(usize::MAX).min(total)
    });
    let mut chosen: Vec<&str> = Vec::new();
    let mut size = 0usize;
    let mut truncated = false;
    for line in lines.iter().take(last).skip(start_index - 1) {
        let add = line.len() + usize::from(!chosen.is_empty());
        if !chosen.is_empty() && !settings.max_read_bytes.allows(size + add) {
            truncated = true;
            break;
        }
        chosen.push(line);
        size += add;
    }
    let mut result = json!({
        "overlay": overlay.identity,
        "path": path,
        "from_line": start,
        "to_line": start - 1 + chosen.len() as u64,
        "total_lines": total,
        "truncated": truncated,
        "text": inert(&chosen.join("\n")),
    });
    if let Some(engine) = file.engine {
        result["template"] = json!(engine.as_str());
    }
    Ok(result)
}
