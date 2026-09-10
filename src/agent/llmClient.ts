/** Provider-neutral LLM client backed directly by pi-ai's native Context and events. */

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type {
    AssistantMessage,
    AssistantMessageEvent,
    Model,
    ModelThinkingLevel,
    SimpleStreamOptions,
    ThinkingLevel,
} from '@earendil-works/pi-ai';
import type { Api } from '@earendil-works/pi-ai';
import type { AgentMessage } from '../types';
import type { ToolDefinition } from '../tools.d/interface';
import { toPiContext } from '../llm/context';
import { LlmProviderService } from '../llm/providerService';
import { MODEL_THINKING_LEVELS, type ReasoningEffort } from './types';

export interface LLMClientConfig {
    provider: string;
    model: string;
    reasoningEffort?: string;
}

export interface ChatCompletionOptions {
    systemPrompt?: string;
    messages: AgentMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
}

/** One request is frozen to a provider registry snapshot and returns native pi-ai messages. */
export class LLMClient {
    private model: string;
    private readonly provider: string;
    private readonly reasoningEffort: string | undefined;

    constructor(config: LLMClientConfig) {
        this.provider = config.provider;
        this.model = config.model;
        this.reasoningEffort = config.reasoningEffort;
    }

    async chatCompletion(options: ChatCompletionOptions): Promise<AssistantMessage> {
        const prepared = LlmProviderService.getInstance().prepare(this.provider, this.model);
        this.assertReasoningSupported(prepared.model, prepared.isBuiltIn);
        const result = await prepared.models.completeSimple(
            prepared.model,
            toPiContext(options.systemPrompt, options.messages, options.tools),
            this.streamOptions(options),
        );
        if (result.stopReason === 'error' || result.stopReason === 'aborted') throw this.providerError(result);
        return result;
    }

    async *streamChatCompletion(options: ChatCompletionOptions): AsyncIterableIterator<AssistantMessageEvent> {
        const prepared = LlmProviderService.getInstance().prepare(this.provider, this.model);
        this.assertReasoningSupported(prepared.model, prepared.isBuiltIn);
        const events = prepared.models.streamSimple(
            prepared.model,
            toPiContext(options.systemPrompt, options.messages, options.tools),
            this.streamOptions(options),
        );
        for await (const event of events) {
            if (event.type === 'error') throw this.providerError(event.error);
            yield event;
            if (event.type === 'done') return;
        }
        throw new Error('Provider stream ended without a terminal event');
    }

    /**
     * Context window of the current model for usage display, or undefined when the model is no
     * longer resolvable (e.g. the provider catalog was reloaded mid-run). Display-only: a
     * missing value degrades the indicator, it must never fail the run.
     */
    getContextWindow(): number | undefined {
        try {
            return LlmProviderService.getInstance().prepare(this.provider, this.model).model.contextWindow;
        } catch {
            return undefined;
        }
    }

    setModel(model: string): void {
        this.model = model;
    }

    getModel(): string {
        return this.model;
    }

    /**
     * Turns silent degradation into a visible local error (docs/custom-model-capabilities.md C5):
     * a model that declares no reasoning would otherwise have its effort value clamped away
     * silently by the SDK. Unknown vocabulary is rejected here too — the SDK would clamp unknown
     * levels to the first supported one during request building, so they can never reach the
     * server for a provider 400. `off` is checked as well (docs/reasoning-effort-target-state.md
     * D6 v1.5): when a model's thinkingLevelMap disables `off`, the SDK clamps it *upward* to the
     * first available level, turning a request to disable reasoning into one that enables it.
     * Partial thinkingLevelMap gaps (incl. xhigh/max without a declared map on reasoning-capable
     * models) stay with the SDK's clamping, matching how SDK catalog models behave; QuickPick
     * only offers getSupportedThinkingLevels members.
     */
    private assertReasoningSupported(model: Model<Api>, isBuiltIn: boolean): void {
        const effort = this.reasoningEffort;
        if (effort === undefined) return;
        if (getSupportedThinkingLevels(model).includes(effort as ModelThinkingLevel)) return;
        if (effort === 'off') {
            const remedy = isBuiltIn
                ? 'Remove the reasoning effort override; built-in model capabilities come from the pi-ai catalog and cannot be redeclared.'
                : 'Remove the reasoning effort override, or drop the thinkingLevelMap entry that disables "off" for this model in mutsumi.customProviders.';
            throw new Error(
                `Reasoning effort "off" is set, but ${model.provider}/${model.id} cannot disable reasoning. ${remedy}`,
            );
        }
        if (!MODEL_THINKING_LEVELS.includes(effort as ReasoningEffort)) {
            throw new Error(`Unsupported reasoning effort "${effort}"`);
        }
        if (!model.reasoning) {
            const remedy = isBuiltIn
                ? 'Remove the reasoning effort override; built-in model capabilities come from the pi-ai catalog and cannot be redeclared.'
                : 'Remove the reasoning effort override, or declare reasoning: true for this model in mutsumi.customProviders.';
            throw new Error(
                `Reasoning effort "${effort}" is set, but ${model.provider}/${model.id} declares no reasoning. ${remedy}`,
            );
        }
    }

    private streamOptions(options: ChatCompletionOptions): SimpleStreamOptions {
        const raw = this.reasoningEffort;
        return {
            // pi-ai types SimpleStreamOptions.reasoning as ThinkingLevel (without 'off'), but the
            // runtime accepts the full ModelThinkingLevel; 'off' is the SDK's own disable level.
            ...(raw === undefined ? {} : { reasoning: raw as ThinkingLevel }),
            ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
            ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            maxRetries: 0,
        };
    }

    private providerError(message: AssistantMessage): Error {
        return new ProviderStreamError(message);
    }
}

/**
 * Provider failure carrying the native pi-ai AssistantMessage. Retry classification uses
 * {@link assistantMessage} with the SDK's isRetryableAssistantError instead of local
 * error-string matching; errors without one (registry/auth/local validation failures) are
 * deterministic and never retried.
 */
export class ProviderStreamError extends Error {
    constructor(readonly assistantMessage: AssistantMessage) {
        super(assistantMessage.errorMessage ?? `Provider stopped with ${assistantMessage.stopReason}`);
        this.name = assistantMessage.stopReason === 'aborted' ? 'AbortError' : 'ProviderStreamError';
    }
}
