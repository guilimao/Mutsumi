import { contentText } from '@earendil-works/pi-ai';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';

/** Visible textual projection used by titles, compression, debug output, and rendering. */
export function messageText(message: Message): string {
    if (message.role === 'user') {
        if (typeof message.content === 'string') return message.content;
        return message.content.map(part => part.type === 'text' ? part.text : `[Image: ${part.mimeType}]`).join('');
    }
    if (message.role === 'assistant') {
        return message.content.map(block => {
            if (block.type === 'text') return block.text;
            if (block.type === 'thinking') return block.thinking;
            return `[Tool Call: ${block.name}]`;
        }).join('');
    }
    return message.content.map(part => part.type === 'text' ? part.text : `[Image: ${part.mimeType}]`).join('');
}

/**
 * Text-only projection of an assistant message.
 * @description Delegates to pi-ai's contentText with an explicit '' separator: the SDK
 * defaults to '\n' joining, while titles/compression/debug output historically used plain
 * concatenation of text blocks. Equivalent to joining {@link assistantTextBlocks}; callers that
 * must keep the block boundaries (rendering) should use that projection instead.
 */
export function assistantText(message: AssistantMessage): string {
    return contentText(message.content, '');
}

/**
 * Per-block text projection of an assistant message, in SDK content-block order.
 * @description The SDK appends one text block per contiguous run of visible text, so a message
 * that keeps writing after a tool call carries more than one. Rendering must keep those blocks
 * separate: joining them loses the boundary that tells the renderer a tool call interrupted the
 * prose, and lets a committed prefix swallow everything written afterwards.
 */
export function assistantTextBlocks(message: AssistantMessage): string[] {
    return message.content.flatMap(block => block.type === 'text' ? [block.text] : []);
}
