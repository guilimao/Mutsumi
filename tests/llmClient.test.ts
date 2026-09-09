import { describe, expect, it, vi } from 'vitest';
import type { Api, AssistantMessage } from '@earendil-works/pi-ai';

const state = vi.hoisted(() => ({
    api: 'openai-completions' as Api,
    isBuiltIn: false,
    modelOverrides: {} as Record<string, unknown>,
    captured: undefined as any,
    streamError: undefined as AssistantMessage | undefined,
}));
vi.mock('../src/llm/providerService', () => ({
    LlmProviderService: {
        getInstance: () => ({
            prepare: (provider: string, model: string) => ({
                model: { provider, id: model, ...state.modelOverrides },
                isBuiltIn: state.isBuiltIn,
                models: {
                    streamSimple: (_model: unknown, context: unknown, options: unknown) => {
                        state.captured = { context, options };
                        const message: AssistantMessage = {
                            role: 'assistant', api: state.api, provider, model,
                            stopReason: 'toolUse', timestamp: 1,
                            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                            content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'file.ts' } }],
                        };
                        return (async function* () {
                            if (state.streamError) {
                                yield { type: 'error', reason: 'error', error: state.streamError } as any;
                                return;
                            }
                            // Some protocols only expose complete arguments at toolcall_end.
                            yield { type: 'toolcall_end', contentIndex: 0, toolCall: message.content[0], partial: message } as any;
                            yield { type: 'done', reason: 'toolUse', message } as any;
                        })();
                    },
                },
            }),
        }),
    },
}));

import { LLMClient, ProviderStreamError } from '../src/agent/llmClient';

describe.each([
    ['OpenAI', 'openai-completions'],
    ['Anthropic', 'anthropic-messages'],
    ['Google', 'google-generative-ai'],
] as const)('%s protocol adapter', (_label, api) => {
    it('completes a provider-neutral streamed tool-call round without a real credential', async () => {
        state.api = api;
        const client = new LLMClient({ provider: `mock-${api}`, model: 'model', reasoningEffort: 'off' });
        const chunks = [];
        for await (const chunk of client.streamChatCompletion({
            systemPrompt: 'rules',
            messages: [{ role: 'user', content: 'read it', timestamp: 1 }],
            tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
        })) chunks.push(chunk);

        expect(chunks[0]).toMatchObject({
            type: 'toolcall_end', toolCall: { id: 'call-1', name: 'read', arguments: { path: 'file.ts' } },
        });
        expect(chunks.at(-1)).toMatchObject({
            type: 'done', message: { api, provider: `mock-${api}`, stopReason: 'toolUse' },
        });
        expect(state.captured.context).toMatchObject({ systemPrompt: 'rules', tools: [{ name: 'read' }] });
        expect(state.captured.options).toMatchObject({ maxRetries: 0 });
        expect(state.captured.options).toMatchObject({ reasoning: 'off' });
    });
});

describe('reasoning capability gate', () => {
    it('points custom routes at mutsumi.customProviders', async () => {
        state.isBuiltIn = false;
        const client = new LLMClient({ provider: 'local', model: 'm', reasoningEffort: 'high' });
        await expect(client.chatCompletion({ messages: [] })).rejects.toThrow(/mutsumi\.customProviders/);
    });

    it('does not point built-in models at a setting that cannot redeclare them', async () => {
        state.isBuiltIn = true;
        const client = new LLMClient({ provider: 'openai', model: 'gpt-4o', reasoningEffort: 'high' });
        const error = await client.chatCompletion({ messages: [] }).then(() => undefined, (failure: Error) => failure);
        expect(error?.message).toMatch(/built-in model capabilities come from the pi-ai catalog/);
        expect(error?.message).not.toMatch(/mutsumi\.customProviders/);
        state.isBuiltIn = false;
    });

    it('rejects off when the model cannot disable reasoning instead of letting the SDK raise it', async () => {
        state.isBuiltIn = false;
        // thinkingLevelMap.off = null removes off from getSupportedThinkingLevels; the SDK would
        // clamp the request upward to minimal, silently turning "disable" into "enable".
        state.modelOverrides = { reasoning: true, thinkingLevelMap: { off: null } };
        try {
            const client = new LLMClient({ provider: 'local', model: 'no-off', reasoningEffort: 'off' });
            await expect(client.chatCompletion({ messages: [] })).rejects.toThrow(/cannot disable reasoning/);
        } finally {
            state.modelOverrides = {};
        }
    });

    it('still sends off when the model supports disabling reasoning', async () => {
        state.isBuiltIn = false;
        state.modelOverrides = { reasoning: true };
        try {
            const client = new LLMClient({ provider: 'local', model: 'm', reasoningEffort: 'off' });
            for await (const _chunk of client.streamChatCompletion({ messages: [] })) { /* consume */ }
            expect(state.captured.options).toMatchObject({ reasoning: 'off' });
        } finally {
            state.modelOverrides = {};
        }
    });
});

describe('provider stream errors', () => {
    it('throws a typed ProviderStreamError carrying the SDK assistant message', async () => {
        const message: AssistantMessage = {
            role: 'assistant', api: 'openai-completions', provider: 'local', model: 'm',
            stopReason: 'error', errorMessage: 'upstream 503', timestamp: 1, content: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        state.streamError = message;
        try {
            const client = new LLMClient({ provider: 'local', model: 'm' });
            const consume = async (): Promise<unknown> => {
                for await (const _chunk of client.streamChatCompletion({ messages: [] })) { /* consume */ }
                return undefined;
            };
            const error = await consume().then(() => undefined, (failure: unknown) => failure);
            expect(error).toBeInstanceOf(ProviderStreamError);
            expect((error as ProviderStreamError).assistantMessage).toBe(message);
        } finally {
            state.streamError = undefined;
        }
    });
});
