import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

/** Non-secret configuration for a user-defined OpenAI-compatible route. */
export interface CustomProviderProfile {
    displayName?: string;
    baseUrl: string;
    api?: 'openai-completions' | 'openai-responses';
    auth?: 'apiKey' | 'none';
    models?: string[];
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
