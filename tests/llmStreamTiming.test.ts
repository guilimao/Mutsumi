/**
 * Wall-clock timing reported by the stream handler. The usage indicator derives tok/s and
 * time-to-first-token from these, so they must bracket the moments the user can observe:
 * request dispatch -> first visible token -> terminal event. Empty SDK frames (a `text_start`
 * before any delta) must not be mistaken for a first token.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';

// The handler's LLMClient import chain reaches providerService, which imports vscode.
vi.mock('vscode', () => ({
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
}));

import { LLMStreamHandler } from '../src/agent/llmStream';
import type { LLMClient } from '../src/agent/llmClient';

function emptyStart(): AssistantMessageEvent {
    return { type: 'text_start', contentIndex: 0, partial: fauxAssistantMessage([fauxText('')]) };
}

function textDelta(text: string): AssistantMessageEvent {
    return { type: 'text_delta', contentIndex: 0, delta: text, partial: fauxAssistantMessage([fauxText(text)]) };
}

function doneWith(text: string): AssistantMessageEvent {
    return { type: 'done', reason: 'stop', message: fauxAssistantMessage([fauxText(text)]) };
}

describe('LLMStreamHandler timing', () => {
    afterEach(() => vi.useRealTimers());

    it('measures TTFT to the first visible token and generation time after it', async () => {
        vi.useFakeTimers();
        const client = {
            async *streamChatCompletion(): AsyncIterableIterator<AssistantMessageEvent> {
                await new Promise(resolve => setTimeout(resolve, 120));
                yield emptyStart(); // not visible output: must not end the TTFT window
                await new Promise(resolve => setTimeout(resolve, 30));
                yield textDelta('A'); // first visible token at +150ms
                await new Promise(resolve => setTimeout(resolve, 500));
                yield doneWith('A'); // terminal event at +650ms
            },
        } as unknown as LLMClient;

        const pending = new LLMStreamHandler(client).streamResponse(
            undefined, [], [], new AbortController().signal,
        );
        await vi.advanceTimersByTimeAsync(2000);
        const result = await pending;

        expect(result.timing.ttftMs).toBe(150);
        expect(result.timing.generationMs).toBe(500);
    });

    it('omits timing when no visible token was ever streamed', async () => {
        const client = {
            async *streamChatCompletion(): AsyncIterableIterator<AssistantMessageEvent> {
                yield doneWith('');
            },
        } as unknown as LLMClient;

        const result = await new LLMStreamHandler(client).streamResponse(
            undefined, [], [], new AbortController().signal,
        );

        expect(result.timing).toEqual({});
    });
});
