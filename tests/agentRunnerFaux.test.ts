/**
 * AgentRunner integration over the real SDK plumbing: a pi-ai fauxProvider is dispatched
 * through the real LLMClient/LLMStreamHandler chain (only the provider registry is bridged),
 * so native SDK message shapes flow through the runner's loop instead of hand-built fakes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FauxProviderHandle, ToolCall } from '@earendil-works/pi-ai';
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
} from '@earendil-works/pi-ai';

// The async mock factory runs when the mocked module is first imported (triggered by the
// AgentRunner import below), which resolves the handle before any test executes.
const fauxHandle = vi.hoisted(() => ({ current: undefined as FauxProviderHandle | undefined }));

vi.mock('vscode', () => ({
    window: { showErrorMessage: vi.fn(() => Promise.resolve(undefined)) },
    env: { clipboard: { writeText: vi.fn() } },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    l10n: { t: (value: string) => value },
}));

vi.mock('../src/llm/providerService', async () => {
    const { createModels, fauxProvider } = await import('@earendil-works/pi-ai');
    const faux = fauxProvider({
        provider: 'faux-runner',
        models: [{ id: 'faux-model', reasoning: true }],
    });
    const registry = createModels();
    registry.setProvider(faux.provider);
    fauxHandle.current = faux;
    return {
        LlmProviderService: {
            getInstance: () => ({
                prepare: (provider: string, model: string) => ({
                    models: registry,
                    model: faux.getModel(model),
                    provider,
                    isBuiltIn: false,
                }),
            }),
        },
    };
});

vi.mock('../src/agent/toolExecutor', () => ({
    ToolExecutor: class {
        async executeTools(toolCalls: ToolCall[]) {
            return {
                messages: toolCalls.map(call => ({
                    role: 'toolResult' as const,
                    toolCallId: call.id,
                    toolName: call.name,
                    content: [{ type: 'text' as const, text: 'ok' }],
                    isError: false,
                    timestamp: 3,
                })),
                shouldTerminate: false,
                isTaskComplete: false,
            };
        }
    },
}));

vi.mock('../src/agent/titleGenerator', () => ({
    TitleGenerator: class {},
}));

vi.mock('../src/adapters/liteAdapter', () => ({
    LiteAgentSession: class {},
}));

import { AgentRunner } from '../src/agent/agentRunner';

function faux(): FauxProviderHandle {
    if (!fauxHandle.current) throw new Error('faux provider not initialized');
    return fauxHandle.current;
}

function createRunner(maxLoops = 4) {
    const session = {
        id: 'session',
        token: { get isCancellationRequested() { return false; } },
        getConfig: vi.fn(async () => ({ allowedUris: [], isSubAgent: false })),
        replaceOutput: vi.fn(async () => undefined),
    };
    const toolSet = {
        getDefinitions: () => [],
        getPrettyPrint: () => undefined,
        getRenderingConfig: () => undefined,
        getShouldCache: () => false,
        execute: async () => ({ content: 'ok' }),
    };
    const runner = new AgentRunner(
        { provider: 'faux-runner', model: 'faux-model', maxLoops },
        toolSet as any,
        session as any,
    );
    return { runner, session };
}

describe('AgentRunner over the pi-ai faux provider', () => {
    beforeEach(() => {
        faux().setResponses([]);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    it('completes a plain round trip with the SDK-produced assistant message', async () => {
        faux().setResponses([fauxAssistantMessage([fauxText('all done')])]);

        const { runner, session } = createRunner();
        const result = await runner.run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        expect(result.status).toBe('completed');
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]).toMatchObject({
            role: 'assistant',
            provider: 'faux-runner',
            model: 'faux-model',
            content: [{ type: 'text', text: 'all done' }],
            // The round measurements ride on the message itself: the catalog context window
            // (faux defaults to 128000) and the wall-clock timing from the stream handler.
            mutsumi: {
                contextWindow: 128000,
                ttftMs: expect.any(Number),
                generationMs: expect.any(Number),
            },
        });

        // Terminal flush: the last output frame commits the round's blocks (content + usage)
        // instead of leaving them stranded in the streaming active area.
        const calls = session.replaceOutput.mock.calls as unknown as [string, unknown][];
        const finalFrame = JSON.parse(calls.at(-1)?.[0] ?? '{}') as {
            active: unknown;
            committed: { type: string; markdown?: string }[];
        };
        expect(finalFrame.active).toBeNull();
        expect(finalFrame.committed.at(-2)).toMatchObject({ type: 'content', markdown: 'all done' });
        // The faux provider reports estimated usage, so the round also commits a usage block.
        expect(finalFrame.committed.at(-1)).toMatchObject({ type: 'usage' });
    });

    it('runs a full tool loop: SDK tool call -> tool result -> SDK final answer', async () => {
        faux().setResponses([
            fauxAssistantMessage([fauxToolCall('read', { path: 'a.ts' })], { stopReason: 'toolUse' }),
            fauxAssistantMessage([fauxText('summarized')]),
        ]);

        const { runner } = createRunner();
        const result = await runner.run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        expect(result.status).toBe('completed');
        expect(result.messages).toHaveLength(3);
        expect(result.messages[0]).toMatchObject({
            role: 'assistant', stopReason: 'toolUse',
            content: [{ type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } }],
        });
        const first = result.messages[0];
        const toolCall = first.role === 'assistant'
            ? first.content.find((block): block is ToolCall => block.type === 'toolCall')
            : undefined;
        expect(result.messages[1]).toMatchObject({ role: 'toolResult', toolCallId: toolCall?.id });
        expect(result.messages[2]).toMatchObject({
            role: 'assistant', content: [{ type: 'text', text: 'summarized' }],
        });
    });

    it('renders prose written after a tool call instead of dropping it', async () => {
        // The SDK emits one text block per contiguous run of visible text, so this turn streams
        // text A, a tool call, then text B. Locking the whole round on A used to lose B from the
        // live output while the persisted message still carried it.
        faux().setResponses([
            fauxAssistantMessage(
                [fauxText('before'), fauxToolCall('read', { path: 'a.ts' }), fauxText('after')],
                { stopReason: 'toolUse' },
            ),
            fauxAssistantMessage([fauxText('done')]),
        ]);

        const { runner, session } = createRunner();
        const result = await runner.run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        expect(result.status).toBe('completed');
        const first = result.messages[0];
        expect(first.role === 'assistant' ? first.content.map(block => block.type) : [])
            .toEqual(['text', 'toolCall', 'text']);

        // Both runs of prose reach the live frames, in SDK content-block order, and survive the
        // round commit that precedes tool execution.
        const frames = (session.replaceOutput.mock.calls as unknown as [string, unknown][])
            .map(call => JSON.parse(call[0]) as { active: { content: string } | null; committed: { type: string; markdown?: string }[] });
        expect(frames.some(frame => frame.active?.content === 'after')).toBe(true);
        expect(frames.at(-1)?.committed
            .filter(block => block.type === 'content')
            .map(block => block.markdown)).toEqual(['before', 'after', 'done']);
    });

    it('reports failure when the provider responds with an error assistant message', async () => {
        faux().setResponses([fauxAssistantMessage([fauxText('never seen')], {
            stopReason: 'error',
            errorMessage: 'faux upstream exploded',
        })]);

        const { runner } = createRunner();
        const result = await runner.run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        expect(result.status).toBe('failed');
        expect(result.error?.message).toContain('faux upstream exploded');
        expect(result.messages).toEqual([]);
    });
});
