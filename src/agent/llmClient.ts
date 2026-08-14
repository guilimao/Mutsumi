/** Provider-neutral LLM client backed by pi-ai's multi-protocol catalog. */

import type { AssistantMessage, SimpleStreamOptions, ThinkingLevel } from '@earendil-works/pi-ai';
import type { AgentMessage } from '../types';
import type { ToolDefinition } from '../tools.d/interface';
import { toPiContext } from '../llm/context';
import { LlmProviderService } from '../llm/providerService';
import { toReplayState } from '../llm/replay';
import type { PiAiReplayState } from '../llm/types';

export interface LLMClientConfig {
    provider: string;
    model: string;
    reasoningEffort?: string;
}

export interface ChatCompletionOptions {
    messages: AgentMessage[];
    tools?: ToolDefinition[];
    tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
    temperature?: number;
    max_tokens?: number;
    signal?: AbortSignal;
}

export interface ChatCompletionResult {
    content: string | null;
    reasoning_content?: string;
    tool_calls?: any[];
    replayState?: PiAiReplayState;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface StreamChunk {
    content?: string;
    reasoning_content?: string;
    tool_calls?: any[];
    replayState?: PiAiReplayState;
    done: boolean;
}

function visibleParts(message: AssistantMessage): Omit<ChatCompletionResult, 'usage'> {
    const texts: string[] = [];
    const reasoning: string[] = [];
    const toolCalls: any[] = [];
    for (const block of message.content) {
        if (block.type === 'text') texts.push(block.text);
        else if (block.type === 'thinking') reasoning.push(block.thinking);
        else toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.arguments) },
        });
    }
    return {
        content: texts.join('') || null,
        ...(reasoning.length > 0 ? { reasoning_content: reasoning.join('') } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        replayState: toReplayState(message),
    };
}

/** Unified LLM client whose provider identity is frozen for each request. */
export class LLMClient {
    private model: string;
    private readonly provider: string;
    private readonly reasoningEffort: string | undefined;

    constructor(config: LLMClientConfig) {
        this.provider = config.provider;
        this.model = config.model;
        this.reasoningEffort = config.reasoningEffort;
    }

    async chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
        const prepared = LlmProviderService.getInstance().prepare(this.provider, this.model);
        const result = await prepared.models.completeSimple(
            prepared.model,
            toPiContext(options.messages, options.tools),
            this.streamOptions(options),
        );
        if (result.stopReason === 'error' || result.stopReason === 'aborted') {
            throw this.providerError(result);
        }
        return {
            ...visibleParts(result),
            usage: {
                prompt_tokens: result.usage.input,
                completion_tokens: result.usage.output,
                total_tokens: result.usage.totalTokens,
            },
        };
    }

    async *streamChatCompletion(options: ChatCompletionOptions): AsyncIterableIterator<StreamChunk> {
        const prepared = LlmProviderService.getInstance().prepare(this.provider, this.model);
        const events = prepared.models.streamSimple(
            prepared.model,
            toPiContext(options.messages, options.tools),
            this.streamOptions(options),
        );
        const toolArgumentDeltas = new Set<number>();
        for await (const event of events) {
            switch (event.type) {
                case 'text_delta':
                    yield { content: event.delta, done: false };
                    break;
                case 'thinking_delta':
                    yield { reasoning_content: event.delta, done: false };
                    break;
                case 'toolcall_start': {
                    const block = event.partial.content[event.contentIndex];
                    if (block?.type === 'toolCall') {
                        yield {
                            tool_calls: [{
                                index: event.contentIndex,
                                id: block.id,
                                type: 'function',
                                function: { name: block.name, arguments: '' },
                            }],
                            done: false,
                        };
                    }
                    break;
                }
                case 'toolcall_delta':
                    toolArgumentDeltas.add(event.contentIndex);
                    yield {
                        tool_calls: [{
                            index: event.contentIndex,
                            function: { arguments: event.delta },
                        }],
                        done: false,
                    };
                    break;
                case 'toolcall_end':
                    if (!toolArgumentDeltas.has(event.contentIndex)) {
                        yield {
                            tool_calls: [{
                                index: event.contentIndex,
                                id: event.toolCall.id,
                                type: 'function',
                                function: {
                                    name: event.toolCall.name,
                                    arguments: JSON.stringify(event.toolCall.arguments),
                                },
                            }],
                            done: false,
                        };
                    }
                    break;
                case 'done':
                    yield { replayState: toReplayState(event.message), done: true };
                    return;
                case 'error':
                    throw this.providerError(event.error);
                default:
                    break;
            }
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
        if (raw !== undefined && !allowed.includes(raw)) {
            throw new Error(`Unsupported reasoning effort "${raw}"`);
        }
        return {
            ...(raw === undefined ? {} : { reasoning: raw as ThinkingLevel }),
            ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
            ...(options.max_tokens === undefined ? {} : { maxTokens: options.max_tokens }),
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
