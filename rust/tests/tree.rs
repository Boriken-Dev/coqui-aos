//! Reading a directory through a [`FileSystem`]: the tree digest of real files and of a tree the
//! test holds in memory.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use coqui_aos::{
    FileKind, FileSystem, Limit, Metadata, OverlayTree, Settings, StdFs, default_paths,
    read_document, rules_of, tree_digest,
};

fn write(root: &Path, files: &[(&str, &str)]) {
    for (path, text) in files {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("a directory");
        std::fs::write(path, text).expect("a file");
    }
}

const ENGINEERING: &[(&str, &str)] = &[
    (
        "overlay.cfg",
        "name = \"engineering\"\ndescription = \"How work is planned and committed.\"\n",
    ),
    ("flows/PLAN.md", "# Plans\n\nOne file per plan.\n"),
    (
        "rules/commits.md",
        "- **Commits** are logical, one concern each.\n",
    ),
];

const RUST: &[(&str, &str)] = &[
    (
        "overlay.cfg",
        "requires = [\"engineering\"]\npriority = 600\n",
    ),
    ("kb/RUST.md", "# Rust\n\nClippy with warnings denied.\n"),
    ("bin/check-all", "#!/bin/sh\ncargo clippy --all-targets\n"),
];

#[test]
fn a_directory_gives_its_tree_digest_without_the_excluded_names() {
    let root = tempfile::tempdir().expect("a directory");
    write(root.path(), ENGINEERING);
    write(
        root.path(),
        &[
            (".git/HEAD", "ref: refs/heads/main\n"),
            ("lib/__pycache__/x.pyc", "x"),
        ],
    );
    let tree = tree_digest(&StdFs, root.path(), &Settings::default()).expect("a digest");
    assert_eq!(
        tree.files.keys().collect::<Vec<_>>(),
        ["flows/PLAN.md", "overlay.cfg", "rules/commits.md"],
        "excluded names are no members"
    );
    let manifest = read_document(
        &std::fs::read(root.path().join("overlay.cfg")).expect("the manifest"),
        &Settings::default(),
    )
    .expect("a manifest");
    let overlay = OverlayTree::from_paths(tree.files.keys().cloned());
    assert_eq!(rules_of(&manifest, &overlay), ["rules/commits.md"]);
}

#[test]
fn a_directory_with_a_bin_folder_adds_it_to_the_path() {
    let root = tempfile::tempdir().expect("a directory");
    write(root.path(), RUST);
    let tree = tree_digest(&StdFs, root.path(), &Settings::default()).expect("a digest");
    let manifest = read_document(
        &std::fs::read(root.path().join("overlay.cfg")).expect("the manifest"),
        &Settings::default(),
    )
    .expect("a manifest");
    let overlay = OverlayTree::from_paths(tree.files.keys().cloned());
    assert_eq!(default_paths(&manifest, &overlay)[0]["variable"], "PATH");
}

#[test]
fn a_changed_file_changes_the_tree_digest() {
    let root = tempfile::tempdir().expect("a directory");
    write(root.path(), RUST);
    let settings = Settings::default();
    let digest = || {
        tree_digest(&StdFs, root.path(), &settings)
            .expect("a digest")
            .digest
    };
    let before = digest();
    write(
        root.path(),
        &[("kb/RUST.md", "# Rust\n\nClippy with warnings denied!\n")],
    );
    let edited = digest();
    assert_ne!(before, edited, "an edited file");
    write(root.path(), &[("kb/NEW.md", "new\n")]);
    let added = digest();
    assert_ne!(edited, added, "an added file");
    std::fs::rename(
        root.path().join("kb/NEW.md"),
        root.path().join("kb/OTHER.md"),
    )
    .expect("a rename");
    assert_ne!(added, digest(), "a renamed file");
    let now = digest();
    std::fs::create_dir_all(root.path().join("empty/inner")).expect("a directory");
    write(root.path(), &[("node_modules/x/index.js", "x\n")]);
    assert_eq!(
        now,
        digest(),
        "an empty directory and an excluded one change nothing"
    );
}

#[test]
fn a_tree_past_a_limit_is_refused_naming_the_limit() {
    let root = tempfile::tempdir().expect("a directory");
    write(root.path(), RUST);
    let settings = Settings::default().tree_files(Limit::at(2));
    let refused = tree_digest(&StdFs, root.path(), &settings).expect_err("refused");
    assert_eq!(refused.class, "too-large");
    assert!(refused.subject.contains("more than 2 files"), "{refused}");
    let small = Settings::default().file_bytes(Limit::at(4));
    let refused = tree_digest(&StdFs, root.path(), &small).expect_err("refused");
    assert_eq!(refused.class, "too-large");
}

/// A tree held in memory, so a link, a device and a name that is not UTF-8 can be had on every
/// platform.
#[derive(Default)]
struct Memory(BTreeMap<PathBuf, (FileKind, Vec<u8>)>);

impl Memory {
    fn with(mut self, path: &str, kind: FileKind, bytes: &[u8]) -> Self {
        self.0.insert(PathBuf::from(path), (kind, bytes.to_vec()));
        self
    }
}

impl FileSystem for Memory {
    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        if path == Path::new("/o") {
            return Ok(Metadata::new(FileKind::Directory, 0));
        }
        self.0
            .get(path)
            .map(|(kind, bytes)| Metadata::new(*kind, bytes.len() as u64))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "not found"))
    }

    fn read(&self, path: &Path, max: u64) -> io::Result<Vec<u8>> {
        let (_, bytes) = self
            .0
            .get(path)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "not found"))?;
        Ok(bytes
            .iter()
            .take(usize::try_from(max).unwrap_or(usize::MAX))
            .copied()
            .collect())
    }

    fn list(&self, path: &Path) -> io::Result<Vec<OsString>> {
        Ok(self
            .0
            .keys()
            .filter(|candidate| candidate.parent() == Some(path))
            .filter_map(|candidate| candidate.file_name().map(OsString::from))
            .collect())
    }
}

#[test]
fn a_link_in_the_tree_is_refused_and_never_followed() {
    let files = Memory::default()
        .with("/o/overlay.cfg", FileKind::File, b"name = \"x\"\n")
        .with("/o/shortcut", FileKind::Symlink, b"");
    let error = tree_digest(&files, Path::new("/o"), &Settings::default()).expect_err("refused");
    assert_eq!(error.class, "symlink");
    assert_eq!(error.subject, "shortcut");
}

#[test]
fn a_device_in_the_tree_is_refused() {
    let files = Memory::default().with("/o/pipe", FileKind::Other, b"");
    let error = tree_digest(&files, Path::new("/o"), &Settings::default()).expect_err("refused");
    assert_eq!(error.class, "special-file");
}

#[test]
fn a_tree_held_in_memory_has_the_digest_of_the_same_files_on_disk() {
    let root = tempfile::tempdir().expect("a directory");
    write(root.path(), ENGINEERING);
    let on_disk = tree_digest(&StdFs, root.path(), &Settings::default()).expect("a digest");
    let mut files = Memory::default();
    for (path, text) in ENGINEERING {
        files = files.with(&format!("/o/{path}"), FileKind::File, text.as_bytes());
    }
    let directories = ["/o/flows", "/o/rules"];
    for directory in directories {
        files = files.with(directory, FileKind::Directory, b"");
    }
    let in_memory = tree_digest(&files, Path::new("/o"), &Settings::default()).expect("a digest");
    assert_eq!(on_disk.digest, in_memory.digest);
}
