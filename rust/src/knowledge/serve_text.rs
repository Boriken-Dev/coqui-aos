//! The text `kb_read` serves for a file, before it is cut into lines: as written, expanded
//! (`${NAME}` and `@path`), rendered by an engine, or kept with the context of an engine this
//! server does not render.

use alloc::collections::BTreeMap;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use serde_json::{Map, Value, json};

use super::mustache::mustache;
use super::read::CallerFacts;
use super::settings::KnowledgeSettings;
use super::tree::{Engine, FileFormat, KnowledgeOverlay, KnowledgeSet, ServedFile};
use super::{ErrorClass, KnowledgeError};
use crate::front_matter::{SplitCase, split_front_matter};
use crate::names::{is_sensitive_variable, normalize_name, valid_relative_path};
use crate::template::{Template, template, template_values, value_is};

fn error(class: ErrorClass, message: &str) -> KnowledgeError {
    KnowledgeError::new(class, message)
}

fn rendered_too_large() -> KnowledgeError {
    error(ErrorClass::TooLarge, "the rendered text")
}

/// What a call reads: the overlay, its set and the facts of the call.
pub(crate) struct Call<'a> {
    pub overlay: &'a KnowledgeOverlay,
    pub set: &'a KnowledgeSet<'a>,
    pub context: &'a Map<String, Value>,
    pub caller: &'a CallerFacts,
    pub settings: &'a KnowledgeSettings,
    pub engines: &'a [Engine],
}

struct Walk<'a> {
    call: &'a Call<'a>,
    values: Option<Template>,
    added: usize,
}

/// What a template reads: the roots `overlay`, `project`, `caller`, `env`, `options` and
/// `context`, each only with what it holds. A sensitive option or variable is never in it.
fn data(call: &Call<'_>) -> Result<Value, KnowledgeError> {
    let overlay = call.overlay;
    let mut facts = overlay.facts.clone();
    if facts.name.is_none() {
        facts.name = Some(normalize_name(&overlay.identity));
    }
    let mut options = Map::new();
    if let Some(declared) = overlay.manifest.get("options").and_then(Value::as_object) {
        for (name, entry) in declared {
            let Some(entry) = entry.as_object() else {
                continue;
            };
            if entry.get("sensitive") == Some(&Value::Bool(true)) {
                continue;
            }
            let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
            let value = facts.options.get(name).or_else(|| entry.get("default"));
            if let Some(value) = value {
                if !value_is(kind, value) {
                    return Err(error(ErrorClass::InvalidOption, name));
                }
                options.insert(name.clone(), value.clone());
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
    let mut caller = Map::new();
    for (key, value) in [
        ("role", &call.caller.role),
        ("profile", &call.caller.profile),
    ] {
        if let Some(value) = value {
            caller.insert(key.into(), json!(value));
        }
    }
    let env: Map<String, Value> = call
        .caller
        .env_allow
        .iter()
        .filter(|name| !is_sensitive_variable(name))
        .filter_map(|name| {
            call.caller
                .env
                .get(name)
                .map(|value| (name.clone(), json!(value)))
        })
        .collect();
    Ok(json!({
        "overlay": overlay_facts,
        "project": facts.project.as_ref().map_or_else(|| json!({}), |root| json!({"root": root})),
        "caller": caller,
        "env": env,
        "options": options,
        "context": call.context,
    }))
}

/// The names `${NAME}` replaces, from the data a template reads.
fn envsubst_values(call: &Call<'_>, data: &Value) -> Result<Template, KnowledgeError> {
    let mut facts = call.overlay.facts.clone();
    if facts.name.is_none() {
        facts.name = Some(normalize_name(&call.overlay.identity));
    }
    let mut values = template_values(&call.overlay.manifest, &facts)
        .map_err(|failure| error(ErrorClass::InvalidOption, &failure.subject))?;
    for (key, name) in [
        ("role", "AOS_CALLER_ROLE"),
        ("profile", "AOS_CALLER_PROFILE"),
    ] {
        if let Some(value) = data["caller"][key].as_str() {
            values = values.with(name, value);
        }
    }
    if let Some(env) = data["env"].as_object() {
        for (name, value) in env {
            values = values.with(
                alloc::format!("AOS_ENV_{name}"),
                value.as_str().unwrap_or_default(),
            );
        }
    }
    for (key, value) in call.context {
        let text = match value {
            Value::Bool(flag) => flag.to_string(),
            Value::Number(number) => number.to_string(),
            Value::String(text) => text.clone(),
            _ => continue,
        };
        values = values.with(alloc::format!("AOS_ARG_{key}"), text);
    }
    Ok(values)
}

/// A value as one line of flow YAML (JSON's shapes): keys in UTF-8 byte order, `, ` and `: ` between,
/// and in a string only the quotation mark, the backslash and U+0000-U+001F escaped.
fn flow(value: &Value, out: &mut String) {
    match value {
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&number.to_string()),
        Value::String(text) => quote(text, out),
        Value::Array(items) => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push_str(", ");
                }
                flow(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            out.push('{');
            for (at, key) in keys.into_iter().enumerate() {
                if at > 0 {
                    out.push_str(", ");
                }
                quote(key, out);
                out.push_str(": ");
                flow(&map[key], out);
            }
            out.push('}');
        }
        Value::Null => out.push_str("null"),
    }
}

fn quote(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            c if u32::from(c) < 0x20 => out.push_str(&alloc::format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The front matter a file gets when its engine is not here.
fn context_block(engine: &str, data: &Value) -> String {
    let mut out = String::from("---\naos_template_context: {\"engine\": ");
    quote(engine, &mut out);
    for root in ["overlay", "project", "caller", "env", "options", "context"] {
        if data[root].as_object().is_some_and(|map| !map.is_empty()) {
            out.push_str(&alloc::format!(", \"{root}\": "));
            flow(&data[root], &mut out);
        }
    }
    out.push_str("}\n---\n");
    out
}

fn render_engine(
    call: &Call<'_>,
    file: &ServedFile<'_>,
    engine: &str,
    here: bool,
) -> Result<String, KnowledgeError> {
    let data = data(call)?;
    let out = if !here {
        let (first, rest) = file
            .text
            .find('\n')
            .map_or((alloc::format!("{}\n", file.text), ""), |end| {
                (file.text[..=end].to_owned(), &file.text[end + 1..])
            });
        alloc::format!("{first}{}{rest}", context_block(engine, &data))
    } else if engine == "envsubst" {
        render_envsubst(file.rest, &envsubst_values(call, &data)?)
    } else {
        render_mustache(file.rest, &data, call.settings)?
    };
    if !call.settings.max_rendered_bytes.allows(out.len()) {
        return Err(rendered_too_large());
    }
    Ok(out)
}

/// Whether the engine named `name` is one this call renders.
fn renders(call: &Call<'_>, name: &str) -> bool {
    call.engines.iter().any(|engine| engine.as_str() == name)
}

/// The text `kb_read` serves for `path`, a file of the set, before it is cut into lines.
pub(crate) fn served_text(call: &Call<'_>, path: &str) -> Result<String, KnowledgeError> {
    let Some(file) = call.set.files.get(path) else {
        return Err(error(ErrorClass::NotFound, path));
    };
    match &file.format {
        FileFormat::AsWritten => Ok(file.rest.to_owned()),
        FileFormat::Engine(name) => render_engine(call, file, name, renders(call, name)),
        FileFormat::Expanded => {
            let mut walk = Walk {
                call,
                values: None,
                added: 0,
            };
            let out = walk.markdown(file.rest, path, &[path.to_owned()])?;
            if !call.settings.max_rendered_bytes.allows(out.len()) {
                return Err(error(ErrorClass::TooLarge, "the served text"));
            }
            Ok(out)
        }
    }
}

/// A fence's character and length.
fn fence_of(line: &str) -> Option<(char, usize, usize)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let mark = trimmed.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let size = trimmed.chars().take_while(|c| *c == mark).count();
    (size >= 3).then_some((mark, size, line.len() - trimmed.len() + size))
}

fn closes(line: &str, fence: (char, usize)) -> bool {
    fence_of(line).is_some_and(|(mark, size, end)| {
        mark == fence.0
            && size >= fence.1
            && line[end..].trim_matches([' ', '\t', '\r', '\n']).is_empty()
    })
}

/// Which characters of a line are in a code span: a run of backticks to the next run of as many on
/// the same line; a run with none is itself.
fn code_mask(chars: &[char]) -> Vec<bool> {
    let mut mask = alloc::vec![false; chars.len()];
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '`' {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < chars.len() && chars[j] == '`' {
            j += 1;
        }
        let mut k = j;
        let mut end = None;
        while k < chars.len() {
            if chars[k] == '`' {
                let mut m = k;
                while m < chars.len() && chars[m] == '`' {
                    m += 1;
                }
                if m - k == j - i {
                    end = Some(m);
                    break;
                }
                k = m;
            } else {
                k += 1;
            }
        }
        match end {
            None => i = j,
            Some(end) => {
                for slot in &mut mask[i..end] {
                    *slot = true;
                }
                i = end;
            }
        }
    }
    mask
}

const TRAILING: [char; 10] = ['.', ',', ';', ':', '!', '?', ')', ']', '}', '\''];

impl Walk<'_> {
    fn markdown(
        &mut self,
        text: &str,
        path: &str,
        chain: &[String],
    ) -> Result<String, KnowledgeError> {
        let mut out = String::new();
        let mut fence: Option<(char, usize)> = None;
        for line in text.split_inclusive('\n') {
            let chars: Vec<char> = line.chars().collect();
            if let Some(open) = fence {
                out.push_str(&self.line(&chars, &alloc::vec![true; chars.len()], path, chain)?);
                if closes(line, open) {
                    fence = None;
                }
                continue;
            }
            fence = fence_of(line).map(|(mark, size, _)| (mark, size));
            let mask = if fence.is_some() {
                alloc::vec![true; chars.len()]
            } else {
                code_mask(&chars)
            };
            out.push_str(&self.line(&chars, &mask, path, chain)?);
        }
        Ok(out)
    }

    fn values(&mut self) -> Result<&Template, KnowledgeError> {
        if self.values.is_none() {
            let data = data(self.call)?;
            self.values = Some(envsubst_values(self.call, &data)?);
        }
        Ok(self.values.as_ref().expect("made above"))
    }

    fn line(
        &mut self,
        chars: &[char],
        in_code: &[bool],
        path: &str,
        chain: &[String],
    ) -> Result<String, KnowledgeError> {
        let mut out = String::new();
        let mut i = 0;
        while i < chars.len() {
            if !in_code[i] && chars[i..].starts_with(&['$', '$', '{']) {
                out.push_str("${");
                i += 3;
                continue;
            }
            if !in_code[i]
                && let Some(end) = placeholder_end(chars, i)
            {
                let name: String = chars[i + 2..end - 1].iter().collect();
                if let Some(value) = self.values()?.get(&name) {
                    out.push_str(value);
                    i = end;
                    continue;
                }
            }
            if chars[i] == '@'
                && !in_code[i]
                && (i == 0 || matches!(chars[i - 1], ' ' | '\t' | '\r' | '\u{c}' | '\u{b}'))
            {
                let mut name: Vec<char> = chars[i + 1..]
                    .iter()
                    .take_while(|c| !matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{c}' | '\u{b}'))
                    .copied()
                    .collect();
                while name
                    .last()
                    .is_some_and(|c| TRAILING.contains(c) || *c == '"')
                {
                    name.pop();
                }
                let name: String = name.into_iter().collect();
                if !name.is_empty()
                    && let Some(target) = self.resolve(path, &name)
                    && let Some(text) = self.include(&target, chain)?
                {
                    out.push_str(&text);
                    i += 1 + name.chars().count();
                    continue;
                }
            }
            out.push(chars[i]);
            i += 1;
        }
        Ok(out)
    }

    /// The file of the knowledge an include names, from the including file's folder; `..` rises only
    /// to the root.
    fn resolve(&self, path: &str, name: &str) -> Option<String> {
        let first = name.chars().next()?;
        let drive = name.chars().nth(1) == Some(':') && first.is_ascii_alphabetic();
        if matches!(first, '/' | '~') || name.contains('\\') || drive {
            return None;
        }
        let mut parts: Vec<&str> = path.split('/').collect();
        parts.pop();
        for part in name.split('/') {
            match part {
                "" => return None,
                "." => {}
                ".." => {
                    parts.pop()?;
                }
                other => parts.push(other),
            }
        }
        let target = parts.join("/");
        (valid_relative_path(&target) && self.call.set.files.contains_key(target.as_str()))
            .then_some(target)
    }

    fn include(
        &mut self,
        target: &str,
        chain: &[String],
    ) -> Result<Option<String>, KnowledgeError> {
        let call = self.call;
        let file = &call.set.files[target];
        let text = match &file.format {
            FileFormat::AsWritten => file.rest.to_owned(),
            FileFormat::Engine(name) => {
                if !renders(call, name) {
                    return Ok(None);
                }
                render_engine(call, file, name, true)?
            }
            FileFormat::Expanded => {
                if chain.iter().any(|held| held == target) {
                    return Err(error(
                        ErrorClass::IncludeError,
                        &alloc::format!("an include comes back to {target}"),
                    ));
                }
                if !call.settings.max_include_depth.allows(chain.len()) {
                    return Err(error(
                        ErrorClass::IncludeError,
                        "includes are nested too deep",
                    ));
                }
                let split = split_front_matter(file.rest.as_bytes(), &call.overlay.reading);
                let body = if matches!(split.case, SplitCase::Present | SplitCase::Empty) {
                    let offset = split.body_offset.unwrap_or(0).min(file.rest.len());
                    &file.rest[offset..]
                } else {
                    file.rest
                };
                let mut deeper = chain.to_vec();
                deeper.push(target.to_owned());
                self.markdown(body, target, &deeper)?
            }
        };
        self.added += text.len();
        if !call.settings.max_rendered_bytes.allows(self.added) {
            return Err(error(ErrorClass::TooLarge, "the included text"));
        }
        let trimmed = text
            .strip_suffix("\r\n")
            .or_else(|| text.strip_suffix('\n'))
            .unwrap_or(&text);
        Ok(Some(trimmed.to_owned()))
    }
}

/// The end of a `${NAME}` that starts at `at`, when one does.
fn placeholder_end(chars: &[char], at: usize) -> Option<usize> {
    if chars.get(at) != Some(&'$') || chars.get(at + 1) != Some(&'{') {
        return None;
    }
    let mut end = at + 2;
    let first = *chars.get(end)?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    while chars
        .get(end)
        .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
    {
        end += 1;
    }
    (chars.get(end) == Some(&'}')).then_some(end + 1)
}

/// The lines of the served text of each file whose text can be made.
pub(crate) fn served_lines(call: &Call<'_>) -> BTreeMap<String, Vec<String>> {
    call.set
        .files
        .keys()
        .filter_map(|path| {
            served_text(call, path).ok().map(|text| {
                let lines = super::text::knowledge_lines(&text)
                    .into_iter()
                    .map(str::to_owned)
                    .collect();
                ((*path).to_owned(), lines)
            })
        })
        .collect()
}

/// Renders an `envsubst` file's text over its values: the one place `envsubst` is applied.
fn render_envsubst(text: &str, values: &Template) -> String {
    template(text, values)
}

/// Renders a `mustache` file's text over its data: the one place `mustache` is applied.
fn render_mustache(
    text: &str,
    data: &Value,
    settings: &KnowledgeSettings,
) -> Result<String, KnowledgeError> {
    mustache(text, data, settings)
}

/// The served text of each file of `overlay` that can be served with no `context`, by path: what
/// `kb_read` gives for it, which a search indexes. A template reads the facts of `caller`.
#[must_use]
pub fn served_texts(
    overlay: &KnowledgeOverlay,
    settings: &KnowledgeSettings,
    caller: &CallerFacts,
    engines: &[Engine],
) -> BTreeMap<String, String> {
    let set = overlay.set(settings);
    let empty = Map::new();
    let call = Call {
        overlay,
        set: &set,
        context: &empty,
        caller,
        settings,
        engines,
    };
    set.files
        .keys()
        .filter_map(|path| {
            served_text(&call, path)
                .ok()
                .map(|text| ((*path).to_owned(), text))
        })
        .collect()
}
