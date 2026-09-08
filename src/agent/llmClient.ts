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
        this.assertReasoningSupported(prepared.model);
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
        this.assertReasoningSupported(prepared.model);
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

    setModel(model: string): void {
        this.model = model;
    }

    getModel(): string {
        return this.model;
    }

    /**
     * Turns silent degradation into a visible local error (docs/custom-model-capabilities.md C5):
     * a model that declares no reasoning would otherwise have its effort value clamped away
     * silently by the SDK. Partial thinkingLevelMap gaps stay with the SDK's clamping.
     */
    private assertReasoningSupported(model: Model<Api>): void {
        const effort = this.reasoningEffort;
        if (effort === undefined || effort === 'off') return;
        if (getSupportedThinkingLevels(model).includes(effort as ModelThinkingLevel)) return;
        if (!MODEL_THINKING_LEVELS.includes(effort as ReasoningEffort)) {
            throw new Error(`Unsupported reasoning effort "${effort}"`);
        }
        if (!model.reasoning) {
            throw new Error(
                `Reasoning effort "${effort}" is set, but ${model.provider}/${model.id} declares no reasoning. `
                + 'Remove the reasoning effort override, or declare the model capabilities in mutsumi.customProviders.',
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
        const error = new Error(message.errorMessage ?? `Provider stopped with ${message.stopReason}`);
        if (message.stopReason === 'aborted') error.name = 'AbortError';
        // Preserve the pi-ai AssistantMessage so retry classification can use the SDK's
        // isRetryableAssistantError instead of local error-string matching.
        (error as Error & { mutsumiAssistantMessage?: AssistantMessage }).mutsumiAssistantMessage = message;
        return error;
    }
}
