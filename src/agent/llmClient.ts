/** Provider-neutral LLM client backed directly by pi-ai's native Context and events. */

import type {
    AssistantMessage,
    AssistantMessageEvent,
    SimpleStreamOptions,
    ThinkingLevel,
} from '@earendil-works/pi-ai';
import type { AgentMessage } from '../types';
import type { ToolDefinition } from '../tools.d/interface';
import { toPiContext } from '../llm/context';
import { LlmProviderService } from '../llm/providerService';

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

    private streamOptions(options: ChatCompletionOptions): SimpleStreamOptions {
        const raw = this.reasoningEffort === 'none' ? 'off' : this.reasoningEffort;
        const allowed = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
        if (raw !== undefined && !allowed.includes(raw)) throw new Error(`Unsupported reasoning effort "${raw}"`);
        return {
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
        return error;
    }
}
