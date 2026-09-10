/** Streaming UI projection over pi-ai's native assistant-message event protocol. */

import { isRetryableAssistantError } from '@earendil-works/pi-ai';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import { LLMClient, ProviderStreamError } from './llmClient';
import { assistantTextBlocks } from '../llm/messageText';
import type { ToolDefinition } from '../tools.d/interface';
import type { AgentMessage } from '../types';

export type StreamProgressCallback = (
    contentBlocks: string[],
    reasoning: string,
    toolCalls?: ToolCall[],
) => void | Promise<void>;

export interface StreamResponseResult {
    message: AssistantMessage;
}

function visible(message: AssistantMessage): { contentBlocks: string[]; reasoning: string; toolCalls: ToolCall[] } {
    const reasoning: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of message.content) {
        if (block.type === 'thinking') reasoning.push(block.thinking);
        else if (block.type === 'toolCall') toolCalls.push(block);
    }
    return { contentBlocks: assistantTextBlocks(message), reasoning: reasoning.join(''), toolCalls };
}

/**
 * SDK-based retry classification over the AssistantMessage carried by ProviderStreamError.
 * Errors without one (registry/auth/local validation failures) are deterministic and never retried.
 */
function isRetryableError(error: unknown): boolean {
    return error instanceof ProviderStreamError && isRetryableAssistantError(error.assistantMessage);
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class LLMStreamHandler {
    private readonly maxRetries = 3;
    private readonly baseDelayMs = 1000;

    constructor(private readonly llmClient: LLMClient) {}

    async streamResponse(
        systemPrompt: string | undefined,
        messages: AgentMessage[],
        tools: ToolDefinition[],
        signal: AbortSignal,
        onProgress?: StreamProgressCallback,
    ): Promise<StreamResponseResult> {
        let attempt = 0;
        while (attempt <= this.maxRetries) {
            try {
                return await this.doStreamResponse(systemPrompt, messages, tools, signal, onProgress);
            } catch (error) {
                if (signal.aborted) throw error;
                if (isRetryableError(error) && !(error as any)?.mutsumiPartialOutput && attempt < this.maxRetries) {
                    attempt++;
                    await delay(this.baseDelayMs * Math.pow(2, attempt - 1));
                    continue;
                }
                throw error;
            }
        }
        throw new Error('Max retries exceeded for LLM stream request');
    }

    private async doStreamResponse(
        systemPrompt: string | undefined,
        messages: AgentMessage[],
        tools: ToolDefinition[],
        signal: AbortSignal,
        onProgress?: StreamProgressCallback,
    ): Promise<StreamResponseResult> {
        let emittedPartial = false;
        try {
            for await (const event of this.llmClient.streamChatCompletion({ systemPrompt, messages, tools, signal })) {
                if (event.type === 'done') return { message: event.message };
                // LLMClient converts SDK 'error' events into a thrown providerError (carrying
                // the AssistantMessage for retry classification) before yielding, so this branch
                // is unreachable in practice; it doubles as the narrowing guard that keeps
                // `partial` typed on the remaining union members.
                if (event.type === 'error') throw new Error(event.error.errorMessage ?? 'Provider stream failed');
                const partial = event.partial;
                const projected = visible(partial);
                // An empty text block (`text_start` before any delta) is not visible output, so
                // only non-empty text counts as "already emitted"; otherwise a retryable failure
                // that arrives mid-start would be treated as a partial answer and never retried.
                emittedPartial ||= projected.contentBlocks.some(text => text.length > 0) || projected.reasoning.length > 0 || projected.toolCalls.length > 0;
                if (onProgress) await onProgress(projected.contentBlocks, projected.reasoning, projected.toolCalls);
            }
        } catch (error) {
            if (emittedPartial) {
                const marked = error instanceof Error && Object.isExtensible(error)
                    ? error
                    : new Error(error instanceof Error ? error.message : String(error), { cause: error });
                (marked as any).mutsumiPartialOutput = true;
                throw marked;
            }
            throw error;
        }
        throw new Error('Provider stream ended without a terminal event');
    }
}
