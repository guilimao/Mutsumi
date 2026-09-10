/**
 * @fileoverview UI Renderer for agent notebook cell output.
 * Produces structured {@link RenderData} (RenderBlock IR) instead of HTML strings,
 * implementing a three-level locking scheme so committed blocks never re-render.
 * @module agent/uiRenderer
 */

import { RenderBlock, RenderData } from '../notebook/renderTypes';
import type { BlockUsage } from '../notebook/renderTypes';
import type { ToolSet } from '../tools.d/toolManager';
import type { ToolCall } from '@earendil-works/pi-ai';

/**
 * Accumulates agent output as structured render blocks.
 * @description Maintains a committed block list (locked, rendered once) plus an
 * active streaming area (re-rendered per token). Three locking levels:
 * - L1 (round): commitRoundUI() moves all remaining active content into committed.
 * - L2 (intra-round): reasoning locks when content starts; each text block locks once the
 *   next SDK content block supersedes it.
 * - L3 (tool): appendBlock() commits each finished tool call.
 * @class UIRenderer
 * @example
 * const renderer = new UIRenderer();
 * const data = renderer.updateActive(contentBlocks, reasoning, pendingTools);
 * renderer.commitRoundUI(finalContentBlocks, finalReasoning);
 */
export class UIRenderer {
    /** Locked blocks, rendered once and never re-rendered */
    private committedBlocks: RenderBlock[] = [];
    /** Streaming reasoning for the current round (emptied once locked) */
    private activeReasoning: string = '';
    /** Every text block of the current round, in SDK content-block order */
    private contentBlocks: string[] = [];
    /** How many leading contentBlocks are already locked into committed */
    private committedContentCount: number = 0;
    /** Streaming (pending) tool calls for the current round */
    private activeTools: RenderBlock[] = [];
    /** Whether the current round's reasoning has been locked into committed */
    private reasoningLocked: boolean = false;

    /**
     * Updates the active streaming area, auto-detecting L2 lock transitions.
     * @description Called on each streaming progress callback with the round's
     * accumulated values. When content first arrives, any accumulated reasoning
     * is locked into committed; every text block the SDK has moved past is locked
     * too, so a message that resumes writing after a tool call (text A -> tool call ->
     * text B) keeps both runs of text instead of locking the whole round on the first one.
     * @param {string[]} contentBlocks - Text of each content block of the current round, in order
     * @param {string} reasoning - Accumulated reasoning for the current round
     * @param {RenderBlock[]} pendingTools - Pending (streaming) tool call blocks
     * @returns {RenderData} Full render data for replaceOutput
     */
    updateActive(contentBlocks: string[], reasoning: string, pendingTools: RenderBlock[]): RenderData {
        // L2: visible content started → reasoning is complete, lock it. An empty block (an SDK
        // `text_start` that has not emitted a delta yet) is not content the user can see.
        const hasVisibleContent = contentBlocks.some(text => text.length > 0);
        if (!this.reasoningLocked && hasVisibleContent && this.activeReasoning.length > 0) {
            this.committedBlocks.push({
                type: 'reasoning',
                markdown: this.activeReasoning,
                collapsed: true
            });
            this.activeReasoning = '';
            this.reasoningLocked = true;
        }
        this.contentBlocks = contentBlocks;
        // L2: a text block is complete as soon as a later content block exists. The SDK only
        // appends, so everything but the trailing block is final.
        this.commitContentBlocks(Math.max(contentBlocks.length - 1, 0));
        // Keep only the still-unlocked sections in the active area
        this.activeReasoning = this.reasoningLocked ? '' : reasoning;
        this.activeTools = pendingTools;
        return this.getRenderData();
    }

    /**
     * L1 lock: commits all remaining active content at the end of a round.
     * @description Called once a stream settles. On success that is right after the stream and
     * before tool execution; on failure the runner calls {@link commitPartialOutput} to lock the
     * partial output the failed stream already showed, so the error block is appended below it.
     * The block/reasoning arguments are authoritative when non-empty and act as a fallback for
     * sections that never passed through updateActive; passing them empty therefore commits
     * exactly what is currently tracked. Per-round content state is then reset for the next
     * round. When usage is provided it is appended as a dedicated usage block (see
     * {@link appendUsage}).
     *
     * Pending tool placeholders are deliberately left in the active area: the round's
     * own tool calls are still executing, and their placeholders are only replaced as
     * each finished block is committed (see {@link appendBlock}). Clearing them here
     * would blank the running tool calls between the round commit and the first result.
     * @param {string[]} contentBlocks - Final text blocks of the round, in order
     * @param {string} reasoning - Final accumulated reasoning of the round
     * @param {BlockUsage} [usage] - Token/cost of the assistant message that produced this round
     *
     * One usage block per round, on every path: content rounds, tool rounds (the block precedes
     * the round's tool blocks, which are appended later during tool execution), and reasoning-only
     * rounds. .mtm hydration mirrors this order in serializer.buildInteractionRenderBlocks.
     */
    commitRoundUI(contentBlocks: string[], reasoning: string, usage?: BlockUsage): void {
        const pendingReasoning = this.reasoningLocked ? '' : (this.activeReasoning || reasoning);
        if (pendingReasoning) {
            this.committedBlocks.push({
                type: 'reasoning',
                markdown: pendingReasoning,
                collapsed: true
            });
        }
        // The caller's final block list is authoritative; a round whose stream never reported
        // progress has no tracked blocks at all and is rendered from this fallback alone.
        if (contentBlocks.length > 0) this.contentBlocks = contentBlocks;
        this.commitContentBlocks(this.contentBlocks.length);
        this.appendUsage(usage);
        this.reasoningLocked = false;
        this.activeReasoning = '';
        this.contentBlocks = [];
        this.committedContentCount = 0;
        // activeTools is intentionally preserved; see this method's contract above.
    }

    /**
     * Commits the output a stream already showed, for a round that will not complete.
     * @description Used by the failure path before appending the error block, so the partial
     * answer stays above the error. Delegates to {@link commitRoundUI} with empty arguments,
     * which commits exactly what is currently tracked and appends no usage; named separately so
     * the caller's intent is legible without reading commitRoundUI's argument contract.
     */
    commitPartialOutput(): void {
        this.commitRoundUI([], '');
    }

    /**
     * Locks every tracked text block below the given block count into committed.
     * @description Empty blocks carry nothing to render and are skipped; they still advance
     * the commit cursor so block indices stay aligned with the SDK's content array.
     * @param {number} upTo - Number of leading content blocks that are final
     */
    private commitContentBlocks(upTo: number): void {
        while (this.committedContentCount < upTo) {
            const markdown = this.contentBlocks[this.committedContentCount];
            this.committedContentCount++;
            if (markdown) this.committedBlocks.push({ type: 'content', markdown });
        }
    }

    /**
     * Appends a round's token/cost block; no-op without usage.
     * @description Separate from {@link commitRoundUI} so the degenerate no-content round in
     * AgentRunner can emit its usage without inventing an empty content block.
     * @param {BlockUsage} [usage] - Token/cost of the assistant message that produced the round
     */
    appendUsage(usage?: BlockUsage): void {
        if (usage) this.committedBlocks.push({ type: 'usage', usage });
    }

    /**
     * L3 lock: appends a completed block (e.g. a finished tool call) to committed.
     * @description A finished tool call resolves its streaming placeholder via
     * {@link resolvePendingTool}.
     * @param {RenderBlock} block - The block to commit
     */
    appendBlock(block: RenderBlock): void {
        this.committedBlocks.push(block);
        if (block.type === 'toolCall') this.resolvePendingTool(block);
    }

    /**
     * Drops the placeholder a finished tool call supersedes.
     * @description Placeholders are display-only, so a wrong guess costs less than a phantom
     * "running" block: match by tool-call ID, then by name, then take the leading placeholder.
     * The name/head fallbacks also cover placeholders or results that carry no ID (older
     * callers, and the `toolCallId` field is optional on both sides).
     * @param {Extract<RenderBlock, { type: 'toolCall' }>} block - The finished tool call
     */
    private resolvePendingTool(block: Extract<RenderBlock, { type: 'toolCall' }>): void {
        const placeholders = this.activeTools;
        if (placeholders.length === 0) return;
        const isToolCall = (candidate: RenderBlock): candidate is Extract<RenderBlock, { type: 'toolCall' }> =>
            candidate.type === 'toolCall';
        let index = -1;
        if (block.toolCallId !== undefined) {
            index = placeholders.findIndex(candidate => isToolCall(candidate) && candidate.toolCallId === block.toolCallId);
        }
        if (index < 0) {
            index = placeholders.findIndex(candidate => isToolCall(candidate) && candidate.name === block.name);
        }
        if (index < 0) index = placeholders.findIndex(isToolCall);
        if (index >= 0) placeholders.splice(index, 1);
    }

    /**
     * Finalizes the run and produces the terminal frame.
     * @description The single terminal point for the runner. It drops tool placeholders that
     * can never complete — a kept one would render as a tool call that runs forever — and
     * leaves any still-active content/reasoning in place: a stream cancelled mid-flight has
     * only reached the active area, and that partial answer is still what the user saw. A
     * failed stream is different: the runner already locked its partial output into committed
     * via {@link commitPartialOutput} before appending the error block, so active holds
     * nothing but placeholders by the time this runs. Never touches the committed blocks.
     * @returns {RenderData} The frame to publish as the run's last word
     */
    endRun(): RenderData {
        this.activeTools = [];
        return this.getRenderData();
    }

    /**
     * Formats a tool call as a structured RenderBlock.
     * @description Argument separation (regular args vs code-block args) is deferred
     * to the renderer via renderingConfig; no HTML is generated here.
     * @param {string} name - Tool name
     * @param {any} toolArgs - Tool arguments (complete or partial)
     * @param {string} prettyPrintSummary - Human-readable summary
     * @param {boolean} isStreaming - Whether this is a pending/streaming tool call
     * @param {string} [toolResult] - Execution result (for finished calls)
     * @param {Object} [renderingConfig] - Code-block rendering hints for the renderer
     * @param {string} [toolCallId] - Provider tool-call ID (placeholder/result pairing)
     * @returns {RenderBlock} The tool call render block
     */
    formatToolCall(
        name: string,
        toolArgs: any,
        prettyPrintSummary: string,
        isStreaming: boolean,
        toolResult?: string,
        renderingConfig?: { argsToCodeBlock?: string[]; codeBlockFilePaths?: (string | undefined)[] },
        toolCallId?: string
    ): RenderBlock {
        const safeArgs = (typeof toolArgs === 'object' && toolArgs !== null) ? toolArgs : {};
        return {
            type: 'toolCall',
            name,
            ...(toolCallId ? { toolCallId } : {}),
            args: safeArgs,
            summary: prettyPrintSummary,
            result: toolResult,
            isStreaming,
            renderingConfig
        };
    }

    /**
     * Formats pending (streaming) tool calls as RenderBlocks.
     * @description Iterates through partial tool calls, best-effort parses their
     * arguments, and looks up pretty print summaries and rendering configs.
     * @param {any[]} partialToolCalls - Partial tool call objects from the stream
     * @param {ToolSet} toolSet - Tool set instance for looking up tool metadata
     * @param {boolean} _isSubAgent - Whether the caller is a sub-agent session
     * @returns {RenderBlock[]} Pending tool call blocks
     */
    formatPendingToolCalls(
        partialToolCalls: ToolCall[] | undefined,
        toolSet: ToolSet,
        _isSubAgent?: boolean
    ): RenderBlock[] {
        if (!partialToolCalls || partialToolCalls.length === 0) {
            return [];
        }
        const blocks: RenderBlock[] = [];
        for (const ptc of partialToolCalls) {
            const toolName = ptc.name;
            if (!toolName) { continue; }
            const args = ptc.arguments ?? {};
            const summary = toolSet.getPrettyPrint(toolName, args);
            const config = toolSet.getRenderingConfig(toolName);
            blocks.push(this.formatToolCall(toolName, args, summary, true, undefined, config, ptc.id));
        }
        return blocks;
    }

    /**
     * Gets the full render data (committed + active).
     * @returns {RenderData} Current render data; active is null when nothing is streaming
     */
    getRenderData(): RenderData {
        const activeContent = this.committedContentCount < this.contentBlocks.length
            ? this.contentBlocks[this.contentBlocks.length - 1]
            : '';
        const hasActive = this.activeReasoning.length > 0 ||
                          activeContent.length > 0 ||
                          this.activeTools.length > 0;
        return {
            committed: [...this.committedBlocks],
            active: hasActive ? {
                reasoning: this.activeReasoning,
                content: activeContent,
                pendingTools: [...this.activeTools]
            } : null
        };
    }
}
