# Changelog

All notable changes to this package are documented in this file; the repository's
[CHANGELOG](../CHANGELOG.md) covers every implementation.

## Unreleased

- Hooks run like a harness's own, from specification revision ea41520: a `pre-tool` hook may print
  `decision: allow`, with an `input` object that replaces the call's; `fireEvent` takes the call's
  `toolInput` and reports what each hook `seen` and the `input` the call runs with. The failure cause
  `grant` is gone: any other decision is an `output` failure. `hookEnvironment` is the session's
  environment, overlays stacked in composition order, with `earlier` for what earlier hooks of the event set,
  and `processEnvironment` is the same for an overlay's setup, server, command and env script. `Environment`
  no longer keeps a write log, `PathJoin` and `EnvWrite` are gone.
- From specification revision c2f6d88, on a call of kind `other` only a hook that names `other` or has no
  `match` may allow it: `HookRun` gains `select` and `fireEvent` a `toolKind`; another hook's allow and
  `input` are not counted and are reported `hook-not-applied` `allow`, and its deny and ask still count.

## 0.0.0-alpha.0

- First release: the whole of AOS v0 `0.1.0-draft` in pure Dart, passing every conformance vector
  on the VM and in Chrome.
