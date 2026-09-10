/**
 * UIRenderer usage semantics. Each assistant round's token/cost is committed as its own
 * `usage` block, so content, tool, and reasoning-only rounds all render the same footer and
 * no cross-module attach rule has to be mirrored by .mtm hydration.
 */

import { describe, expect, it } from 'vitest';
import { UIRenderer } from '../src/agent/uiRenderer';
import { toBlockUsage } from '../src/notebook/renderTypes';
import type { RenderBlock } from '../src/notebook/renderTypes';

const usage = toBlockUsage({
    input: 100, output: 20, totalTokens: 120, cost: { total: 0.0005 },
} as any)!;

function toolBlock(name: string): RenderBlock {
    return {
        type: 'toolCall',
        name,
        args: { path: 'a.ts' },
        summary: `Read ${name}`,
        isStreaming: false,
        result: 'ok',
    };
}

describe('UIRenderer usage blocks', () => {
    it('appends the round usage block after committed content', () => {
        const renderer = new UIRenderer();
        renderer.updateActive(['all done'], '', []);
        renderer.commitRoundUI(['all done'], '', usage);
        const data = renderer.getRenderData();
        expect(data.committed).toEqual([
            expect.objectContaining({ type: 'content', markdown: 'all done' }),
            { type: 'usage', usage },
        ]);
    });

    it('emits the usage block of a tool round before the tool blocks it owns', () => {
        const renderer = new UIRenderer();
        // Tool round: nothing was pending at commit time (no content/reasoning to commit).
        renderer.commitRoundUI([], '', usage);
        renderer.appendBlock(toolBlock('read'));
        renderer.appendBlock(toolBlock('write'));
        const data = renderer.getRenderData();
        // The usage belongs to the assistant message that issued the calls; the round's tool
        // blocks are appended later, during tool execution.
        expect(data.committed.map(block => block.type)).toEqual(['usage', 'toolCall', 'toolCall']);
    });

    it('emits one usage block per round and none without usage', () => {
        const renderer = new UIRenderer();
        renderer.commitRoundUI([], '', usage);
        renderer.commitRoundUI(['second'], '', undefined);
        renderer.appendBlock(toolBlock('read'));
        const data = renderer.getRenderData();
        expect(data.committed.map(block => block.type)).toEqual(['usage', 'content', 'toolCall']);
    });

    it('covers reasoning-only rounds', () => {
        const renderer = new UIRenderer();
        renderer.updateActive([], 'ponder', []);
        renderer.commitRoundUI([], 'ponder', usage);
        expect(renderer.getRenderData().committed.map(block => block.type)).toEqual(['reasoning', 'usage']);
    });

    it('appendUsage emits the block without requiring round content', () => {
        const renderer = new UIRenderer();
        renderer.appendUsage(undefined);
        renderer.appendUsage(usage);
        expect(renderer.getRenderData().committed).toEqual([{ type: 'usage', usage }]);
    });

    it('keeps pending placeholders across the round commit and resolves ID-less blocks by position (legacy fallback)', () => {
        const renderer = new UIRenderer();
        const pending = (name: string): RenderBlock => (
            { type: 'toolCall', name, args: {}, summary: name, isStreaming: true }
        );
        renderer.updateActive([], '', [pending('read'), pending('write')]);
        renderer.commitRoundUI([], '', usage);

        // The round is committed (usage lands) but its tool calls have not run yet, so their
        // running placeholders must stay in the active area instead of blinking out.
        const committedFrame = renderer.getRenderData();
        expect(committedFrame.committed).toEqual([{ type: 'usage', usage }]);
        expect(committedFrame.active?.pendingTools.map(block => block.type === 'toolCall' && block.name))
            .toEqual(['read', 'write']);

        renderer.appendBlock({ type: 'toolCall', name: 'read', args: {}, summary: 'read', isStreaming: false, result: 'ok' });
        const afterFirst = renderer.getRenderData();
        expect(afterFirst.committed.map(block => block.type)).toEqual(['usage', 'toolCall']);
        expect(afterFirst.active?.pendingTools.map(block => block.type === 'toolCall' && block.name))
            .toEqual(['write']);

        renderer.appendBlock({ type: 'toolCall', name: 'write', args: {}, summary: 'write', isStreaming: false, result: 'ok' });
        const afterAll = renderer.getRenderData();
        expect(afterAll.committed.map(block => block.type)).toEqual(['usage', 'toolCall', 'toolCall']);
        expect(afterAll.active).toBeNull();
    });

    it('resolves placeholders by tool-call ID, not by completion order', () => {
        const renderer = new UIRenderer();
        const pending = (id: string, name: string): RenderBlock => (
            { type: 'toolCall', name, toolCallId: id, args: {}, summary: name, isStreaming: true }
        );
        renderer.updateActive([], '', [pending('a', 'read'), pending('b', 'write')]);
        renderer.commitRoundUI([], '', usage);

        // The result of the second call arrives first; identity must win over position.
        renderer.appendBlock({ type: 'toolCall', name: 'write', toolCallId: 'b', args: {}, summary: 'write', isStreaming: false, result: 'ok' });
        expect(renderer.getRenderData().active?.pendingTools.map(block => block.type === 'toolCall' && block.name))
            .toEqual(['read']);

        renderer.appendBlock({ type: 'toolCall', name: 'read', toolCallId: 'a', args: {}, summary: 'read', isStreaming: false, result: 'ok' });
        expect(renderer.getRenderData().active).toBeNull();
        expect(renderer.getRenderData().committed.map(block => block.type))
            .toEqual(['usage', 'toolCall', 'toolCall']);
    });

    it('falls back to the tool name when placeholder and result do not share an ID', () => {
        const renderer = new UIRenderer();
        // Placeholder without an ID (older caller); the finished block carries the provider ID.
        renderer.updateActive([], '', [
            { type: 'toolCall', name: 'read', args: {}, summary: 'read', isStreaming: true },
        ]);
        renderer.commitRoundUI([], '', usage);

        renderer.appendBlock({ type: 'toolCall', name: 'read', toolCallId: 'a', args: {}, summary: 'read', isStreaming: false, result: 'ok' });
        expect(renderer.getRenderData().active).toBeNull();
    });

    it('produces the terminal frame: unresolved placeholders drop, partial output stays', () => {
        const renderer = new UIRenderer();
        renderer.updateActive(['partial answer'], '', [
            { type: 'toolCall', name: 'write', toolCallId: 'a', args: {}, summary: 'write', isStreaming: true },
        ]);

        // Run ended before the tool could finish: the placeholder cannot stay, the streamed
        // text can, and committed blocks are untouched.
        const terminal = renderer.endRun();
        expect(terminal.active?.pendingTools).toEqual([]);
        expect(terminal.active?.content).toBe('partial answer');
        expect(terminal.committed).toEqual([]);
    });
});

describe('UIRenderer content block tracking', () => {
    it('keeps text written after a tool call instead of losing it to the first block', () => {
        const renderer = new UIRenderer();
        // Streaming: text A, then a tool call, then text B (a second SDK content block).
        renderer.updateActive(['A'], '', []);
        renderer.updateActive(['A'], '', [toolBlock('read')]);
        // L2 seals A the moment a later content block shows up; B stays live until round end.
        const streaming = renderer.updateActive(['A', 'B'], '', [toolBlock('read')]);
        expect(streaming.committed).toEqual([{ type: 'content', markdown: 'A' }]);
        expect(streaming.active).toMatchObject({ content: 'B' });

        renderer.commitRoundUI(['A', 'B'], '', usage);
        for (const name of ['read']) renderer.appendBlock(toolBlock(name));
        expect(renderer.getRenderData().committed.map(block => block.type))
            .toEqual(['content', 'content', 'usage', 'toolCall']);
    });

    it('keeps reasoning unlocked while the content block is still empty', () => {
        const renderer = new UIRenderer();
        // `text_start` arrives before any delta: nothing visible has been written yet, so the
        // reasoning must not be sealed into a collapsed committed block.
        const frame = renderer.updateActive([''], 'ponder', []);
        expect(frame.committed).toEqual([]);
        expect(frame.active).toMatchObject({ reasoning: 'ponder', content: '' });

        renderer.updateActive(['first words'], 'ponder', []);
        expect(renderer.getRenderData().committed.map(block => block.type))
            .toEqual(['reasoning']);
    });

    it('commits a single text block only once, at round end', () => {
        const renderer = new UIRenderer();
        renderer.updateActive(['growing'], '', [toolBlock('read')]);
        renderer.updateActive(['growing more'], '', [toolBlock('read')]);
        renderer.commitRoundUI(['growing more'], '', undefined);
        const committed = renderer.getRenderData().committed;
        expect(committed).toEqual([{ type: 'content', markdown: 'growing more' }]);
    });

    it('resets per-block tracking between rounds', () => {
        const renderer = new UIRenderer();
        renderer.updateActive(['round one'], '', []);
        renderer.commitRoundUI(['round one'], '', undefined);
        renderer.updateActive(['round two'], '', []);
        renderer.commitRoundUI(['round two'], '', undefined);
        expect(renderer.getRenderData().committed).toEqual([
            { type: 'content', markdown: 'round one' },
            { type: 'content', markdown: 'round two' },
        ]);
    });
});

describe('toBlockUsage projection', () => {
    it('falls back totalTokens to the full token sum, cached input included', () => {
        expect(toBlockUsage({ input: 5, output: 3, cacheRead: 100, cacheWrite: 20 } as any)).toEqual({
            input: 5, output: 3, cacheRead: 100, cacheWrite: 20, totalTokens: 128, costTotal: 0,
        });
        expect(toBlockUsage({ input: 5, output: 3 } as any)).toEqual({
            input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, costTotal: 0,
        });
    });

    it('coerces non-numeric persisted junk to zero and drops empty usage', () => {
        expect(toBlockUsage(undefined)).toBeUndefined();
        expect(toBlockUsage({} as any)).toBeUndefined();
        expect(toBlockUsage({ input: 'abc' } as any)).toBeUndefined();
        expect(toBlockUsage({ input: -1 } as any)).toBeUndefined();
        expect(toBlockUsage({ input: 1, output: 2 } as any)).toMatchObject({ input: 1, output: 2 });
    });

    it('gates emptiness on tokens only: cost-only junk drops instead of rendering a $0.0000 badge', () => {
        expect(toBlockUsage({ cost: { total: 0.001 } } as any)).toBeUndefined();
        expect(toBlockUsage({
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { total: 0.001 },
        } as any)).toBeUndefined();
    });
});
