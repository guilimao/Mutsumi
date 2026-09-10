import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';

const state = vi.hoisted(() => ({
    steps: [] as Array<{
        message?: AssistantMessage;
        error?: Error & { code?: string };
        /** Stream progress emitted before the step settles (or fails). */
        progress?: { content?: string[]; reasoning?: string; toolCalls?: ToolCall[] };
    }>,
    cancelDuringTools: false,
    sessionCancelled: false,
    toolError: undefined as (Error & { code?: string }) | undefined,
    /** Every RenderData frame the runner published, in order. */
    renderFrames: [] as string[],
    /** Frames published before the tool executor was entered, or -1 when it never ran. */
    toolStartedAtFrameCount: -1,
    /** Count of replaceOutput calls, and the 1-based call that should be rejected (-1 = none). */
    replaceOutputCount: 0,
    failReplaceOutputCall: -1,
}));

vi.mock('vscode', () => ({
    window: { showErrorMessage: vi.fn(() => Promise.resolve(undefined)) },
    env: { clipboard: { writeText: vi.fn() } },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    l10n: { t: (value: string) => value },
}));

vi.mock('../src/agent/llmClient', () => ({
    LLMClient: class {
        getContextWindow() { return undefined; }
    },
}));

vi.mock('../src/agent/llmStream', () => ({
    LLMStreamHandler: class {
        async streamResponse(
            _systemPrompt: unknown,
            _messages: unknown,
            _tools: unknown,
            _signal: unknown,
            onProgress?: (contentBlocks: string[], reasoning: string, toolCalls?: ToolCall[]) => unknown,
        ) {
            const step = state.steps.shift();
            if (!step) throw new Error('Missing test stream step');
            if (step.progress && onProgress) {
                await onProgress(step.progress.content ?? [], step.progress.reasoning ?? '', step.progress.toolCalls);
            }
            if (step.error) throw step.error;
            return { message: step.message, timing: {} };
        }
    },
}));

vi.mock('../src/agent/toolExecutor', () => ({
    ToolExecutor: class {
        async executeTools(toolCalls: ToolCall[]) {
            state.toolStartedAtFrameCount = state.renderFrames.length;
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
        replaceOutput: vi.fn(async (content: string) => {
            state.replaceOutputCount++;
            if (state.failReplaceOutputCall === state.replaceOutputCount) throw new Error('output rejected');
            state.renderFrames.push(content);
        }),
    };
    const toolSet = {
        getDefinitions: () => [],
        getPrettyPrint: (name: string) => `Run ${name}`,
        getRenderingConfig: () => undefined,
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
        state.renderFrames = [];
        state.toolStartedAtFrameCount = -1;
        state.replaceOutputCount = 0;
        state.failReplaceOutputCall = -1;
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

    it('publishes the round usage before the tools it belongs to start', async () => {
        const toolRound = assistant([
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
        ], 'toolUse');
        state.steps.push({ message: toolRound }, { message: assistant([{ type: 'text', text: 'final' }]) });

        await createRunner().run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        // The usage block must be on screen before tool execution, which may take seconds.
        expect(state.toolStartedAtFrameCount).toBeGreaterThan(0);
        const beforeTools = state.renderFrames.slice(0, state.toolStartedAtFrameCount);
        expect(beforeTools.some(frame => frame.includes('"type":"usage"'))).toBe(true);
    });

    it('clears an unfinished running tool when the run is cancelled mid-stream', async () => {
        const cancellation = Object.assign(new Error('cancelled'), { name: 'AbortError' });
        state.steps.push({
            progress: { toolCalls: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'a.ts' } }] },
            error: cancellation,
        });

        const result = await createRunner().run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        expect(result).toEqual({ status: 'cancelled', messages: [] });
        // A streaming frame advertised the tool as running; the terminal frame must retract it.
        const streamed = JSON.parse(state.renderFrames[0]);
        expect(streamed.active.pendingTools).toHaveLength(1);
        const terminal = JSON.parse(state.renderFrames[state.renderFrames.length - 1]);
        expect(terminal.active).toBeNull();
    });

    it('keeps the partial answer above the error when a non-cancellation stream fails', async () => {
        const failure = Object.assign(new Error('upstream unavailable'), { code: 'UPSTREAM_UNAVAILABLE' });
        state.steps.push({
            progress: {
                content: ['partial answer'],
                toolCalls: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'a.ts' } }],
            },
            error: failure,
        });

        const result = await createRunner().run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        expect(result.status).toBe('failed');
        const terminal = JSON.parse(state.renderFrames[state.renderFrames.length - 1]);
        // The partial streamed answer is kept, the never-run tool is not, and the error sits below.
        expect(terminal.active).toBeNull();
        expect(terminal.committed.map((block: { type: string }) => block.type)).toEqual(['content', 'content']);
        expect(terminal.committed[0].markdown).toBe('partial answer');
        expect(terminal.committed[1].markdown).toContain('Error');
    });

    it('keeps a completed run when the terminal frame cannot be published', async () => {
        state.failReplaceOutputCall = 1; // a content-only round publishes only the terminal frame
        const message = assistant([{ type: 'text', text: 'done' }]);
        state.steps.push({ message });

        const result = await createRunner(1).run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        // A display failure must not veto the data contract: both callers skip setHistory + save
        // on rejection, which would drop the round the model just completed.
        expect(result).toEqual({ status: 'completed', messages: [message] });
        expect(console.error).toHaveBeenCalledWith('Failed to publish render frame:', expect.any(Error));
    });

    it('keeps the completed tool round when the flush before tool execution cannot be published', async () => {
        const toolRound = assistant([
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
        ], 'toolUse');
        const final = assistant([{ type: 'text', text: 'final' }]);
        state.steps.push({ message: toolRound }, { message: final });
        state.failReplaceOutputCall = 1; // the round flush that precedes tool execution

        const result = await createRunner().run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        // Rejecting here used to lose the whole run to the callers' reject path; the frame is
        // display-only, so the run must continue and return the round it already produced.
        expect(result.status).toBe('completed');
        expect(result.messages[0]).toBe(toolRound);
        expect(result.messages[1]).toMatchObject({ role: 'toolResult', toolCallId: 'call-1' });
        expect(result.messages[2]).toBe(final);
    });

    it('keeps the cancelled result when the terminal frame cannot be published', async () => {
        const cancellation = Object.assign(new Error('cancelled'), { name: 'AbortError' });
        state.failReplaceOutputCall = 2; // call 1 = progress frame, call 2 = terminal frame
        state.steps.push({
            progress: { toolCalls: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'a.ts' } }] },
            error: cancellation,
        });

        const result = await createRunner().run(new AbortController(), {
            messages: [{ role: 'user', content: 'go', timestamp: 1 }],
        });

        expect(result).toEqual({ status: 'cancelled', messages: [] });
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
