import type { Api, AssistantMessage, ToolCall, Usage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '../types';
import type { PiAiReplayBlock, PiAiReplayState } from './types';

function emptyUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function parseArguments(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'string') return {};
    try {
        const value: unknown = JSON.parse(raw);
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

/** Project the successful native response into JSON-safe durable replay metadata. */
export function toReplayState(message: AssistantMessage): PiAiReplayState {
    return {
        kind: 'pi-ai',
        version: 1,
        api: message.api,
        provider: message.provider,
        model: message.model,
        ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
        ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
        stopReason: message.stopReason,
        blocks: message.content.map((block): PiAiReplayBlock => {
            switch (block.type) {
                case 'text': return {
                    type: 'text',
                    text: block.text,
                    ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
                };
                case 'thinking': return {
                    type: 'reasoning',
                    text: block.thinking,
                    ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
                    ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
                };
                case 'toolCall': return {
                    type: 'tool-call',
                    id: block.id,
                    name: block.name,
                    arguments: block.arguments,
                    ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
                };
            }
        }),
    };
}

function visibleText(message: AgentMessage): string {
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) return '';
    return message.content.filter(part => part.type === 'text').map(part => part.text).join('');
}

function stateMatchesVisible(message: AgentMessage, state: PiAiReplayState): boolean {
    const text = state.blocks.filter(block => block.type === 'text').map(block => block.text).join('');
    const reasoning = state.blocks.filter(block => block.type === 'reasoning').map(block => block.text).join('');
    const tools = state.blocks.filter((block): block is Extract<PiAiReplayBlock, { type: 'tool-call' }> => block.type === 'tool-call');
    if (text !== visibleText(message) || reasoning !== (message.reasoning_content ?? '')) return false;
    const visibleTools = message.tool_calls ?? [];
    if (tools.length !== visibleTools.length) return false;
    return tools.every((tool, index) => {
        const visible = visibleTools[index];
        return visible?.id === tool.id
            && visible?.function?.name === tool.name
            && JSON.stringify(parseArguments(visible?.function?.arguments)) === JSON.stringify(tool.arguments);
    });
}

function readReplayState(message: AgentMessage): PiAiReplayState | undefined {
    const value: unknown = message.metadata?.piAiReplay;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const state = value as Partial<PiAiReplayState>;
    if (state.kind !== 'pi-ai' || state.version !== 1) return undefined;
    if (typeof state.api !== 'string' || typeof state.provider !== 'string' || typeof state.model !== 'string') return undefined;
    if (!Array.isArray(state.blocks)) return undefined;
    const validBlocks = state.blocks.every(block => {
        if (!block || typeof block !== 'object') return false;
        if (block.type === 'text' || block.type === 'reasoning') return typeof block.text === 'string';
        return block.type === 'tool-call'
            && typeof block.id === 'string'
            && typeof block.name === 'string'
            && !!block.arguments
            && typeof block.arguments === 'object'
            && !Array.isArray(block.arguments);
    });
    if (!validBlocks || !stateMatchesVisible(message, state as PiAiReplayState)) return undefined;
    return state as PiAiReplayState;
}

function replayedAssistant(state: PiAiReplayState): AssistantMessage {
    return {
        role: 'assistant',
        api: state.api,
        provider: state.provider,
        model: state.model,
        ...(state.responseModel === undefined ? {} : { responseModel: state.responseModel }),
        ...(state.responseId === undefined ? {} : { responseId: state.responseId }),
        stopReason: state.stopReason,
        usage: emptyUsage(),
        timestamp: 0,
        content: state.blocks.map(block => {
            switch (block.type) {
                case 'text': return {
                    type: 'text' as const,
                    text: block.text,
                    ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
                };
                case 'reasoning': return {
                    type: 'thinking' as const,
                    thinking: block.text,
                    ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
                    ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
                };
                case 'tool-call': return {
                    type: 'toolCall' as const,
                    id: block.id,
                    name: block.name,
                    arguments: block.arguments,
                    ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
                };
            }
        }),
    };
}

/** Reconstruct a native assistant turn, trusting replay metadata only when visible data still matches. */
export function toPiAssistant(message: AgentMessage): AssistantMessage {
    const state = readReplayState(message);
    if (state) return replayedAssistant(state);
    const content: AssistantMessage['content'] = [];
    if (message.reasoning_content) content.push({ type: 'thinking', thinking: message.reasoning_content });
    const text = visibleText(message);
    if (text) content.push({ type: 'text', text });
    for (const raw of message.tool_calls ?? []) {
        const tool: ToolCall = {
            type: 'toolCall',
            id: typeof raw?.id === 'string' ? raw.id : '',
            name: typeof raw?.function?.name === 'string' ? raw.function.name : '',
            arguments: parseArguments(raw?.function?.arguments),
        };
        content.push(tool);
    }
    return {
        role: 'assistant',
        content,
        api: 'mutsumi-foreign' as Api,
        provider: 'mutsumi-foreign',
        model: 'mutsumi-foreign',
        usage: emptyUsage(),
        stopReason: (message.tool_calls?.length ?? 0) > 0 ? 'toolUse' : 'stop',
        timestamp: 0,
    };
}
