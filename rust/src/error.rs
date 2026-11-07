//! The one error type: a refusal by the class the specification's conformance vectors name it.

use core::fmt;

/// A refusal, by the class the specification's conformance vectors name it (`parse-error`,
/// `undefined-variable`, `symlink`, ...), and what it is about: a variable, a path, a format or
/// an overlay, never a value from a document.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct Error {
    /// The class.
    pub class: &'static str,
    /// The variable, path, format name or overlay it is about; empty when there is none to
    /// name.
    pub subject: String,
    /// The one-based line, when the refusal has a position in a document.
    pub line: Option<usize>,
    /// The one-based column, when it has one.
    pub column: Option<usize>,
}

impl Error {
    /// A refusal of `class` about `subject`.
    #[must_use]
    pub fn new(class: &'static str, subject: impl Into<String>) -> Self {
        Self {
            class,
            subject: subject.into(),
            line: None,
            column: None,
        }
    }

    /// The same refusal at a position in the document.
    #[must_use]
    pub fn at(mut self, line: usize, column: usize) -> Self {
        self.line = Some(line);
        self.column = Some(column);
        self
    }

    /// The same refusal on a line.
    #[must_use]
    pub fn on_line(mut self, line: usize) -> Self {
        self.line = Some(line);
        self
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.class)?;
        if !self.subject.is_empty() {
            write!(f, ": {}", self.subject)?;
        }
        if let Some(line) = self.line {
            write!(f, " at line {line}")?;
            if let Some(column) = self.column {
                write!(f, " column {column}")?;
            }
        }
        Ok(())
    }
}

impl core::error::Error for Error {}
