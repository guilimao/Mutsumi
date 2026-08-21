# `.mtm` format version 1

Mutsumi accepts one on-disk format. Every file has this top-level shape:

```json
{
  "formatVersion": 1,
  "metadata": {},
  "context": [],
  "notes": [{ "beforeUserIndex": 0, "markdown": "# Private note" }]
}
```

`context` contains messages with a strict semantic core:

- `user` requires a role and valid text/multimodal `content`;
- `assistant` requires a role, valid native content blocks, and `api`/`provider`/`model` identity;
- `toolResult` requires its tool-call ID/name, valid content blocks, and `isError`.

Provider envelope fields such as `usage`, cost, timestamps, stop reason, response metadata, errors, diagnostics, and signatures are preserved as opaque JSON. Missing or differently shaped envelope fields do not make the file invalid. Immediately before a provider request, Mutsumi creates a temporary pi-ai-compatible copy: invalid/missing usage becomes an all-zero value, timestamp becomes `0`, and stop reason is inferred as `toolUse` or `stop`. These defaults are never written back to disk.

`notes` is optional. Each entry stores the Markdown source of a user annotation. `beforeUserIndex` is the number of user cells before that note; array order preserves multiple notes in the same gap. Markup notes are restored in the Notebook but never enter Agent history, title generation, compression, ghost-block indexing, or a provider prompt.

System instructions are assembled dynamically and passed through `Context.systemPrompt`; they are never stored as messages. A user message may contain a `mutsumi.ghostBlock` extension. Assistant and tool-result messages may not contain Mutsumi extensions.

Consecutive user messages are valid pending turns and remain separate on disk and as Code cells. At the provider boundary only, adjacent users are merged with a blank-line separator; multimodal block order is preserved, and the last user's timestamp wins. Merging never crosses an assistant or tool result. A user message is still invalid while a preceding tool call is waiting for its result.

Files without `formatVersion: 1`, old OpenAI-shaped messages, malformed core message fields, and invalid tool-result ordering are rejected without being rewritten. Conversion belongs to the standalone migration project. If an open Notebook buffer contains malformed `mutsumi_interaction` metadata, Mutsumi ignores that entire interaction group and retains its Code cell as a pending user turn.
