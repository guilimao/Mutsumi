/**
 * @fileoverview pi-ai's authoritative thinking-level vocabulary and its canonical order.
 * @module llm/thinkingLevels
 */

import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

/**
 * Canonical level order.
 * @description An exhaustive `Record` rather than an array literal: a level added to or removed
 * from the SDK union makes this object fail type-check instead of silently missing from every
 * UI list and validation set derived from {@link MODEL_THINKING_LEVELS}.
 */
const THINKING_LEVEL_ORDER: Record<ModelThinkingLevel, number> = {
    off: 0,
    minimal: 1,
    low: 2,
    medium: 3,
    high: 4,
    xhigh: 5,
    max: 6,
};

/** Concrete levels in canonical order (no `'default'` sentinel). */
export const MODEL_THINKING_LEVELS: readonly ModelThinkingLevel[] =
    (Object.keys(THINKING_LEVEL_ORDER) as ModelThinkingLevel[])
        .sort((a, b) => THINKING_LEVEL_ORDER[a] - THINKING_LEVEL_ORDER[b]);

/** Runtime membership test for values arriving from settings, `.mtm` metadata, or HTTP. */
export function isModelThinkingLevel(value: string): value is ModelThinkingLevel {
    return Object.prototype.hasOwnProperty.call(THINKING_LEVEL_ORDER, value);
}
