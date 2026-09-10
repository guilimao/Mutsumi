/**
 * Projection of a persisted assistant message's usage + Mutsumi measurements into the
 * serializable BlockUsage footer IR. Token accounting is pi-ai's; the measurements
 * (context window, TTFT, generation time) are display-only and must be dropped when junk
 * so the renderer never prints a misleading zero.
 */

import { describe, expect, it } from 'vitest';
import { toBlockUsage } from '../src/notebook/renderTypes';

const usage = {
    input: 100,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    totalTokens: 190,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0005 },
} as any;

describe('toBlockUsage', () => {
    it('fills in the SDK total when the provider omits it', () => {
        const projected = toBlockUsage({ ...usage, totalTokens: 0 });
        expect(projected?.totalTokens).toBe(190);
    });

    it('carries the measurements when they are present', () => {
        const projected = toBlockUsage(usage, { contextWindow: 200_000, ttftMs: 350, generationMs: 1200 });
        expect(projected).toMatchObject({ contextWindow: 200_000, ttftMs: 350, generationMs: 1200 });
    });

    it('drops absent, zero, negative and non-numeric measurements', () => {
        const projected = toBlockUsage(usage, { ttftMs: 0 } as any);
        expect(projected).not.toHaveProperty('ttftMs');

        const junk = toBlockUsage(usage, {
            contextWindow: -1,
            ttftMs: Number.NaN,
            generationMs: 'soon',
        } as any);
        expect(junk).not.toHaveProperty('contextWindow');
        expect(junk).not.toHaveProperty('ttftMs');
        expect(junk).not.toHaveProperty('generationMs');
    });

    it('returns undefined for a usage without countable tokens', () => {
        expect(toBlockUsage({ cost: { total: 1 } } as any)).toBeUndefined();
        expect(toBlockUsage(undefined)).toBeUndefined();
    });
});
