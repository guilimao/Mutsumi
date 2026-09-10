/**
 * Reasoning-effort normalization contract: the only rewrite is the pre-v1.3 `none` alias.
 * Everything else must round-trip untouched so the vocabulary gate downstream — not this
 * normalizer — is what rejects unknown levels.
 */

import { describe, expect, it } from 'vitest';
import { canonicalReasoningEffortSetting, normalizeReasoningEffort } from '../src/agent/types';

describe('normalizeReasoningEffort', () => {
    it('drops the provider-default sentinels and keeps concrete levels', () => {
        expect(normalizeReasoningEffort(undefined)).toBeUndefined();
        expect(normalizeReasoningEffort(null)).toBeUndefined();
        expect(normalizeReasoningEffort('')).toBeUndefined();
        expect(normalizeReasoningEffort('default')).toBeUndefined();
        expect(normalizeReasoningEffort('high')).toBe('high');
        expect(normalizeReasoningEffort('off')).toBe('off');
    });

    it('maps the legacy none alias onto the SDK level off', () => {
        expect(normalizeReasoningEffort('none')).toBe('off');
        expect(canonicalReasoningEffortSetting('none')).toBe('off');
    });

    it('passes unknown strings through, including Object.prototype member names', () => {
        // A lookup table would answer these with a function or object instead of a string.
        for (const value of ['constructor', 'toString', '__proto__', 'valueOf', 'bogus']) {
            expect(normalizeReasoningEffort(value)).toBe(value);
            expect(canonicalReasoningEffortSetting(value)).toBe(value);
        }
    });
});
