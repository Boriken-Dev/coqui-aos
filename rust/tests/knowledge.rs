//! The knowledge handlers beyond the vectors: reading an overlay through a `FileSystem` that holds a
//! link, the call a consumer makes (`kb_read`), and `kb_search` through a backend.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use coqui_aos::{
    CallerFacts, FileKind, FileSystem, KnowledgeOverlay, KnowledgeSession, KnowledgeSettings,
    Limit, Metadata, Passage, ReadRequest, SearchAnswer, SearchBackend, SearchFailure, SearchMode,
    SearchRequest, Settings, TemplateFacts, ToolCall, kb_list, kb_read,
};
use serde_json::{Value, json};

/// A tree in memory, with the kinds a real one has.
#[derive(Default)]
struct Memory {
    entries: BTreeMap<PathBuf, (FileKind, Vec<u8>)>,
}

impl Memory {
    fn with(mut self, path: &str, kind: FileKind, bytes: &[u8]) -> Self {
        self.entries
            .insert(PathBuf::from(path), (kind, bytes.to_vec()));
        self
    }
}

impl FileSystem for Memory {
    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        self.entries
            .get(path)
            .map(|(kind, bytes)| Metadata::new(*kind, bytes.len() as u64))
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
    }

    fn read(&self, path: &Path, max: u64) -> io::Result<Vec<u8>> {
        let (_, bytes) = self
            .entries
            .get(path)
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        Ok(bytes.iter().copied().take(max as usize).collect())
    }

    fn list(&self, path: &Path) -> io::Result<Vec<OsString>> {
        Ok(self
            .entries
            .keys()
            .filter(|entry| entry.parent() == Some(path))
            .filter_map(|entry| entry.file_name().map(OsString::from))
            .collect())
    }
}

fn overlay() -> KnowledgeOverlay {
    let files = Memory::default()
        .with("/o", FileKind::Directory, b"")
        .with("/o/kb", FileKind::Directory, b"")
        .with("/o/kb/a.md", FileKind::File, b"# A\nhello\n")
        .with(
            "/o/kb/t.md",
            FileKind::File,
            b"#!mustache\nrole {{caller.role}}\ntopic {{context.topic}}\n",
        )
        .with("/o/kb/out", FileKind::Symlink, b"")
        .with("/o/bin", FileKind::Directory, b"")
        .with("/o/bin/run", FileKind::File, b"secret program")
        .with("/o/.git", FileKind::Directory, b"")
        .with("/o/.git/config", FileKind::File, b"x");
    KnowledgeOverlay::read(
        "team",
        serde_json::Map::new(),
        &files,
        Path::new("/o"),
        &Settings::default(),
        &KnowledgeSettings::default(),
    )
    .unwrap()
    .facts(TemplateFacts::new().root("/o"))
}

fn text(result: &coqui_aos::ToolResult) -> Value {
    result.structured.clone()
}

#[test]
fn an_overlay_read_through_a_filesystem_serves_knowledge_and_refuses_a_link() {
    let overlays = [overlay()];
    let settings = KnowledgeSettings::default();
    let listed = kb_list(&overlays, None, &[], &settings);
    let files = &listed.structured["overlays"][0]["files"];
    assert_eq!(
        files[0],
        json!({"path": "kb/a.md", "lines": 2, "bytes": 10})
    );
    assert_eq!(
        files[1],
        json!({"path": "kb/t.md", "lines": 2, "bytes": 13, "template": "mustache", "rendered": true})
    );
    assert_eq!(
        listed.structured["engines"],
        json!(["envsubst", "mustache"])
    );
    let caller = CallerFacts::new();
    let linked = kb_read(
        &overlays,
        &ReadRequest::new("kb/out/x.md"),
        &caller,
        &settings,
    );
    assert_eq!(text(&linked)["error"]["class"], "link");
    // A program is no knowledge: a call cannot learn it is there.
    let program = kb_read(&overlays, &ReadRequest::new("bin/run"), &caller, &settings);
    assert_eq!(text(&program)["error"]["class"], "not-found");
}

#[test]
fn kb_read_renders_a_template_from_the_callers_facts_per_call() {
    let overlays = [overlay()];
    let settings = KnowledgeSettings::default();
    let mut context = serde_json::Map::new();
    context.insert("topic".into(), json!("caching"));
    let read = |role: &str| {
        kb_read(
            &overlays,
            &ReadRequest::new("kb/t.md").context(context.clone()),
            &CallerFacts::new().role(role),
            &settings,
        )
    };
    let first = read("reviewer");
    assert!(!first.is_error);
    assert_eq!(first.structured["text"], "role reviewer\ntopic caching");
    assert_eq!(first.structured["template"], "mustache");
    assert_eq!(first.structured["rendered"], true);
    assert_eq!(
        read("author").structured["text"],
        "role author\ntopic caching"
    );
    let mcp = first.to_mcp();
    assert_eq!(mcp["isError"], false);
    assert_eq!(
        serde_json::from_str::<Value>(mcp["content"][0]["text"].as_str().unwrap()).unwrap(),
        mcp["structuredContent"]
    );
}

struct Fixed;

impl SearchBackend for Fixed {
    fn modes(&self) -> Vec<SearchMode> {
        vec![SearchMode::Words]
    }

    fn search(
        &self,
        overlay: &KnowledgeOverlay,
        request: &SearchRequest,
    ) -> Result<SearchAnswer, SearchFailure> {
        if overlay.identity == "down" {
            return Err(SearchFailure::unavailable("the index is being made"));
        }
        let passage =
            |path: &str, from: usize, score: f64| Passage::new(path, "A", from, 2, score, "hello");
        Ok(SearchAnswer::new(
            SearchMode::Words,
            vec![
                passage("kb/a.md", 2, 1.0),
                // A line past the end of the served text is no passage.
                passage("kb/t.md", 1, 9.0),
                passage("kb/a.md", 9, 9.0),
                passage("kb/a.md", 1, 2.0),
            ]
            .into_iter()
            .take(request.top + 3)
            .collect(),
        ))
    }
}

#[test]
fn kb_search_drops_what_the_specification_forbids_orders_and_reports_a_failed_overlay() {
    let down = KnowledgeOverlay::new("down", serde_json::Map::new(), Default::default());
    let overlays = [overlay(), down];
    let settings = KnowledgeSettings::default();
    let caller = CallerFacts::new();
    let session = KnowledgeSession::new(&overlays, &settings, &caller).search(&Fixed);
    let names: Vec<String> = session
        .tools()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, ["kb_list", "kb_read", "kb_search"]);
    let result = session.call(&ToolCall::new(
        "kb_search",
        json!({"query": "hello", "top": 5}),
    ));
    assert!(!result.is_error);
    let first = &result.structured["results"][0];
    assert_eq!(first["mode"], "words");
    let lines: Vec<u64> = first["passages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|passage| passage["from_line"].as_u64().unwrap())
        .collect();
    // A rendered template is searched through its served text; a line past it is no passage.
    assert_eq!(lines, [1, 1, 2]);
    assert_eq!(
        result.structured["results"][1]["error"]["class"],
        "unavailable"
    );
    let named = session.call(&ToolCall::new(
        "kb_search",
        json!({"query": "x", "mode": "meaning"}),
    ));
    assert_eq!(named.structured["error"]["class"], "invalid-arguments");
    let bad_path = session.call(&ToolCall::new(
        "kb_search",
        json!({"query": "x", "path": "../x"}),
    ));
    assert_eq!(bad_path.structured["error"]["class"], "invalid-path");
}

#[test]
fn a_session_with_no_backend_offers_no_search() {
    let overlays = [overlay()];
    let settings = KnowledgeSettings::default();
    let caller = CallerFacts::new();
    let session = KnowledgeSession::new(&overlays, &settings, &caller);
    assert_eq!(session.tools().len(), 2);
    let result = session.call(&ToolCall::new("kb_search", json!({"query": "x"})));
    assert_eq!(result.structured["error"]["class"], "invalid-arguments");
}

#[test]
fn every_limit_can_be_lifted_and_a_lifted_one_is_reported() {
    let settings = KnowledgeSettings::default()
        .max_read_bytes(Limit::UNBOUNDED)
        .max_top(Limit::at(3));
    let names: Vec<String> = settings
        .non_defaults()
        .into_iter()
        .map(|setting| setting.setting)
        .collect();
    assert_eq!(names, ["max_read_bytes", "max_top"]);
    assert!(KnowledgeSettings::default().non_defaults().is_empty());
}
