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

/** Text-only projection of an assistant message; delegates to pi-ai's contentText. */
export function assistantText(message: AssistantMessage): string {
    return contentText(message.content);
}
