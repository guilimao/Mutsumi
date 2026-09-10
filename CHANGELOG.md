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
- Each assistant round's token/cost usage is shown as its own muted line after the
  round's content/reasoning and before its tool calls — content rounds, tool rounds, and
  reasoning-only rounds alike. The same order is rebuilt when reopening a `.mtm` file, so
  the line no longer jumps around between live output and reload.
- The usage line now also reports the model's context window and the round's occupancy with a
  percentage (`ctx 6.5K/200K (3%)`), the cache hit rate, the average generation throughput
  (`tok/s`), and the time to first token. Context window and occupancy, cache hit rate, and
  cost come from pi-ai's own `Usage`/model catalog; TTFT and generation throughput are measured
  by the stream handler and persisted on the assistant message (a `mutsumi` extension that is
  tolerated like other envelope fields, sanitized at render time, and stripped before every
  provider request), so they survive a `.mtm` reload.

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

- A tool round's usage line (and the round's committed content) now appears as soon as the
  model stops, instead of waiting for the first tool result. The round was committed with
  `commitRoundUI` but its frame was only published by the next tool output, so a slow tool (or
  an approval wait) delayed the usage footer by seconds. The running tool-call placeholders are
  now kept in the live area and replaced as each tool finishes (matched by tool-call ID, with
  name and order as fallbacks), so publishing the commit immediately no longer makes them blink
  out. Every run now ends on exactly one terminal frame produced by `UIRenderer.endRun()` on all
  exit paths — completion, cancellation, and failure: it retracts any placeholder whose tool
  never ran, keeps the partial answer (during the live run, a failed stream's partial text is
  now kept above the error message instead of being discarded), and never touches committed
  blocks. Frame publication is best-effort throughout: a display failure (e.g. the cell execution
  was already disposed) is logged and never changes the run's outcome, so a completed round is
  still returned for persistence instead of being lost to a rejected run.
- A discovered catalog is now stored together with the fingerprint of the custom
  provider declaration that produced it, and is used only while that fingerprint matches
  the current declaration. Previously the fingerprint lived in a separate key, so a reload
  that updated some providers' fingerprints before failing could pair a stale catalog with
  the new declaration and shadow it after a restart.
- A model refresh still in flight when a provider declaration changes can no longer write
  its stale catalog into the new declaration's cache. The reload aborts the outgoing
  snapshot's refreshes and waits for the catalog writes themselves — the SDK's refresh
  promise can settle early when the abort races it.
- Overlapping reloads from rapid configuration changes are now serialized. A slower
  earlier reload can no longer publish after a later one and restore the old config.
- If persisting a reload fails, the retained snapshot is handed a fresh refresh
  controller. Aborting the outgoing snapshot is irreversible, so without this a storage
  error during reload would silently disable every later model refresh.
- Upgrading from a version that persisted a discovery catalog before profile
  fingerprints existed drops that catalog once: it carries no fingerprint matching the
  current declaration. Previously the missing fingerprint was treated as "unchanged", so
  the stale catalog kept shadowing the newly declared capabilities until a successful
  network refresh.
- A round that keeps writing after a tool call no longer loses that text in the live cell
  output. Rendering now tracks each assistant round per SDK content block instead of
  locking the whole round when the first block is done, so "text → tool call → more text"
  shows both runs of prose while streaming and commits them in the same order a reopened
  `.mtm` file rebuilds.
- A reasoning-effort value that collides with an `Object` member (`constructor`,
  `toString`, `__proto__`) is passed through as the unknown string it is, instead of
  surfacing a function or object from the legacy alias lookup in error messages and the
  available-levels display.
