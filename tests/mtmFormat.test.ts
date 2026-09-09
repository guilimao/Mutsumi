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
import { MTM_FORMAT_VERSION, type AgentContext, type AgentMessage, type PersistedAgentMessage } from '../src/types';
import { extractNotebookNotes, buildInteractionRenderBlocks, genericCellsToMessages, messagesToGenericCells } from '../src/notebook/serializer';
import { parseUserMessageWithImages } from '../src/contextManagement/utils';
import { hydrateProviderMessage, mergeConsecutiveUserMessages } from '../src/contextManagement/history';

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

function context(messages: PersistedAgentMessage[]): AgentContext {
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

        const missingCore = context([{ role: 'user', content: 'go', timestamp: 1 }, { ...assistant, model: undefined } as any]);
        expect(() => decodeAgentContext(new TextEncoder().encode(JSON.stringify(missingCore))))
            .toThrow(expect.objectContaining({ code: INVALID_MTM_FILE }));
        const incompleteToolTurn = context([{ role: 'user', content: 'go', timestamp: 1 }, assistant]);
        expect(() => decodeAgentContext(new TextEncoder().encode(JSON.stringify(incompleteToolTurn))))
            .toThrow('ends before all tool calls have results');

        const removedProvider = context([]) as any;
        removedProvider.metadata.provider = 'kimi-for-coding';
        expect(() => decodeAgentContext(new TextEncoder().encode(JSON.stringify(removedProvider))))
            .toThrow('removed provider ID');
    });

    it('round-trips Markup notes at every user-relative anchor without adding messages', () => {
        const source = context([
            { role: 'user', content: 'one', timestamp: 1 },
            { role: 'user', content: [{ type: 'text', text: 'two' }, { type: 'image', mimeType: 'image/png', data: 'AQID' }], timestamp: 2 },
        ]);
        source.notes = [
            { beforeUserIndex: 0, markdown: '# before' },
            { beforeUserIndex: 1, markdown: '' },
            { beforeUserIndex: 1, markdown: 'second in gap' },
            { beforeUserIndex: 2, markdown: 'after' },
        ];

        const decoded = decodeAgentContext(encodeAgentContext(source));
        expect(decoded).toEqual(source);
        const cells = messagesToGenericCells(decoded.context, decoded.notes);
        expect(cells.map(cell => [cell.kind, cell.value])).toEqual([
            [1, '# before'], [2, 'one'], [1, ''], [1, 'second in gap'],
            [2, 'two![image](data:image/png;base64,AQID)'], [1, 'after'],
        ]);
        expect(genericCellsToMessages(cells)).toEqual(source.context);
        expect(extractNotebookNotes(cells)).toEqual(source.notes);
    });

    it('allows consecutive pending users but still rejects a user inside an open tool turn', () => {
        const pending = context([
            { role: 'user', content: 'first', timestamp: 1 },
            { role: 'user', content: 'second', timestamp: 2 },
        ]);
        expect(decodeAgentContext(encodeAgentContext(pending))).toEqual(pending);
        expect(messagesToGenericCells(pending.context)).toHaveLength(2);

        const dangling = context([
            { role: 'user', content: 'first', timestamp: 1 },
            assistant,
            { role: 'user', content: 'not allowed yet', timestamp: 3 },
        ]);
        expect(() => encodeAgentContext(dangling)).toThrow('unexpected user message');
    });

    it('keeps a notebook user pending when its interaction metadata is malformed', () => {
        const cells = [{
            kind: 2 as const,
            value: 'retry me',
            metadata: {
                role: 'user' as const,
                timestamp: 7,
                mutsumi_interaction: [{ role: 'assistant', content: [], api: 'x' }] as any,
            },
        }];
        expect(genericCellsToMessages(cells)).toEqual([
            { role: 'user', content: 'retry me', timestamp: 7 },
        ]);
    });

    it('preserves arbitrary non-core provider fields and hydrates only a temporary provider copy', () => {
        const rawAssistant = {
            role: 'assistant' as const,
            api: 'anthropic-messages', provider: 'anthropic', model: 'claude-test',
            content: [{ type: 'text' as const, text: 'hello', textSignature: { provider: 'changed' } }],
            usage: { providerSpecific: true }, timestamp: 'yesterday', stopReason: { native: true },
            responseId: { nested: true }, diagnostics: 'opaque',
            nativeFutureField: { any: ['JSON', 1] },
        };
        const source = context([{ role: 'user', content: 'go' }, rawAssistant]);
        const decoded = decodeAgentContext(encodeAgentContext(source));
        expect(decoded).toEqual(source);

        const hydrated = hydrateProviderMessage(decoded.context[1]);
        expect(hydrated).toMatchObject({ timestamp: 0, stopReason: 'stop' });
        expect((hydrated as any).usage).toEqual({
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        });
        expect(decoded.context[1]).toEqual(rawAssistant);
    });

    it('merges only adjacent provider-facing users and preserves multimodal order', () => {
        const mergedText = mergeConsecutiveUserMessages([
            { role: 'user', content: 'one', timestamp: 1 },
            { role: 'user', content: 'two', timestamp: 2 },
        ]);
        expect(mergedText).toEqual([{ role: 'user', content: 'one\n\ntwo', timestamp: 2 }]);

        const mergedMulti = mergeConsecutiveUserMessages([
            { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'A' }], timestamp: 1 },
            { role: 'user', content: 'caption', timestamp: 2 },
            assistant,
            { role: 'user', content: 'next round', timestamp: 3 },
        ]);
        expect(mergedMulti[0]).toEqual({
            role: 'user', timestamp: 2, content: [
                { type: 'image', mimeType: 'image/png', data: 'A' },
                { type: 'text', text: '\n\n' },
                { type: 'text', text: 'caption' },
            ],
        });
        expect(mergedMulti).toHaveLength(3);
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

describe('serializer hydration usage blocks (parity with the live UIRenderer path)', () => {
    const usage = { input: 100, output: 20, totalTokens: 120, cost: { total: 0.0005 } };
    const assistantWith = (content: unknown[]): PersistedAgentMessage => ({
        role: 'assistant',
        api: 'openai-completions',
        provider: 'anthropic',
        model: 'claude-test',
        content: content as PersistedAgentMessage['content'],
        timestamp: 2,
        usage,
    } as unknown as PersistedAgentMessage);

    it('appends the usage block after a round with several tool calls', () => {
        const blocks = buildInteractionRenderBlocks([assistantWith([
            { type: 'text', text: 'calling tools' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'toolCall', id: 'call-2', name: 'grep', arguments: { pattern: 'x' } },
        ])], false);
        expect(blocks.map(block => block.type)).toEqual(['content', 'toolCall', 'toolCall', 'usage']);
        expect(blocks.at(-1)).toMatchObject({ type: 'usage', usage: { input: 100, output: 20 } });
    });

    it('appends the usage block after content-only rounds', () => {
        const blocks = buildInteractionRenderBlocks([assistantWith([
            { type: 'text', text: 'first part' },
            { type: 'text', text: 'second part' },
        ])], false);
        expect(blocks.map(block => block.type)).toEqual(['content', 'content', 'usage']);
    });

    it('covers reasoning-only rounds', () => {
        const blocks = buildInteractionRenderBlocks([assistantWith([
            { type: 'thinking', thinking: 'ponder' },
        ])], false);
        expect(blocks.map(block => block.type)).toEqual(['reasoning', 'usage']);
    });

    it('skips the usage block when the persisted message carries no usage', () => {
        const bare = assistantWith([{ type: 'text', text: 'no usage here' }]);
        delete (bare as { usage?: unknown }).usage;
        const blocks = buildInteractionRenderBlocks([bare], false);
        expect(blocks.map(block => block.type)).toEqual(['content']);
    });
});
