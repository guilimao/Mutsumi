import type {
    ModelThinkingLevel,
    OpenAICompletionsCompat,
    OpenAIResponsesCompat,
    ThinkingLevelMap,
} from '@earendil-works/pi-ai';

/** Capability overrides for one user-declared model (docs/custom-model-capabilities.md). */
export interface CustomModelSpec {
    id: string;
    name?: string;
    /** Declares whether the model can reason; undeclared falls back to optimistic provider defaults. */
    reasoning?: boolean;
    /** Declares accepted input modalities; undeclared falls back to optimistic provider defaults. */
    input?: ('text' | 'image')[];
    contextWindow?: number;
    maxTokens?: number;
    /** Advanced: pi-ai thinkingLevelMap passthrough; keys must be pi-ai levels, values stay opaque. */
    thinkingLevelMap?: ThinkingLevelMap;
    /** Advanced opaque passthrough of pi-ai compat flags; unspecified fields keep URL-detected defaults. */
    compat?: Partial<OpenAICompletionsCompat> & Partial<OpenAIResponsesCompat>;
}

/** Provider-wide capability defaults applied beneath per-model specs. */
export interface CustomProviderCapabilities {
    reasoning?: boolean;
    input?: ('text' | 'image')[];
}

/** Non-secret configuration for a user-defined OpenAI-compatible route. */
export interface CustomProviderProfile {
    displayName?: string;
    baseUrl: string;
    api?: 'openai-completions' | 'openai-responses';
    auth?: 'apiKey' | 'none';
    /** Model IDs as strings or capability-declaring specs; string form is shorthand for `{ id }`. */
    models?: (string | CustomModelSpec)[];
    capabilities?: CustomProviderCapabilities;
}

/** Provider information suitable for selectors and status UI. */
export interface ProviderInfo {
    id: string;
    name: string;
    isCustom: boolean;
    isDynamic: boolean;
    configured: boolean;
    canConfigureApiKey: boolean;
    authSource?: string;
    modelCount: number;
}

/** Model information exposed to Mutsumi UI and configuration validation. */
export interface ModelInfo {
    id: string;
    name: string;
    provider: string;
    input: readonly ('text' | 'image')[];
    contextWindow: number;
    maxTokens: number;
    /** pi-ai vocabulary, derived via getSupportedThinkingLevels; empty when the model declares no reasoning. */
    reasoningEfforts: readonly ModelThinkingLevel[];
}
