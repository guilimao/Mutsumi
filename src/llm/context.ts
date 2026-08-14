import type { Context, ImageContent, Message, TextContent, Tool } from '@earendil-works/pi-ai';
import type { AgentMessage, MessageContent } from '../types';
import { toPiAssistant } from './replay';

interface OpenAiToolDefinition {
    type: 'function';
    function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

function decodeDataUrl(url: string): ImageContent {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
    if (!match) throw new Error('Only base64 data URLs can be sent as image content');
    return { type: 'image', mimeType: match[1], data: match[2] };
}

function userContent(content: MessageContent | null): string | (TextContent | ImageContent)[] {
    if (content === null || typeof content === 'string') return content ?? '';
    const parts: (TextContent | ImageContent)[] = [];
    for (const part of content) {
        if (part.type === 'text') {
            if (part.text) parts.push({ type: 'text', text: part.text });
        } else {
            parts.push(decodeDataUrl(part.image_url.url));
        }
    }
    return parts.every(part => part.type === 'text')
        ? parts.map(part => (part as TextContent).text).join('')
        : parts;
}

function textContent(content: MessageContent | null): string {
    if (content === null) return '';
    if (typeof content === 'string') return content;
    return content.filter(part => part.type === 'text').map(part => part.text).join('');
}

/** Convert Mutsumi's durable history and OpenAI-shaped tool schemas into pi-ai Context. */
export function toPiContext(messages: AgentMessage[], tools: OpenAiToolDefinition[] = []): Context {
    const converted: Message[] = [];
    const leadingSystem: string[] = [];
    let sawConversation = false;
    for (const message of messages) {
        if (message.role === 'system' && !sawConversation) {
            leadingSystem.push(textContent(message.content));
            continue;
        }
        sawConversation = true;
        if (message.role === 'system') {
            converted.push({ role: 'user', content: textContent(message.content), timestamp: 0 });
        } else if (message.role === 'user') {
            converted.push({ role: 'user', content: userContent(message.content), timestamp: 0 });
        } else if (message.role === 'assistant') {
            converted.push(toPiAssistant(message));
        } else {
            converted.push({
                role: 'toolResult',
                toolCallId: message.tool_call_id ?? '',
                toolName: message.name ?? 'unknown',
                content: [{ type: 'text', text: textContent(message.content) || '(no output)' }],
                isError: message.metadata?.isError === true
                    || /^(?:Error:|\[Interrupted\])/.test(textContent(message.content)),
                timestamp: 0,
            });
        }
    }
    const piTools: Tool[] = tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description ?? '',
        parameters: (tool.function.parameters ?? { type: 'object', properties: {} }) as Tool['parameters'],
    }));
    return {
        ...(leadingSystem.length > 0 ? { systemPrompt: leadingSystem.join('\n\n') } : {}),
        messages: converted,
        ...(piTools.length > 0 ? { tools: piTools } : {}),
    };
}
