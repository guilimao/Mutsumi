import type { Context, Message, Tool } from '@earendil-works/pi-ai';
import type { AgentMessage } from '../types';
import type { ToolDefinition } from '../tools.d/interface';

/**
 * Drops Mutsumi-only state (`mutsumi`) so only the native pi-ai message reaches the provider.
 * Both user and assistant messages carry such state; anything else is passed through by
 * reference, since the provider consumes the message unchanged.
 */
function stripMutsumiState(message: AgentMessage): Message {
    if ((message.role === 'user' || message.role === 'assistant') && message.mutsumi !== undefined) {
        const { mutsumi: _mutsumi, ...native } = message;
        return native;
    }
    return message;
}

/** Build the exact pi-ai request context without translating message formats. */
export function toPiContext(
    systemPrompt: string | undefined,
    messages: AgentMessage[],
    tools: ToolDefinition[] = [],
): Context {
    const nativeMessages: Message[] = messages.map(stripMutsumiState);
    const piTools: Tool[] = tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description ?? '',
        parameters: (tool.function.parameters ?? { type: 'object', properties: {} }) as Tool['parameters'],
    }));
    return {
        ...(systemPrompt ? { systemPrompt } : {}),
        messages: nativeMessages,
        ...(piTools.length > 0 ? { tools: piTools } : {}),
    };
}
