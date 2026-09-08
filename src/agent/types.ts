/**
 * @fileoverview Agent module type definitions for the Mutsumi VSCode extension.
 * @module agent/types
 */

import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { AgentStateInfo, AgentRuntimeStatus } from '../types';
import type { AgentMessage } from '../types';

// Re-export imported types
export type { AgentStateInfo, AgentRuntimeStatus };

/** Concrete reasoning effort levels sent to the LLM provider — pi-ai's authoritative vocabulary. */
export type ReasoningEffort = ModelThinkingLevel;

/** User-configurable reasoning effort values, including provider-default behavior. */
export type ReasoningEffortSetting = ReasoningEffort | 'default';

/**
 * Supported reasoning effort setting values in display order.
 * @remarks QuickPick and HTTP validation import this constant directly as the single source of truth.
 * The concrete levels are typed against the SDK union, so vocabulary drift on SDK upgrades fails type-check.
 */
export const REASONING_EFFORT_SETTING_VALUES: readonly ReasoningEffortSetting[] = [
    'default',
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
];

/** Concrete levels derived from the single source of truth above (no 'default' sentinel). */
export const MODEL_THINKING_LEVELS: readonly ReasoningEffort[] =
    REASONING_EFFORT_SETTING_VALUES.filter((value): value is ReasoningEffort => value !== 'default');

/** Pre-v1.3 persisted vocabulary; mapped on read so legacy `.mtm` files keep working. */
const LEGACY_REASONING_EFFORT_ALIASES: Readonly<Record<string, ReasoningEffort>> = {
    none: 'off'
};

/**
 * Normalizes a configured reasoning effort for request transmission without mutating the value.
 * @param {string | undefined | null} value - Raw metadata or configuration value
 * @returns {string | undefined} Undefined for null, undefined, an empty string, or the exact
 * 'default' sentinel; the legacy value 'none' maps to the SDK level 'off'; every other string is
 * returned unchanged
 * @remarks Values are intentionally not trimmed or otherwise rewritten here. Unknown or
 * whitespace-bearing values are rejected with a visible local error by LLMClient's vocabulary
 * gate before the request is built (docs/reasoning-effort-target-state.md D6): they cannot be
 * passed through to the server, because pi-ai clamps unknown levels to the first supported one
 * during request construction, which would silently hide them.
 */
export function normalizeReasoningEffort(value: string | undefined | null): string | undefined {
    if (value === null || value === undefined || value === '' || value === 'default') return undefined;
    return LEGACY_REASONING_EFFORT_ALIASES[value] ?? value;
}

/**
 * Maps an inbound request-body value onto the canonical vocabulary before membership validation.
 * HTTP endpoints accept the legacy alias so older clients keep working; persisted values
 * are always written back in canonical form.
 */
export function canonicalReasoningEffortSetting(value: string): string {
    return LEGACY_REASONING_EFFORT_ALIASES[value] ?? value;
}

/**
 * Options for configuring the agent runner.
 * @interface AgentRunOptions
 */
export interface AgentRunOptions {
    /** Model identifier to use for LLM calls */
    model: string;
    /** Provider route serving the selected model */
    provider: string;
    /** Maximum number of tool interaction loops */
    maxLoops?: number;
    /** Reasoning effort resolved and injected by the caller; the runner does not read global configuration */
    reasoningEffort?: string;
}

/** Provider-ready conversation state; system instructions are not persisted as messages. */
export interface AgentRunContext {
    systemPrompt?: string;
    messages: AgentMessage[];
}

export type AgentRunStatus = 'completed' | 'failed' | 'cancelled';

export interface AgentRunFailure {
    code: string;
    message: string;
}

/** Outcome of one run. Only native messages in this result may be persisted. */
export interface AgentRunResult {
    messages: AgentMessage[];
    status: AgentRunStatus;
    error?: AgentRunFailure;
}
