/**
 * Retry budget over the native stream. The retry budget is spent only while the turn has
 * produced something the user could see: an SDK `text_start` carries an empty text block and
 * only the deltas fill it, so treating that block as output would surface a transient 503
 * during stream startup as a failed request with no retry.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';

// The handler's LLMClient import chain reaches providerService, which imports vscode.
vi.mock('vscode', () => ({
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
}));

import { LLMStreamHandler } from '../src/agent/llmStream';
import { ProviderStreamError, type LLMClient } from '../src/agent/llmClient';

/** One attempt's events, optionally aborted by the provider failure that ended it. */
interface Attempt {
    events: AssistantMessageEvent[];
    error?: Error;
}

/** Duck-typed LLMClient: the handler only ever iterates `streamChatCompletion`. */
function stubClient(attempts: Attempt[]): { client: LLMClient; calls: () => number } {
    let calls = 0;
    const client = {
        async *streamChatCompletion(): AsyncIterableIterator<AssistantMessageEvent> {
            const attempt = attempts[Math.min(calls, attempts.length - 1)];
            calls++;
            for (const event of attempt.events) yield event;
            if (attempt.error) throw attempt.error;
        },
    } as unknown as LLMClient;
    return { client, calls: () => calls };
}

/** The provider's own 503 assistant message, as LLMClient hands it to the retry classifier. */
function transientFailure(): ProviderStreamError {
    const message: AssistantMessage = fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: '503 Service Unavailable',
    });
    return new ProviderStreamError(message);
}

function textStart(text: string): AssistantMessageEvent {
    return { type: 'text_start', contentIndex: 0, partial: fauxAssistantMessage([fauxText(text)]) };
}

function doneWith(text: string): AssistantMessageEvent {
    return { type: 'done', reason: 'stop', message: fauxAssistantMessage([fauxText(text)]) };
}

const signal = () => new AbortController().signal;

describe('LLMStreamHandler retry budget', () => {
    afterEach(() => vi.useRealTimers());

    it('retries a transient failure that arrived after an empty text block', async () => {
        const { client, calls } = stubClient([
            { events: [textStart('')], error: transientFailure() },
            { events: [doneWith('recovered')] },
        ]);
        const handler = new LLMStreamHandler(client);

        vi.useFakeTimers();
        const pending = handler.streamResponse(undefined, [], [], signal());
        await vi.advanceTimersByTimeAsync(60_000);

        const result = await pending;
        expect(result.message.content).toEqual([{ type: 'text', text: 'recovered' }]);
        expect(calls()).toBe(2);
    });

    const visibleOutput: Array<[string, () => AssistantMessageEvent]> = [
        ['text', () => ({ type: 'text_delta', contentIndex: 0, delta: 'A', partial: fauxAssistantMessage([fauxText('A')]) })],
        ['reasoning', () => ({
            type: 'thinking_delta', contentIndex: 0, delta: 'think',
            partial: fauxAssistantMessage([fauxThinking('think')]),
        })],
        ['a tool call', () => ({
            type: 'toolcall_start', contentIndex: 0,
            partial: fauxAssistantMessage([fauxToolCall('read', { path: 'a.ts' })]),
        })],
    ];

    it.each(visibleOutput)('does not retry once %s has streamed', async (_output, event) => {
        const { client, calls } = stubClient([
            { events: [event()], error: transientFailure() },
            { events: [doneWith('never reached')] },
        ]);
        const handler = new LLMStreamHandler(client);

        await expect(handler.streamResponse(undefined, [], [], signal()))
            .rejects.toMatchObject({ mutsumiPartialOutput: true });
        expect(calls()).toBe(1);
    });
});
