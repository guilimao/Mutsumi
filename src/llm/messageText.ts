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

export function assistantText(message: AssistantMessage): string {
    return message.content.filter(block => block.type === 'text').map(block => block.text).join('');
}
