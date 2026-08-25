import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';

const state = vi.hoisted(() => ({
    steps: [] as Array<{ message?: AssistantMessage; error?: Error & { code?: string } }>,
    cancelDuringTools: false,
    sessionCancelled: false,
    toolError: undefined as (Error & { code?: string }) | undefined,
}));

vi.mock('vscode', () => ({
    window: { showErrorMessage: vi.fn(() => Promise.resolve(undefined)) },
    env: { clipboard: { writeText: vi.fn() } },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    l10n: { t: (value: string) => value },
}));

vi.mock('../src/agent/llmClient', () => ({
    LLMClient: class {},
}));

vi.mock('../src/agent/llmStream', () => ({
    LLMStreamHandler: class {
        async streamResponse() {
            const step = state.steps.shift();
            if (!step) throw new Error('Missing test stream step');
            if (step.error) throw step.error;
            return { message: step.message };
        }
    },
}));

vi.mock('../src/agent/toolExecutor', () => ({
    ToolExecutor: class {
        async executeTools(toolCalls: ToolCall[]) {
            if (state.toolError) throw state.toolError;
            if (state.cancelDuringTools) state.sessionCancelled = true;
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

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
    return {
        role: 'assistant',
        api: 'openai-completions',
        provider: 'test-provider',
        model: 'test-model',
        content,
        stopReason,
        timestamp: 2,
        usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    };
}

function createRunner(maxLoops = 2) {
    const session = {
        id: 'session',
        token: { get isCancellationRequested() { return state.sessionCancelled; } },
        getConfig: vi.fn(async () => ({ allowedUris: [], isSubAgent: false })),
        replaceOutput: vi.fn(async () => undefined),
    };
    const toolSet = {
        getDefinitions: () => [],
    };
    return new AgentRunner(
        { provider: 'test-provider', model: 'test-model', maxLoops },
        toolSet as any,
        session as any,
    );
}

describe('AgentRunner run status', () => {
    beforeEach(() => {
        state.steps = [];
        state.cancelDuringTools = false;
        state.sessionCancelled = false;
        state.toolError = undefined;
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => vi.restoreAllMocks());

    it('returns completed with the exact native assistant message', async () => {
        const message = assistant([{ type: 'text', text: 'done', textSignature: 'signed' }]);
        state.steps.push({ message });

        const result = await createRunner(1).run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        expect(result).toEqual({ status: 'completed', messages: [message] });
    });

    it('reports failure without fabricating an assistant and retains a completed tool round', async () => {
        const toolRound = assistant([
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
        ], 'toolUse');
        const failure = Object.assign(new Error('upstream unavailable'), { code: 'UPSTREAM_UNAVAILABLE' });
        state.steps.push({ message: toolRound }, { error: failure });

        const result = await createRunner().run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        expect(result.status).toBe('failed');
        expect(result.error).toEqual({ code: 'UPSTREAM_UNAVAILABLE', message: 'upstream unavailable' });
        expect(result.messages).toEqual([
            toolRound,
            expect.objectContaining({ role: 'toolResult', toolCallId: 'call-1', isError: false }),
        ]);
    });

    it('reports cancellation without persisting a synthetic assistant', async () => {
        const cancellation = new Error('cancelled');
        cancellation.name = 'AbortError';
        state.steps.push({ error: cancellation });

        const result = await createRunner(1).run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        expect(result).toEqual({ status: 'cancelled', messages: [] });
    });

    it('drops an assistant tool round cancelled before it becomes replayable', async () => {
        state.cancelDuringTools = true;
        state.steps.push({
            message: assistant([
                { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'a.ts' } },
            ], 'toolUse'),
        });

        const result = await createRunner().run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        expect(result).toEqual({ status: 'cancelled', messages: [] });
    });

    it('reports tool infrastructure failure without leaving a dangling tool call', async () => {
        state.toolError = new Error('renderer disconnected');
        state.steps.push({
            message: assistant([
                { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
            ], 'toolUse'),
        });

        const result = await createRunner().run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        expect(result).toEqual({
            status: 'failed',
            messages: [],
            error: { code: 'TOOL_EXECUTION_ERROR', message: 'renderer disconnected' },
        });
    });

    it('reports max-loop exhaustion while retaining the completed tool round', async () => {
        const toolRound = assistant([
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
        ], 'toolUse');
        state.steps.push({ message: toolRound });

        const result = await createRunner(1).run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        expect(result.status).toBe('failed');
        expect(result.error).toEqual({
            code: 'MAX_LOOPS_EXCEEDED',
            message: 'Agent reached the maximum of 1 tool interaction loops',
        });
        expect(result.messages).toHaveLength(2);
    });
});
