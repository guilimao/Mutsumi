import type {
    ImageContent,
    TextContent,
    ThinkingContent,
    ToolCall,
} from '@earendil-works/pi-ai';
import { decodeGhostBlock } from './contextManagement/ghostBlocks';
import {
    AgentContext,
    AgentMetadata,
    MTM_FORMAT_VERSION,
    NotebookNote,
    PersistedAgentMessage,
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

function textContent(value: unknown): value is TextContent {
    return record(value)
        && value.type === 'text'
        && typeof value.text === 'string';
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
        && typeof value.thinking === 'string';
}

function toolCall(value: unknown): value is ToolCall {
    return record(value)
        && value.type === 'toolCall'
        && typeof value.id === 'string'
        && typeof value.name === 'string'
        && record(value.arguments);
}

function stringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function userMessage(value: unknown): value is PersistedAgentMessage & { role: 'user' } {
    if (!record(value)) return false;
    const content = value.content;
    const validContent = typeof content === 'string'
        || (Array.isArray(content) && content.every(part => textContent(part) || imageContent(part)));
    if (!validContent) return false;
    if (value.mutsumi !== undefined) {
        if (!record(value.mutsumi)) return false;
        if (value.mutsumi.ghostBlock !== undefined && !decodeGhostBlock(value.mutsumi.ghostBlock)) return false;
    }
    return true;
}

function assistantMessage(value: unknown): value is PersistedAgentMessage & { role: 'assistant' } {
    if (!record(value)) return false;
    return Array.isArray(value.content)
        && value.content.every(block => textContent(block) || thinkingContent(block) || toolCall(block))
        && typeof value.api === 'string'
        && typeof value.provider === 'string'
        && typeof value.model === 'string'
        && value.mutsumi === undefined;
}

function toolResultMessage(value: unknown): value is PersistedAgentMessage & { role: 'toolResult' } {
    if (!record(value)) return false;
    return typeof value.toolCallId === 'string'
        && typeof value.toolName === 'string'
        && Array.isArray(value.content)
        && value.content.every(part => textContent(part) || imageContent(part))
        && typeof value.isError === 'boolean'
        && value.mutsumi === undefined;
}

function parseMessages(value: unknown): PersistedAgentMessage[] {
    if (!Array.isArray(value)) throw invalid('context must be an array');
    const messages: PersistedAgentMessage[] = [];
    let sawUser = false;
    let lastRole: PersistedAgentMessage['role'] | undefined;
    const availableToolCalls = new Map<string, string>();

    for (let index = 0; index < value.length; index++) {
        const raw = value[index];
        if (!record(raw) || typeof raw.role !== 'string') throw invalid(`context[${index}] is not a message`);
        let message: PersistedAgentMessage;
        if (raw.role === 'user' && userMessage(raw)) {
            if (availableToolCalls.size > 0) {
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
        messages.push(message);
        lastRole = message.role;
    }
    if (availableToolCalls.size > 0) throw invalid('context ends before all tool calls have results');
    return messages;
}

/**
 * Validate a notebook cell's interaction metadata without letting malformed UI
 * state abort the whole run. An interaction may contain assistant/toolResult
 * messages only and must form complete tool rounds.
 */
export function parsePersistedInteraction(value: unknown): PersistedAgentMessage[] | undefined {
    if (!Array.isArray(value) || value.some(item => record(item) && item.role === 'user')) return undefined;
    try {
        const parsed = parseMessages([{ role: 'user', content: '', timestamp: 0 }, ...value]);
        return parsed.slice(1);
    } catch {
        return undefined;
    }
}

function parseNotes(value: unknown, userCount: number): NotebookNote[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw invalid('notes must be an array');
    const notes: NotebookNote[] = [];
    for (let index = 0; index < value.length; index++) {
        const item = value[index];
        if (!record(item)
            || !Number.isInteger(item.beforeUserIndex)
            || (item.beforeUserIndex as number) < 0
            || (item.beforeUserIndex as number) > userCount
            || typeof item.markdown !== 'string') {
            throw invalid(`notes[${index}] is not a valid notebook note`);
        }
        notes.push({ beforeUserIndex: item.beforeUserIndex as number, markdown: item.markdown });
    }
    return notes.length > 0 ? notes : undefined;
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
    const notes = parseNotes(value.notes, context.filter(message => message.role === 'user').length);
    return { formatVersion: MTM_FORMAT_VERSION, metadata, context, ...(notes ? { notes } : {}) };
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
