//! The index as the search backend of a session: what it answers conforms to the specification.

use coqui_aos::index::{Corpus, Index, IndexSearch, Options, Settings};
use coqui_aos::{
    CallerFacts, KnowledgeOverlay, KnowledgeSession, KnowledgeSettings, KnowledgeTree, SearchMode,
    ToolCall, search_check,
};
use serde_json::json;

fn overlay() -> KnowledgeOverlay {
    let tree = KnowledgeTree::new()
        .with_text(
            "kb/rust.md",
            "# Rust\r\n\r\nCargo builds crates.\r\n\r\n## Testing\r\n\r\nRun cargo test.\r\n",
        )
        .with_text("flows/ship.md", "Ship it with cargo publish.\n")
        .with_text(
            "kb/t.md",
            "---\ntemplate: envsubst\n---\ncargo ${AOS_OVERLAY_NAME}\n",
        );
    KnowledgeOverlay::new("team", serde_json::Map::new(), tree)
}

#[test]
fn a_session_searches_the_index_and_never_returns_a_template() {
    let overlay = overlay();
    let settings = KnowledgeSettings::default();
    let dir = tempfile::tempdir().unwrap();
    let corpus = Corpus::from_overlay(&overlay, &settings);
    assert_eq!(
        corpus.paths().collect::<Vec<_>>(),
        ["flows/ship.md", "kb/rust.md"]
    );
    let index_dir = dir.path().join("index");
    Index::create(
        &index_dir,
        Settings::default(),
        &corpus,
        None,
        &Options::default(),
    )
    .unwrap();
    let backend = IndexSearch::new().index("team", Index::open(&index_dir).unwrap());
    let overlays = [overlay];
    let caller = CallerFacts::new();
    let session = KnowledgeSession::new(&overlays, &settings, &caller).search(&backend);
    let arguments = json!({"query": "cargo"});
    let result = session.call(&ToolCall::new("kb_search", arguments.clone()));
    assert!(!result.is_error, "{}", result.text());
    let entry = &result.structured["results"][0];
    assert_eq!(entry["mode"], "words");
    let paths: Vec<&str> = entry["passages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|passage| passage["path"].as_str().unwrap())
        .collect();
    assert!(
        !paths.is_empty() && !paths.contains(&"kb/t.md"),
        "{paths:?}"
    );
    let broken = search_check(
        &overlays,
        &arguments,
        &result.structured,
        &[SearchMode::Words],
        &settings,
    )
    .unwrap();
    assert!(broken.is_empty(), "{broken:?}");
    // A named mode no backend declares is refused before any search.
    let meaning = session.call(&ToolCall::new(
        "kb_search",
        json!({"query": "cargo", "mode": "meaning"}),
    ));
    assert!(meaning.is_error);
}
