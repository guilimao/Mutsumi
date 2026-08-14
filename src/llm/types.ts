import type { Api, AssistantMessage } from '@earendil-works/pi-ai';

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
    reasoningEfforts: readonly string[];
}

export type PiAiReplayBlock =
    | { type: 'text'; text: string; textSignature?: string }
    | { type: 'reasoning'; text: string; thinkingSignature?: string; redacted?: boolean }
    | { type: 'tool-call'; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string };

/** Versioned provider-native state required for safe multi-turn replay. */
export interface PiAiReplayState {
    kind: 'pi-ai';
    version: 1;
    api: Api;
    provider: string;
    model: string;
    responseModel?: string;
    responseId?: string;
    stopReason: AssistantMessage['stopReason'];
    blocks: PiAiReplayBlock[];
}

/** Metadata written on tool messages so providers receive correct error semantics. */
export interface ToolMessageMetadata {
    isError?: boolean;
}

/** Reserved Mutsumi metadata fields used by the LLM adapter. */
export interface LlmMessageMetadata extends ToolMessageMetadata {
    piAiReplay?: PiAiReplayState;
}
