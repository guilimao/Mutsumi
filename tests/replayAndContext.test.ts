import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { toPiContext } from '../src/llm/context';
import { toPiAssistant, toReplayState } from '../src/llm/replay';
import type { AgentMessage } from '../src/types';

const native: AssistantMessage = {
    role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'claude-test',
    stopReason: 'toolUse', timestamp: 1,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [
        { type: 'thinking', thinking: 'reason', thinkingSignature: 'signed-reason' },
        { type: 'text', text: 'hello', textSignature: 'signed-text' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' }, thoughtSignature: 'signed-tool' },
    ],
};

describe('pi-ai replay state', () => {
    it('round-trips signed native blocks when visible content still matches', () => {
        const message: AgentMessage = {
            role: 'assistant', content: 'hello', reasoning_content: 'reason',
            tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }],
            metadata: { piAiReplay: toReplayState(native) },
        };
        expect(toPiAssistant(message)).toMatchObject({
            api: 'anthropic-messages', provider: 'anthropic', model: 'claude-test',
            content: [
                { type: 'thinking', thinkingSignature: 'signed-reason' },
                { type: 'text', textSignature: 'signed-text' },
                { type: 'toolCall', thoughtSignature: 'signed-tool' },
            ],
        });
    });

    it('drops signatures and treats edited or corrupt metadata as a foreign assistant', () => {
        const message: AgentMessage = {
            role: 'assistant', content: 'edited', reasoning_content: 'reason',
            metadata: { piAiReplay: toReplayState(native) },
        };
        const converted = toPiAssistant(message);
        expect(converted.api).toBe('mutsumi-foreign');
        expect(converted.content).toEqual([
            { type: 'thinking', thinking: 'reason' },
            { type: 'text', text: 'edited' },
        ]);
    });
});

describe('provider-neutral context conversion', () => {
    it('converts system, image, tools, and tool error semantics', () => {
        const context = toPiContext([
            { role: 'system', content: 'rules' },
            { role: 'user', content: [
                { type: 'text', text: 'look' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
            ] },
            { role: 'tool', name: 'read', tool_call_id: 'call-1', content: 'Error: missing' },
        ], [{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object' } } }]);

        expect(context.systemPrompt).toBe('rules');
        expect(context.messages[0]).toMatchObject({ role: 'user', content: [
            { type: 'text', text: 'look' },
            { type: 'image', mimeType: 'image/png', data: 'AQID' },
        ] });
        expect(context.messages[1]).toMatchObject({ role: 'toolResult', isError: true });
        expect(context.tools?.[0]).toMatchObject({ name: 'read', parameters: { type: 'object' } });
    });
});
