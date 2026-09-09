# Changelog

All notable user-visible changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the
`package.json` version.

## [Unreleased]

### Added

- Custom providers can declare per-model capabilities in `mutsumi.customProviders`:
  `models` entries accept objects (`id`, `name`, `reasoning`, `input`,
  `contextWindow`, `maxTokens`, `thinkingLevelMap`, `compat`) alongside plain
  string IDs, and a provider-wide `capabilities` object (`reasoning`, `input`)
  supplies defaults beneath them. See `docs/custom-model-capabilities.md`.
- Token/cost usage is shown under assistant content blocks and on the first tool
  block of a tool round.

### Changed — review before upgrading

- **Breaking default flip for custom providers:** undeclared custom models are now
  treated optimistically (`reasoning: true`, `input: ['text', 'image']`). Previously
  every custom model was hardcoded to text-only, so images in history were replaced
  with an "(image omitted…)" placeholder. They are now sent to the endpoint as real
  image parts. Whether a text-only endpoint rejects them or silently ignores them
  depends on the server. If your endpoint is text-only, declare `input: ['text']` at
  the model or provider level to restore the previous behavior.
- **Reasoning effort vocabulary:** the concrete level `none` was renamed to `off`
  (pi-ai's `ModelThinkingLevel`). Existing `.mtm` files and HTTP clients using
  `none` are still accepted as a legacy alias and are normalized to `off`.
- **Visible error instead of silent drop:** setting a concrete reasoning effort on a
  model that declares no reasoning (`reasoning: false`) now fails locally with an
  explanatory error instead of having the effort silently clamped away. The same
  applies to `off` on a model that cannot disable reasoning (`thinkingLevelMap`
  declares `off: null`): the SDK would clamp it *upward* to the first available level,
  silently enabling reasoning instead of disabling it.
- **Stricter custom provider validation:** `models` must be an array, `displayName`
  must be a string, `thinkingLevelMap` keys must be pi-ai levels, and duplicate model
  IDs are rejected with both array positions named. `compat` remains an opaque
  passthrough — only the object shape is checked, keys and nested values are the
  SDK's semantics.
- The Select Model QuickPick now lists reasoning levels reported by the current
  model (via the SDK) instead of a fixed global list.
- Editing a custom provider declaration (capabilities, model list, `api`, or
  `baseUrl`) now invalidates that provider's persisted discovery cache, so the edit
  takes effect on the next run — including after an extension restart. Previously a
  stale cached catalog could shadow the new declaration until a network refresh.

### Fixed

- Upgrading from a version that persisted a discovery catalog before profile
  fingerprints existed now drops that catalog once. Previously the missing
  fingerprint was treated as "unchanged", so the stale catalog kept shadowing the
  newly declared capabilities until a successful network refresh.
