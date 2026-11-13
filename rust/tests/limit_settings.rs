//! A refusal for a limit names the setting that was passed, `Settings`' own field name, apart
//! from its message.

use coqui_aos::{
    Class, Error, Limit, OverlayTree, Settings, read_catalog_document, read_document, read_icon,
    read_overlay, substitute_with,
};

fn only(error: &Error, class: Class, setting: &str) {
    assert_eq!(error.class, class, "{error}");
    assert_eq!(error.setting, Some(setting), "{error}");
}

#[test]
fn a_manifest_past_its_bytes() {
    let settings = Settings::default().manifest_bytes(Limit::at(8));
    let error = read_document(b"name = \"longer than eight\"\n", &settings).expect_err("refused");
    only(&error, Class::TooLarge, "manifest_bytes");
}

#[test]
fn a_manifest_past_its_depth_in_every_format() {
    let settings = Settings::default().manifest_depth(Limit::at(2));
    for text in [
        "a = [[[1]]]\n",
        "#!json\n{\"a\": {\"b\": {\"c\": 1}}}\n",
        "#!yaml\na: [[[1]]]\n",
    ] {
        let error = read_document(text.as_bytes(), &settings).expect_err("refused");
        only(&error, Class::TooDeep, "manifest_depth");
    }
}

#[test]
fn a_catalog_past_its_bytes() {
    let settings = Settings::default().catalog_bytes(Limit::at(8));
    for name in ["catalog.json", "CATALOG.aos"] {
        let error = read_catalog_document(&[b' '; 64], name, &settings).expect_err("refused");
        only(&error, Class::TooLarge, "catalog_bytes");
    }
}

#[test]
fn a_context_body_past_its_bytes() {
    let tree = OverlayTree::from_texts([(
        "OVERLAY.md",
        "---\nname: x\n---\nBody.\nBody.\nBody.\nBody.\nBody.\nBody.\nBody.\nBody.\nBody.\nBody.\n",
    )]);
    let settings = Settings::default().context_bytes(Limit::at(16));
    let error = read_overlay(&tree, &settings).expect_err("refused");
    only(&error, Class::TooLarge, "context_bytes");
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut data = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
    data.extend(width.to_be_bytes());
    data.extend(height.to_be_bytes());
    data
}

#[test]
fn an_icon_past_its_bytes_or_size() {
    let data = png(16, 16);
    let error = read_icon(
        &data,
        "a.png",
        &Settings::default().icon_bytes(Limit::at(8)),
    )
    .expect_err("refused");
    only(&error, Class::IconTooLarge, "icon_bytes");
    let error = read_icon(
        &data,
        "a.png",
        &Settings::default().icon_width(Limit::at(8)),
    )
    .expect_err("refused");
    only(&error, Class::IconDimensions, "icon_width");
    let error = read_icon(
        &data,
        "a.png",
        &Settings::default().icon_height(Limit::at(8)),
    )
    .expect_err("refused");
    only(&error, Class::IconDimensions, "icon_height");
}

#[test]
fn a_substitution_past_its_limits() {
    let nothing = |_: &str| Ok(None);
    let error = substitute_with(
        "${U:-${V:-${W:-x}}}",
        &nothing,
        &Settings::default().substitution_depth(Limit::at(1)),
    )
    .expect_err("refused");
    only(&error, Class::TooDeep, "substitution_depth");
    let error = substitute_with(
        "${U:-xxxxxxxxxxxx}",
        &nothing,
        &Settings::default().substitution_bytes(Limit::at(4)),
    )
    .expect_err("refused");
    only(&error, Class::TooLarge, "substitution_bytes");
    let error = substitute_with(
        "${U:-xxxxxxxxxxxx}",
        &nothing,
        &Settings::default().substitution_steps(Limit::at(2)),
    )
    .expect_err("refused");
    only(&error, Class::TooComplex, "substitution_steps");
}

#[test]
fn a_refusal_that_is_no_limit_names_none() {
    let error = read_document(b"a = = 1\n", &Settings::default()).expect_err("refused");
    assert_eq!(error.setting, None);
}
