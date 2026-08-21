import { describe, expect, it, vi } from 'vitest';
import type { Api, AssistantMessage } from '@earendil-works/pi-ai';

const state = vi.hoisted(() => ({ api: 'openai-completions' as Api, captured: undefined as any }));
vi.mock('../src/llm/providerService', () => ({
    LlmProviderService: {
        getInstance: () => ({
            prepare: (provider: string, model: string) => ({
                model: { provider, id: model },
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

import { LLMClient } from '../src/agent/llmClient';

describe.each([
    ['OpenAI', 'openai-completions'],
    ['Anthropic', 'anthropic-messages'],
    ['Google', 'google-generative-ai'],
] as const)('%s protocol adapter', (_label, api) => {
    it('completes a provider-neutral streamed tool-call round without a real credential', async () => {
        state.api = api;
        const client = new LLMClient({ provider: `mock-${api}`, model: 'model', reasoningEffort: 'none' });
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
