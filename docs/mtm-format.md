# `.mtm` format version 1

Mutsumi accepts one on-disk format. Every file has this top-level shape:

```json
{
  "formatVersion": 1,
  "metadata": {},
  "context": []
}
```

`context` contains native `@earendil-works/pi-ai` messages:

- `user` with `content` and `timestamp`;
- `assistant` with native content blocks, API/provider/model identity, usage, stop reason, signatures, response metadata, and timestamp;
- `toolResult` with its tool-call identity, content blocks, `isError`, and timestamp.

System instructions are assembled dynamically and passed through `Context.systemPrompt`; they are never stored as messages. A user message may contain a `mutsumi.ghostBlock` extension. Assistant and tool-result messages may not contain Mutsumi extensions.

Files without `formatVersion: 1`, old OpenAI-shaped messages, standalone assistant/system cells, malformed messages, and invalid tool-result ordering are rejected without being rewritten. Conversion belongs to the standalone migration project.
