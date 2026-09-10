/**
 * @fileoverview Render block types for agent output rendering.
 * Universal intermediate representation (IR) consumed by NotebookAdapter's
 * custom renderer, HeadlessAdapter's SSE clients, and LiteAdapter.
 * @module notebook/renderTypes
 */

import type { Usage } from '@earendil-works/pi-ai';
// pi-ai's own token accounting: `totalTokens || input + output + cacheRead + cacheWrite`.
// Reused so the local fallback cannot drift from the SDK's definition of a total.
import { calculateContextTokens } from '@earendil-works/pi-ai/utils/estimate';

/**
 * Custom MIME type for agent chat render data.
 * Used as the output MIME when passing serialized {@link RenderData} JSON
 * to VSCode notebook cell outputs, consumed by the Mutsumi custom renderer.
 */
export const MUTSUMI_AGENT_CHAT_MIME = 'application/vnd.mutsumi.agent-chat';

/**
 * Serializable token/cost footer projected from pi-ai's AssistantMessage.usage.
 * @description Rendered as a standalone `usage` block appended once per assistant round by
 * both the live path (UIRenderer.commitRoundUI/appendUsage) and .mtm hydration
 * (serializer.buildInteractionRenderBlocks). Content, tool, and reasoning-only rounds all get
 * the same footer, so no attach rule has to be mirrored between the two paths.
 */
export interface BlockUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    costTotal: number;
}

/**
 * Maps pi-ai's Usage onto the serializable IR shape, defaulting missing fields to zero.
 * @description Tolerates the loose persisted shape (`.mtm` usage is untyped): non-numeric
 * junk is coerced to zero, and a usage carrying no countable tokens (empty object,
 * hand-edited garbage) maps to undefined so no all-zero badge renders. A missing
 * `totalTokens` is filled in with the SDK's own token accounting
 * (`calculateContextTokens`), so cached input is not silently dropped. The emptiness gate
 * counts token fields only — pi-ai derives cost from tokens, so a cost-only usage is junk
 * rather than a billable round and must not render an empty "$0.0000" badge.
 */
export function toBlockUsage(usage: Usage | undefined): BlockUsage | undefined {
    if (!usage || typeof usage !== 'object') return undefined;
    const num = (value: unknown): number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    const input = num(usage.input);
    const output = num(usage.output);
    const cacheRead = num(usage.cacheRead);
    const cacheWrite = num(usage.cacheWrite);
    // num() turns undefined/junk into 0, which calculateContextTokens reads as "absent" and
    // falls back to the full input+output+cacheRead+cacheWrite sum.
    const totalTokens = calculateContextTokens({
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: num(usage.totalTokens),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const costTotal = num(usage.cost?.total);
    if (input + output + cacheRead + cacheWrite + totalTokens === 0) return undefined;
    return { input, output, cacheRead, cacheWrite, totalTokens, costTotal };
}

/**
 * A single renderable unit of agent output.
 * @description Discriminated union over the kinds of output the agent produces: markdown
 * content, collapsible reasoning, tool calls, and the round's token/cost footer. A `usage`
 * block follows the blocks of the assistant round it belongs to; it is committed when the
 * round commits, which is before that round's tool blocks (those are appended as each tool
 * finishes), because the usage belongs to the assistant message, not to the tool results.
 * - **content**: markdown prose. One block per assistant text block, in SDK order, so prose that
 *   resumes after a tool call renders as its own block instead of merging into the first run.
 * Blocks in {@link RenderData.committed} are locked and never re-rendered.
 */
export type RenderBlock =
    | { type: 'content'; markdown: string }
    | { type: 'reasoning'; markdown: string; collapsed: boolean }
    | { type: 'usage'; usage: BlockUsage }
    | {
        type: 'toolCall';
        /** Tool name (e.g. 'read') */
        name: string;
        /** Tool arguments (complete or best-effort partial while streaming) */
        args: Record<string, any>;
        /** Human-readable summary of the tool call */
        summary: string;
        /** Execution result, present once the tool has finished */
        result?: string;
        /** Whether this tool call is still streaming (pending) */
        isStreaming: boolean;
        /** Optional hints for rendering arguments as code blocks */
        renderingConfig?: {
            /** Argument names to render as fenced code blocks */
            argsToCodeBlock?: string[];
            /** Argument names holding the file path for each code block (language detection) */
            codeBlockFilePaths?: (string | undefined)[];
        };
    };

/**
 * Structured agent output for incremental rendering.
 * @description Split into a locked (committed) prefix and a live (active)
 * streaming tail. Renderers should DOM-cache committed blocks and only
 * re-render the active area on each update.
 */
export interface RenderData {
    /** Locked blocks, rendered once and DOM-cached, never re-rendered */
    committed: RenderBlock[];
    /** Current streaming area, re-rendered on each token update; null when idle */
    active: {
        reasoning: string;
        /** Text of the still-open trailing content block, if any */
        content: string;
        pendingTools: RenderBlock[];
    } | null;
}
