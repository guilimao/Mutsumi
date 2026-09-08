/**
 * UIRenderer usage-attach semantics. Committed blocks are rendered once and never
 * re-rendered, so a round's token/cost usage must be present on the block's FIRST
 * committed frame: either on content committed by commitRoundUI (terminal content
 * round) or on the first tool block appended afterwards by the round's tool execution.
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

describe('UIRenderer usage attach', () => {
    it('attaches usage to content committed by commitRoundUI (terminal content round)', () => {
        const renderer = new UIRenderer();
        renderer.updateActive('all done', '', []);
        renderer.commitRoundUI('all done', '', usage);
        const data = renderer.getCommittedRenderData();
        expect(data.committed).toEqual([
            expect.objectContaining({ type: 'content', markdown: 'all done', usage }),
        ]);
    });

    it('carries usage to the first tool block appended after a tool round', () => {
        const renderer = new UIRenderer();
        // Tool round: nothing was pending at commit time (no content/reasoning to commit).
        renderer.commitRoundUI('', '', usage);
        renderer.appendBlock(toolBlock('read'));
        renderer.appendBlock(toolBlock('write'));
        const data = renderer.getCommittedRenderData();
        expect((data.committed[0] as { usage?: unknown }).usage).toEqual(usage);
        // One badge per round: later blocks of the same round stay clean.
        expect((data.committed[1] as { usage?: unknown }).usage).toBeUndefined();
    });

    it('does not double-attach when the round already committed a content block', () => {
        const renderer = new UIRenderer();
        renderer.commitRoundUI('done', '', usage);
        renderer.appendBlock(toolBlock('read'));
        const data = renderer.getCommittedRenderData();
        expect((data.committed[0] as { usage?: unknown }).usage).toEqual(usage);
        expect((data.committed[1] as { usage?: unknown }).usage).toBeUndefined();
    });

    it('clears pending usage when the next round commits without usage', () => {
        const renderer = new UIRenderer();
        renderer.commitRoundUI('', '', usage);
        renderer.commitRoundUI('second', '', undefined);
        renderer.appendBlock(toolBlock('read'));
        const data = renderer.getCommittedRenderData();
        // The pending usage from the first (tool) round must not leak onto the next round's blocks.
        expect(data.committed).toHaveLength(2);
        expect((data.committed[0] as { usage?: unknown }).usage).toBeUndefined();
        expect((data.committed[1] as { usage?: unknown }).usage).toBeUndefined();
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
