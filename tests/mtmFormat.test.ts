import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';

vi.mock('vscode', () => ({
    EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
        dispose() {}
    },
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    },
    Uri: {
        parse: (value: string) => ({ scheme: value.slice(0, value.indexOf(':')) }),
    },
    l10n: { t: (value: string) => value },
}));

import { toPiContext } from '../src/llm/context';
import { decodeAgentContext, encodeAgentContext, INVALID_MTM_FILE, UNSUPPORTED_MTM_FORMAT } from '../src/mtmFormat';
import { MTM_FORMAT_VERSION, type AgentContext, type AgentMessage } from '../src/types';
import { genericCellsToMessages, messagesToGenericCells } from '../src/notebook/serializer';
import { parseUserMessageWithImages } from '../src/contextManagement/utils';

const assistant: AssistantMessage = {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-test',
    responseId: 'response-1',
    stopReason: 'toolUse',
    timestamp: 2,
    usage: {
        input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [
        { type: 'thinking', thinking: 'reason', thinkingSignature: 'signed-reason' },
        { type: 'text', text: 'hello', textSignature: 'signed-text' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' }, thoughtSignature: 'signed-tool' },
    ],
};

function context(messages: AgentMessage[]): AgentContext {
    return {
        formatVersion: MTM_FORMAT_VERSION,
        metadata: {
            uuid: 'agent-1', name: 'Agent', created_at: '2026-01-01T00:00:00.000Z',
            parent_agent_id: null, allowed_uris: ['/'], provider: 'anthropic', model: 'claude-test',
        },
        context: messages,
    };
}

describe(`.mtm format version ${MTM_FORMAT_VERSION}`, () => {
    it('round-trips native signed assistant and tool-result messages without replay duplication', () => {
        const source = context([
            { role: 'user', content: 'read it', timestamp: 1, mutsumi: { ghostBlock: { files: [], tools: [] } } },
            assistant,
            {
                role: 'toolResult', toolCallId: 'call-1', toolName: 'read',
                content: [{ type: 'text', text: 'contents' }], isError: false, timestamp: 3,
            },
            { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data: 'AQID' }], timestamp: 4 },
        ]);
        const decoded = decodeAgentContext(encodeAgentContext(source));
        expect(decoded).toEqual(source);
        expect(JSON.stringify(decoded)).not.toContain('piAiReplay');
        expect(JSON.stringify(decoded)).not.toContain('tool_calls');

        const notebookRoundTrip = genericCellsToMessages(messagesToGenericCells(source.context));
        expect(notebookRoundTrip).toEqual(source.context);
    });

    it('rejects unversioned and old-shaped messages', () => {
        expect(() => decodeAgentContext(new TextEncoder().encode(JSON.stringify({ metadata: {}, context: [] }))))
            .toThrow(expect.objectContaining({ code: UNSUPPORTED_MTM_FORMAT }));
        const unsupportedVersion = MTM_FORMAT_VERSION + 1;
        const wrongVersion = { ...context([]), formatVersion: unsupportedVersion };
        expect(() => decodeAgentContext(new TextEncoder().encode(JSON.stringify(wrongVersion))))
            .toThrow(expect.objectContaining({ code: UNSUPPORTED_MTM_FORMAT, actualVersion: unsupportedVersion }));
        const old = context([]) as any;
        old.context = [{ role: 'tool', tool_call_id: 'call-1', content: 'old' }];
        expect(() => decodeAgentContext(new TextEncoder().encode(JSON.stringify(old))))
            .toThrow(expect.objectContaining({ code: INVALID_MTM_FILE }));

        const malformed = context([{ role: 'user', content: 'go', timestamp: 1 }, { ...assistant, usage: undefined } as any]);
        expect(() => decodeAgentContext(new TextEncoder().encode(JSON.stringify(malformed))))
            .toThrow(expect.objectContaining({ code: INVALID_MTM_FILE }));
        const incompleteToolTurn = context([{ role: 'user', content: 'go', timestamp: 1 }, assistant]);
        expect(() => decodeAgentContext(new TextEncoder().encode(JSON.stringify(incompleteToolTurn))))
            .toThrow('ends before all tool calls have results');

        const removedProvider = context([]) as any;
        removedProvider.metadata.provider = 'kimi-for-coding';
        expect(() => decodeAgentContext(new TextEncoder().encode(JSON.stringify(removedProvider))))
            .toThrow('removed provider ID');
    });

    it('passes native messages directly to pi-ai while stripping Mutsumi-only user state', async () => {
        const user: AgentMessage = {
            role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'AQID' }], timestamp: 1,
            mutsumi: { ghostBlock: { files: [], tools: [] } },
        };
        const piContext = toPiContext('rules', [user, assistant]);
        expect(piContext.systemPrompt).toBe('rules');
        expect(piContext.messages[0]).toEqual({ role: 'user', content: user.content, timestamp: 1 });
        expect(piContext.messages[1]).toBe(assistant);

        await expect(parseUserMessageWithImages('![image](data:image/png;base64,AQID)')).resolves.toEqual([
            { type: 'image', mimeType: 'image/png', data: 'AQID' },
        ]);
    });
});
