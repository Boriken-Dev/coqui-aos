#![doc = include_str!("../README.md")]
#![cfg_attr(docsrs, feature(doc_cfg))]
#![warn(
    clippy::std_instead_of_core,
    clippy::std_instead_of_alloc,
    clippy::alloc_instead_of_core
)]

extern crate alloc;

mod apply;
mod codecs;
mod compose;
mod defaults;
mod digest;
mod error;
mod front_matter;
mod fs;
mod limits;
mod names;
mod overlay;
mod read;
mod source;
mod subst;
mod validate;

pub use apply::{
    Change, Effective, Environment, Facts, Needs, NonDefaultSetting, Phase, Preparation, ScriptRun,
    SetupRecord, SetupRun, composed_environment, effective, preparation, read_dotenv, setup_phase,
};
pub use compose::{
    Composition, Cycle, Environments, LeftEnvironment, PackageConflict, PackageEnvironment,
    Resolution, compose, composition_order, environments, resolve,
};
pub use defaults::{
    DEFAULT_KEYS, Dependency, INTERPRETERS, OverlayTree, PartialLock, SkillEntry, SkillOrigin,
    bundled_skills, check_requirements, context_ignored, context_of, default_on, default_paths,
    dependencies_of, env_files_of, harness_context_of, paths_of, rules_of, skill_entries,
    skills_of,
};
pub use digest::{Digest, TreeDigest, TreeEntry, digest_entries, tree_digest};
pub use error::Error;
pub use front_matter::{
    Case, FrontMatter, Split, SplitCase, context_file_text, read_front_matter, split_front_matter,
};
#[cfg(feature = "fs")]
pub use fs::StdFs;
pub use fs::{FileKind, FileSystem, Metadata};
pub use limits::{Limit, NonDefault, Settings};
pub use names::{
    EXCLUDED_COMPONENTS, current_os, is_reserved_variable, is_sensitive_variable, is_variable_name,
    normalize_name, os_matches, root_variable, state_variable, valid_overlay_name,
    valid_relative_path,
};
pub use overlay::{OverlayRead, read_overlay};
pub use read::{
    Document, DotenvLine, ScriptOutput, parse_dotenv, read_document, read_env_script_output,
};
pub use serde_json;
pub use source::{Source, SourceKind};
pub use subst::{Lookup, substitute, substitute_with};
pub use validate::{Issue, applies, named_files, skill_flags, valid_license, validate};
