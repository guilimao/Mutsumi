/**
 * @fileoverview Render block types for agent output rendering.
 * Universal intermediate representation (IR) consumed by NotebookAdapter's
 * custom renderer, HeadlessAdapter's SSE clients, and LiteAdapter.
 * @module notebook/renderTypes
 */

import type { Usage } from '@earendil-works/pi-ai';

/**
 * Custom MIME type for agent chat render data.
 * Used as the output MIME when passing serialized {@link RenderData} JSON
 * to VSCode notebook cell outputs, consumed by the Mutsumi custom renderer.
 */
export const MUTSUMI_AGENT_CHAT_MIME = 'application/vnd.mutsumi.agent-chat';

/**
 * Serializable token/cost footer projected from pi-ai's AssistantMessage.usage.
 * @description Displayed at most once per assistant round; the block that carries it
 * follows the attach rule shared by the live path (UIRenderer.commitRoundUI/appendBlock)
 * and .mtm hydration (serializer.buildInteractionRenderBlocks): content rounds badge the
 * round's content block, tool rounds badge the round's FIRST tool block, reasoning-only
 * rounds show no badge.
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
 * hand-edited garbage) maps to undefined so no all-zero badge renders. The emptiness gate
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
    const totalTokens = usage.totalTokens === undefined ? input + output : num(usage.totalTokens);
    const costTotal = num(usage.cost?.total);
    if (input + output + cacheRead + cacheWrite + totalTokens === 0) return undefined;
    return { input, output, cacheRead, cacheWrite, totalTokens, costTotal };
}

/**
 * A single renderable unit of agent output.
 * @description Discriminated union over the three kinds of output the agent
 * produces: markdown content, collapsible reasoning, and tool calls.
 * Blocks in {@link RenderData.committed} are locked and never re-rendered.
 */
export type RenderBlock =
    | { type: 'content'; markdown: string; usage?: BlockUsage }
    | { type: 'reasoning'; markdown: string; collapsed: boolean }
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
        /** Token/cost of the assistant round that issued this call, once known */
        usage?: BlockUsage;
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
        content: string;
        pendingTools: RenderBlock[];
    } | null;
}
