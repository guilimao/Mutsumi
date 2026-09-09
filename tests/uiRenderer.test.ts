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
        renderer.updateActive('all done', '', []);
        renderer.commitRoundUI('all done', '', usage);
        const data = renderer.getCommittedRenderData();
        expect(data.committed).toEqual([
            expect.objectContaining({ type: 'content', markdown: 'all done' }),
            { type: 'usage', usage },
        ]);
    });

    it('emits the usage block of a tool round before the tool blocks it owns', () => {
        const renderer = new UIRenderer();
        // Tool round: nothing was pending at commit time (no content/reasoning to commit).
        renderer.commitRoundUI('', '', usage);
        renderer.appendBlock(toolBlock('read'));
        renderer.appendBlock(toolBlock('write'));
        const data = renderer.getCommittedRenderData();
        // The usage belongs to the assistant message that issued the calls; the round's tool
        // blocks are appended later, during tool execution.
        expect(data.committed.map(block => block.type)).toEqual(['usage', 'toolCall', 'toolCall']);
    });

    it('emits one usage block per round and none without usage', () => {
        const renderer = new UIRenderer();
        renderer.commitRoundUI('', '', usage);
        renderer.commitRoundUI('second', '', undefined);
        renderer.appendBlock(toolBlock('read'));
        const data = renderer.getCommittedRenderData();
        expect(data.committed.map(block => block.type)).toEqual(['usage', 'content', 'toolCall']);
    });

    it('covers reasoning-only rounds', () => {
        const renderer = new UIRenderer();
        renderer.updateActive('', 'ponder', []);
        renderer.commitRoundUI('', 'ponder', usage);
        expect(renderer.getCommittedRenderData().committed.map(block => block.type)).toEqual(['reasoning', 'usage']);
    });

    it('appendUsage emits the block without requiring round content', () => {
        const renderer = new UIRenderer();
        renderer.appendUsage(undefined);
        renderer.appendUsage(usage);
        expect(renderer.getCommittedRenderData().committed).toEqual([{ type: 'usage', usage }]);
    });
});

describe('toBlockUsage projection', () => {
    it('falls back totalTokens to input + output', () => {
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
