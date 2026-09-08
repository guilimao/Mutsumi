# 自定义模型能力声明 — 最终目标状态文档

> 状态：**已冻结**（2026-09-08，随 SDK 对齐重构 v1.3 立项）。本文档是自定义 provider / 模型能力语义的唯一权威依据。
> 任何实现中暴露的偏差，必须先修订本文档，再调整实现。

---

## 1. 背景与问题

pi-ai SDK 对所有 thinking 相关请求参数（OpenAI 风格 `reasoning_effort` 透传、zai/deepseek/qwen 等
`thinkingFormat` 分支）都以 `Model.reasoning` 为总闸门；`input` 数组描述模态能力。SDK 提供的能力解析有两条：

1. **内置目录**：`builtinProviders()` 携带已知 provider 的完整模型能力（项目已使用）。
2. **URL 启发式 compat 检测**：`detectCompat(model)` 对已知 baseUrl 模式推断 `supportsReasoningEffort`、
   `thinkingFormat` 等请求形态旗标（项目经"不设 compat"间接受益）。

SDK **不解析**自定义 `/models` 列表的能力字段（该列表只承诺 `id` 等基础字段）。因此在引入能力声明之前，
项目对所有自定义模型硬编码 `reasoning: false, input: ['text']`——"未知 = 不支持"——导致：

- QuickPick effort 区段塌缩为仅 `default`；
- 用户手改 `.mtm` 写入档位后被 SDK `clampThinkingLevel` **静默钳为 off 丢弃**（有损降级且不可见）。

## 2. 已冻结决策

| # | 决策 |
|---|---|
| C1 | **乐观缺省**：自定义模型未声明能力时取 `reasoning: true`、`input: ['text', 'image']`。理由：能力未知 ≠ 不支持；选了档位而不兼容的端点会 400 可见（对齐 reasoning 文档 D6 哲学），用户可按 provider/模型手动禁用。 |
| C2 | **请求形态兜底**：自定义模型总缺省 `compat.supportsDeveloperRole: false`（system 角色兜底）。SDK README 明确警告 Ollama/vLLM/SGLang 类服务器不理解 reasoning 模型使用的 `developer` 角色；乐观缺省不能连累基线请求。用户可通过 compat 透传覆盖。 |
| C3 | **声明层级**（优先级从低到高）：乐观缺省 → provider 级 `capabilities` → `/models` 发现列表的数值字段（contextWindow/maxTokens）→ 模型级 spec。模型级 spec 是唯一能关闭 reasoning 的层（显式 `reasoning: false`）。 |
| C4 | **声明存活于刷新**：SDK `createProvider` 合并语义是"动态发现结果按 id **覆盖**静态声明"（`dist/models.js` `currentModels()`），与 C3 优先级相反 → 合并必须在 `discoverCustomModels` 内部完成：发现项套用同 id 声明 spec 重建、声明独有 id 追加。 |
| C5 | **静默降级 → 可见错误**：组请求时若 effort 为具体档位而 `getSupportedThinkingLevels(model)` 不含它（即声明了 `reasoning: false`），抛本地可见错误（提示移除覆盖或声明能力），不依赖 SDK 静默钳制。内置模型同样适用（它们的能力来自 SDK 目录，本就准确）。 |
| C6 | **高级透传**：模型级 spec 可透传 `thinkingLevelMap` 与部分 `compat` 旗标（按 `profile.api` 对应类型），不做 Mutsumi 自有语义的解释或翻译——字段含义完全以 SDK 文档为准。 |
| C7 | **UI 边界**：`manageProviders` QuickPick 流程维持纯字符串模型录入；能力声明只经 settings JSON（`mutsumi.customProviders`）。不在 QuickPick 里做能力编辑向导。 |

## 3. 配置 schema（settings JSON）

```jsonc
"mutsumi.customProviders": {
  "my-vllm": {
    "baseUrl": "http://127.0.0.1:8000/v1",
    "api": "openai-completions",          // 缺省
    "auth": "apiKey",                      // 缺省
    "capabilities": {                      // 可选：provider 级缺省
      "reasoning": true,                   // 缺省 true（C1）
      "input": ["text", "image"]           // 缺省 ['text','image']（C1）
    },
    "models": [
      "bare-string-id",                    // 字符串简写仍然合法
      {
        "id": "qwen3-32b",
        "reasoning": true,                 // 缺省继承 provider capabilities
        "input": ["text"],
        "contextWindow": 131072,
        "maxTokens": 8192,
        "thinkingLevelMap": { "off": null },   // 高级：该模型无法关闭思考（透传 SDK）
        "compat": { "supportsReasoningEffort": false }  // 高级：请求形态旗标透传
      }
    ]
  }
}
```

校验规则（`validateProfiles`）：

- `models` items 接受 `string | object` 双形态；object 必须有非空 `id`。
- `reasoning` 必须 boolean；`input` 必须是 `('text' | 'image')[]` 非空子集（去重）。
- `contextWindow` / `maxTokens` 必须正整数。
- `thinkingLevelMap` / `compat` 做结构浅校验后原样透传（不做语义翻译，C6）。
- provider 级 `capabilities` 与模型级同构（不含 id/name/数值外的字段）。

## 4. SDK 升级评估位（D-B 决策跟踪）

思考历史保留（exclude from history）与 thinking token 预算（budgets）旋钮：**SDK 0.82.1 未暴露，
先升级到 0.85.x 后评估**，结论记录于此：

- [x] **0.85.1 评审结论（2026-09-08）**：
  - `SimpleStreamOptions.reasoning` 仍为 `ThinkingLevel`（类型不含 `'off'`；运行时接受）→ llmClient 的单一
    注释 cast 保留。新增了 `toolChoice` 与 `deferred`（异步续跑）选项，均与 reasoning 语义无关。
  - reasoning 配置面**仍无** history 保留 / exclude 字段（全量 grep 无结果）；`thinkingBudgets` 维持 0.82 形态
    （minimal/low/medium/high 的 token 预算，`SimpleStreamOptions.thinkingBudgets`）。
  - `getSupportedThinkingLevels` / `clampThinkingLevel` 语义不变（`reasoning:false → ['off']`；
    无 `thinkingLevelMap` → off..high）。
  - `contentText` / `isRetryableAssistantError` / `retryAssistantCall` / `fauxProvider` 导出保持可用。
  - 升级验收：41 项测试（含 5 项回环 wire 级）全绿，wire payload 行为与 0.82.1 一致。
- **结论：维持"不自建"**（对齐 reasoning 文档 D2 注记）。`thinkingBudgets` 已存在但属高级旋钮，
  暴露与否等后续需要时再议；history 保留等 SDK 提供后接入。

## 5. 受影响面

- `src/llm/types.ts` — `CustomModelSpec` / `CustomProviderProfile.capabilities`
- `src/llm/providerService.ts` — `customModel()` 优先级合并、`discoverCustomModels()` 声明覆盖合并（C4）、
  `validateProfiles()` 双形态校验
- `package.json` — `mutsumi.customProviders` schema（models items 双形态 + capabilities）
- `src/agent/llmClient.ts` — C5 可见错误
- `tests/llmWire.test.ts` — 乐观缺省 / compat 透传的 wire 断言
- l10n（en / zh-cn）— 设置项描述更新

## 6. 明确不做（后续清单）

- OAuth 内置 provider 启用（`providerService.reload()` 过滤无 apiKey auth 的内置 provider，
  导致 `manageProviders` 的 OAuth 交互分支为死代码）
- `cacheRetention` / `sessionId` 缓存与会话亲和控制
- `constrainedSampling`（strict/grammar 工具）、`validateToolArguments` 执行前校验
- `isContextOverflow` 自动压缩触发
- `thinkingBudgets`（SDK 已有但属高级旋钮，待 0.85 评估后决定是否暴露）
- 图片生成（`generateImages`）
- OpenRouter 式 `/models` 列表能力字段推断（`supported_parameters` / `architecture.modalities` 等
  provider 特定解析，等 SDK 提供统一切面再做）
