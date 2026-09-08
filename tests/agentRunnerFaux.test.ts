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
        });

        // Terminal flush: the last output frame commits the content block (the usage-attach
        // point) instead of leaving it stranded in the streaming active area.
        const calls = session.replaceOutput.mock.calls as unknown as [string, unknown][];
        const finalFrame = JSON.parse(calls.at(-1)?.[0] ?? '{}') as {
            active: unknown;
            committed: { type: string; markdown: string }[];
        };
        expect(finalFrame.active).toBeNull();
        expect(finalFrame.committed.at(-1)).toMatchObject({ type: 'content', markdown: 'all done' });
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
