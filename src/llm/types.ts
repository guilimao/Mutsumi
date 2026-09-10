import type {
    Api,
    Model,
    ModelThinkingLevel,
    OpenAICompletionsCompat,
    OpenAIResponsesCompat,
    ThinkingLevelMap,
} from '@earendil-works/pi-ai';

/**
 * Model capability fields a user may declare. Their shapes are pi-ai's own `Model` fields, so a
 * declaration can be handed to the SDK without a translation layer.
 */
type DeclaredModelFields = Pick<Model<Api>, 'name' | 'reasoning' | 'input' | 'contextWindow' | 'maxTokens'>;

/**
 * Capability overrides for one user-declared model (docs/custom-model-capabilities.md).
 * Undeclared `reasoning`/`input` fall back to optimistic provider defaults.
 */
export interface CustomModelSpec extends Partial<DeclaredModelFields> {
    id: string;
    /** Advanced: pi-ai thinkingLevelMap passthrough; keys must be pi-ai levels, values stay opaque. */
    thinkingLevelMap?: ThinkingLevelMap;
    /** Advanced opaque passthrough of pi-ai compat flags; unspecified fields keep URL-detected defaults. */
    compat?: Partial<OpenAICompletionsCompat> & Partial<OpenAIResponsesCompat>;
}

/** Provider-wide capability defaults applied beneath per-model specs. */
export type CustomProviderCapabilities = Partial<Pick<Model<Api>, 'reasoning' | 'input'>>;

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

/**
 * Model information exposed to Mutsumi UI and configuration validation. The model fields are
 * pi-ai's own `Model` fields; only the provider label and the derived effort list are Mutsumi-specific.
 */
export interface ModelInfo extends Readonly<Pick<Model<Api>, 'id' | 'name' | 'input' | 'contextWindow' | 'maxTokens'>> {
    provider: string;
    /** pi-ai vocabulary, derived via getSupportedThinkingLevels; empty when the model declares no reasoning. */
    reasoningEfforts: readonly ModelThinkingLevel[];
}
