# Current model-provider architecture

Mutsumi uses the `@earendil-works/pi-ai` provider catalog as its only model runtime. Built-in providers and models come from that catalog; user-defined OpenAI-compatible routes are configured through `mutsumi.customProviders`.

Credentials are entered with **Mutsumi: Manage Model Providers** and stored in VS Code SecretStorage. Provider selections are always explicit `{ provider, model }` pairs. Provider IDs are exact and are never inferred, aliased, or selected by first match.

The active settings are:

- `mutsumi.customProviders`: non-secret custom route definitions.
- `mutsumi.defaultModel`: the default `{ provider, model }` pair.
- `mutsumi.titleGeneratorModel`: optional title-generation pair.
- `mutsumi.compressModel`: optional conversation-compression pair.

Old settings and plaintext credentials are not read by this extension. They must be handled outside this repository, and credentials must be entered again through the provider manager.
