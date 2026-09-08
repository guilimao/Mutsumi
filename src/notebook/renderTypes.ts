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

/** Serializable token/cost footer projected from pi-ai's AssistantMessage.usage. */
export interface BlockUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    costTotal: number;
}

/** Maps pi-ai's Usage onto the serializable IR shape, defaulting missing fields to zero. */
export function toBlockUsage(usage: Usage | undefined): BlockUsage | undefined {
    if (!usage) return undefined;
    return {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        totalTokens: usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? 0)),
        costTotal: usage.cost?.total ?? 0,
    };
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
