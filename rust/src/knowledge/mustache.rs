//! The Mustache subset a template of the knowledge may use: variables, sections, inverted sections
//! and comments. No partial, no change of delimiters, no lambda, no escaping.

use alloc::string::String;
use alloc::vec::Vec;

use serde_json::Value;

use super::settings::{KnowledgeSettings, MAX_INTEGER};
use super::{ErrorClass, KnowledgeError};

#[derive(Debug)]
enum Item {
    Text(String),
    Var(String),
    Section(String),
    Inverted(String),
    End(String),
    Comment,
}

#[derive(Debug)]
enum Node {
    Text(String),
    Var(String),
    Section {
        inverted: bool,
        name: String,
        children: Vec<Node>,
    },
}

fn error(message: &str) -> KnowledgeError {
    KnowledgeError::new(ErrorClass::TemplateError, message)
}

fn is_name(name: &str) -> bool {
    fn ident(part: &str) -> bool {
        let mut chars = part.chars();
        chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    }
    name == "." || name.split('.').all(ident)
}

/// Whether `text` is white space and at most one line end.
fn standalone(text: &str) -> bool {
    let rest = text.trim_start_matches([' ', '\t']);
    matches!(rest, "" | "\n" | "\r" | "\r\n")
}

fn parse_line(line: &str) -> Result<Vec<Item>, KnowledgeError> {
    let mut items = Vec::new();
    let mut index = 0;
    while index < line.len() {
        let Some(found) = line[index..].find("{{").map(|at| at + index) else {
            items.push(Item::Text(line[index..].to_owned()));
            break;
        };
        if found > index {
            items.push(Item::Text(line[index..found].to_owned()));
        }
        let item = if line[found..].starts_with("{{{") {
            let end = line[found + 3..]
                .find("}}}")
                .map(|at| at + found + 3)
                .ok_or_else(|| error("a tag is not closed"))?;
            let name = line[found + 3..end].trim_matches([' ', '\t']).to_owned();
            index = end + 3;
            Item::Var(name)
        } else {
            let end = line[found + 2..]
                .find("}}")
                .map(|at| at + found + 2)
                .ok_or_else(|| error("a tag is not closed"))?;
            let inner = line[found + 2..end].trim_matches([' ', '\t']);
            index = end + 2;
            let rest = |from: usize| inner[from..].trim_matches([' ', '\t']).to_owned();
            match inner.chars().next() {
                Some('#') => Item::Section(rest(1)),
                Some('^') => Item::Inverted(rest(1)),
                Some('/') => Item::End(rest(1)),
                Some('&') => Item::Var(rest(1)),
                Some('!') => Item::Comment,
                Some('>' | '<' | '=' | '{' | '}' | '$' | '%' | '*') => {
                    return Err(error("a tag of this kind is not defined"));
                }
                _ => Item::Var(inner.to_owned()),
            }
        };
        match &item {
            Item::Var(name) | Item::Section(name) | Item::Inverted(name) | Item::End(name) => {
                let block = !matches!(item, Item::Var(_));
                if !is_name(name) || (block && name == ".") {
                    return Err(error("a name is not usable"));
                }
            }
            _ => {}
        }
        items.push(item);
    }
    let tags = items
        .iter()
        .filter(|item| !matches!(item, Item::Text(_)))
        .count();
    let alone = tags == 1
        && items.iter().any(|item| {
            matches!(
                item,
                Item::Section(_) | Item::Inverted(_) | Item::End(_) | Item::Comment
            )
        })
        && items.iter().all(|item| match item {
            Item::Text(text) => standalone(text),
            _ => true,
        })
        && standalone(
            &items
                .iter()
                .filter_map(|item| match item {
                    Item::Text(text) => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>(),
        );
    if alone {
        items.retain(|item| !matches!(item, Item::Text(_)));
    }
    Ok(items)
}

fn parse(text: &str, settings: &KnowledgeSettings) -> Result<Vec<Node>, KnowledgeError> {
    // Each open section: its kind, name and the nodes before it.
    let mut open: Vec<(bool, String, Vec<Node>)> = Vec::new();
    let mut current: Vec<Node> = Vec::new();
    for line in text.split_inclusive('\n') {
        for item in parse_line(line)? {
            let inverted = matches!(item, Item::Inverted(_));
            match item {
                Item::Text(text) => current.push(Node::Text(text)),
                Item::Var(name) => current.push(Node::Var(name)),
                Item::Comment => {}
                Item::Section(name) | Item::Inverted(name) => {
                    // The data the template reads counts as one level.
                    if !settings.max_template_depth.allows(open.len() + 2) {
                        return Err(error("sections nest too deep"));
                    }
                    open.push((inverted, name, core::mem::take(&mut current)));
                }
                Item::End(name) => {
                    let Some((inverted, opened, before)) = open.pop() else {
                        return Err(error("a section is closed wrongly"));
                    };
                    if opened != name {
                        return Err(error("a section is closed wrongly"));
                    }
                    let children = core::mem::replace(&mut current, before);
                    current.push(Node::Section {
                        inverted,
                        name,
                        children,
                    });
                }
            }
        }
    }
    if !open.is_empty() {
        return Err(error("a section is not closed"));
    }
    Ok(current)
}

/// What a name finds: a value of the data, or nothing.
fn lookup<'a>(name: &str, stack: &[&'a Value]) -> Option<&'a Value> {
    if name == "." {
        return stack.last().copied();
    }
    let mut parts = name.split('.');
    let first = parts.next().unwrap_or_default();
    let mut value = stack
        .iter()
        .rev()
        .find_map(|context| context.as_object().and_then(|map| map.get(first)))?;
    for key in parts {
        value = value.as_object()?.get(key)?;
    }
    Some(value)
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Array(items)) => !items.is_empty(),
        Some(_) => true,
    }
}

struct Render<'a> {
    out: String,
    limit: &'a KnowledgeSettings,
}

impl Render<'_> {
    fn emit(&mut self, piece: &str) -> Result<(), KnowledgeError> {
        if !self
            .limit
            .max_rendered_bytes
            .allows(self.out.len() + piece.len())
        {
            return Err(KnowledgeError::new(
                ErrorClass::TooLarge,
                "the rendered text",
            ));
        }
        self.out.push_str(piece);
        Ok(())
    }

    #[allow(clippy::needless_lifetimes)]
    fn walk<'v>(
        &mut self,
        nodes: &[Node],
        stack: &mut Vec<&'v Value>,
    ) -> Result<(), KnowledgeError> {
        for node in nodes {
            match node {
                Node::Text(text) => self.emit(text)?,
                Node::Var(name) => match lookup(name, stack) {
                    Some(Value::Bool(flag)) => self.emit(if *flag { "true" } else { "false" })?,
                    Some(Value::String(text)) => self.emit(text)?,
                    Some(Value::Number(number)) if !number.is_f64() => {
                        self.emit(&number.to_string())?;
                    }
                    _ => {}
                },
                Node::Section {
                    inverted,
                    name,
                    children,
                } => {
                    let value = lookup(name, stack);
                    if *inverted {
                        if !truthy(value) {
                            self.walk(children, stack)?;
                        }
                    } else if truthy(value) {
                        if let Some(Value::Array(items)) = value {
                            for item in items {
                                stack.push(item);
                                let done = self.walk(children, stack);
                                stack.pop();
                                done?;
                            }
                        } else if let Some(value) = value {
                            stack.push(value);
                            let done = self.walk(children, stack);
                            stack.pop();
                            done?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

/// `text` as the Mustache subset of the knowledge section reads it, over `data`: variables
/// `{{name}}`, `{{{name}}}` and `{{&name}}` (never escaped), sections `{{#name}}`, inverted
/// sections `{{^name}}` and comments `{{! text }}`. A string is inserted as it is, an integer in
/// decimal and a boolean as `true` or `false`.
///
/// # Errors
///
/// `template-error` for a partial, a change of delimiters, any other tag or sigil, a name that is
/// no name, a tag not closed on its line, a section not closed or closed by another name and one
/// nested past `max_template_depth`; `too-large` for output past `max_rendered_bytes`.
pub fn mustache(
    text: &str,
    data: &Value,
    settings: &KnowledgeSettings,
) -> Result<String, KnowledgeError> {
    let tree = parse(text, settings)?;
    let mut render = Render {
        out: String::new(),
        limit: settings,
    };
    render.walk(&tree, &mut alloc::vec![data])?;
    Ok(render.out)
}

/// Whether `value` is an integer the specification's call and result carry.
pub(crate) fn is_integer(value: &Value) -> bool {
    value
        .as_i64()
        .is_some_and(|number| number.unsigned_abs() <= MAX_INTEGER.unsigned_abs())
        || value
            .as_u64()
            .is_some_and(|number| number <= MAX_INTEGER.unsigned_abs())
}
