import type {
    AssistantMessage,
    ImageContent,
    Message,
    TextContent,
    ThinkingContent,
    ToolCall,
    ToolResultMessage,
    Usage,
    UserMessage,
} from '@earendil-works/pi-ai';
import { decodeGhostBlock } from './contextManagement/ghostBlocks';
import {
    AgentContext,
    AgentMessage,
    AgentMetadata,
    MTM_FORMAT_VERSION,
} from './types';

export const UNSUPPORTED_MTM_FORMAT = 'UNSUPPORTED_MTM_FORMAT';
export const INVALID_MTM_FILE = 'INVALID_MTM_FILE';

export class MtmFormatError extends Error {
    constructor(
        readonly code: typeof UNSUPPORTED_MTM_FORMAT | typeof INVALID_MTM_FILE,
        message: string,
        readonly actualVersion?: unknown,
    ) {
        super(message);
        this.name = 'MtmFormatError';
    }
}

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function textContent(value: unknown): value is TextContent {
    return record(value)
        && value.type === 'text'
        && typeof value.text === 'string'
        && (value.textSignature === undefined || typeof value.textSignature === 'string');
}

function imageContent(value: unknown): value is ImageContent {
    return record(value)
        && value.type === 'image'
        && typeof value.data === 'string'
        && typeof value.mimeType === 'string';
}

function thinkingContent(value: unknown): value is ThinkingContent {
    return record(value)
        && value.type === 'thinking'
        && typeof value.thinking === 'string'
        && (value.thinkingSignature === undefined || typeof value.thinkingSignature === 'string')
        && (value.redacted === undefined || typeof value.redacted === 'boolean');
}

function toolCall(value: unknown): value is ToolCall {
    return record(value)
        && value.type === 'toolCall'
        && typeof value.id === 'string'
        && typeof value.name === 'string'
        && record(value.arguments)
        && (value.thoughtSignature === undefined || typeof value.thoughtSignature === 'string');
}

function usage(value: unknown): value is Usage {
    if (!record(value) || !record(value.cost)) return false;
    const cost = value.cost;
    return ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => finiteNumber(value[key]))
        && (value.cacheWrite1h === undefined || finiteNumber(value.cacheWrite1h))
        && (value.reasoning === undefined || finiteNumber(value.reasoning))
        && ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(key => finiteNumber(cost[key]));
}

function stringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function userMessage(value: unknown): value is UserMessage & AgentMessage {
    if (!record(value)) return false;
    const content = value.content;
    const validContent = typeof content === 'string'
        || (Array.isArray(content) && content.every(part => textContent(part) || imageContent(part)));
    if (!validContent || !finiteNumber(value.timestamp)) return false;
    if (value.mutsumi !== undefined) {
        if (!record(value.mutsumi)) return false;
        if (value.mutsumi.ghostBlock !== undefined && !decodeGhostBlock(value.mutsumi.ghostBlock)) return false;
    }
    return true;
}

function assistantMessage(value: unknown): value is AssistantMessage {
    if (!record(value)) return false;
    const stopReasons = new Set(['stop', 'length', 'toolUse', 'error', 'aborted']);
    return Array.isArray(value.content)
        && value.content.every(block => textContent(block) || thinkingContent(block) || toolCall(block))
        && typeof value.api === 'string'
        && typeof value.provider === 'string'
        && typeof value.model === 'string'
        && (value.responseModel === undefined || typeof value.responseModel === 'string')
        && (value.responseId === undefined || typeof value.responseId === 'string')
        && usage(value.usage)
        && stopReasons.has(value.stopReason as string)
        && (value.errorMessage === undefined || typeof value.errorMessage === 'string')
        && finiteNumber(value.timestamp)
        && value.mutsumi === undefined;
}

function toolResultMessage(value: unknown): value is ToolResultMessage {
    if (!record(value)) return false;
    return typeof value.toolCallId === 'string'
        && typeof value.toolName === 'string'
        && Array.isArray(value.content)
        && value.content.every(part => textContent(part) || imageContent(part))
        && (value.usage === undefined || usage(value.usage))
        && (value.addedToolNames === undefined || stringArray(value.addedToolNames))
        && typeof value.isError === 'boolean'
        && finiteNumber(value.timestamp)
        && value.mutsumi === undefined;
}

function parseMessages(value: unknown): AgentMessage[] {
    if (!Array.isArray(value)) throw invalid('context must be an array');
    const messages: AgentMessage[] = [];
    let sawUser = false;
    let lastRole: AgentMessage['role'] | undefined;
    const availableToolCalls = new Map<string, string>();

    for (let index = 0; index < value.length; index++) {
        const raw = value[index];
        if (!record(raw) || typeof raw.role !== 'string') throw invalid(`context[${index}] is not a message`);
        for (const forbidden of ['tool_calls', 'tool_call_id', 'reasoning_content', 'piAiReplay', 'metadata']) {
            if (forbidden in raw) throw invalid(`context[${index}] contains removed field "${forbidden}"`);
        }
        let message: Message;
        if (raw.role === 'user' && userMessage(raw)) {
            if (lastRole === 'user' || availableToolCalls.size > 0) {
                throw invalid(`context[${index}] has an unexpected user message`);
            }
            sawUser = true;
            message = raw;
        } else if (raw.role === 'assistant' && sawUser && assistantMessage(raw)) {
            if ((lastRole !== 'user' && lastRole !== 'toolResult') || availableToolCalls.size > 0) {
                throw invalid(`context[${index}] has an unexpected assistant message`);
            }
            for (const block of raw.content) {
                if (block.type === 'toolCall') {
                    if (availableToolCalls.has(block.id)) {
                        throw invalid(`context[${index}] contains duplicate tool call ID "${block.id}"`);
                    }
                    availableToolCalls.set(block.id, block.name);
                }
            }
            message = raw;
        } else if (raw.role === 'toolResult' && sawUser && toolResultMessage(raw)) {
            if (lastRole !== 'assistant' && lastRole !== 'toolResult') {
                throw invalid(`context[${index}] has an unexpected tool result`);
            }
            const expectedName = availableToolCalls.get(raw.toolCallId);
            if (expectedName === undefined || expectedName !== raw.toolName) {
                throw invalid(`context[${index}] does not match a preceding tool call`);
            }
            availableToolCalls.delete(raw.toolCallId);
            message = raw;
        } else {
            throw invalid(`context[${index}] is not a valid pi-ai message or violates turn ordering`);
        }
        messages.push(message as AgentMessage);
        lastRole = message.role;
    }
    if (availableToolCalls.size > 0) throw invalid('context ends before all tool calls have results');
    return messages;
}

function invalid(detail: string): MtmFormatError {
    return new MtmFormatError(INVALID_MTM_FILE, `Invalid .mtm file: ${detail}`);
}

export function parseAgentContext(value: unknown): AgentContext {
    if (!record(value)) throw invalid('root must be an object');
    if (value.formatVersion !== MTM_FORMAT_VERSION) {
        throw new MtmFormatError(
            UNSUPPORTED_MTM_FORMAT,
            `Unsupported .mtm format (expected ${MTM_FORMAT_VERSION}, received ${String(value.formatVersion)}). Migrate this file with the standalone migration tool.`,
            value.formatVersion,
        );
    }
    if (!record(value.metadata)) throw invalid('metadata must be an object');
    const metadata = value.metadata as unknown as AgentMetadata;
    if (typeof metadata.uuid !== 'string' || typeof metadata.name !== 'string'
        || typeof metadata.created_at !== 'string' || !stringArray(metadata.allowed_uris)
        || (metadata.parent_agent_id !== null && typeof metadata.parent_agent_id !== 'string')) {
        throw invalid('metadata is missing required fields');
    }
    if ((metadata.model === undefined) !== (metadata.provider === undefined)
        || (metadata.model !== undefined && typeof metadata.model !== 'string')
        || (metadata.provider !== undefined && typeof metadata.provider !== 'string')) {
        throw invalid('metadata model and provider must be a complete string pair');
    }
    if (metadata.provider === 'kimi-for-coding') throw invalid('metadata uses the removed provider ID "kimi-for-coding"');
    const context = parseMessages(value.context);
    for (const message of context) {
        if (message.role === 'assistant' && message.provider === 'kimi-for-coding') {
            throw invalid('assistant message uses the removed provider ID "kimi-for-coding"');
        }
    }
    return { formatVersion: MTM_FORMAT_VERSION, metadata, context };
}

export function decodeAgentContext(content: Uint8Array): AgentContext {
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder().decode(content));
    } catch (error) {
        const wrapped = new MtmFormatError(INVALID_MTM_FILE, 'Invalid .mtm file: content is not valid JSON');
        (wrapped as Error & { cause?: unknown }).cause = error;
        throw wrapped;
    }
    return parseAgentContext(value);
}

export function encodeAgentContext(context: AgentContext): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(parseAgentContext(context), null, 2));
}

export function isMtmFormatError(error: unknown): error is MtmFormatError {
    return error instanceof MtmFormatError;
}
