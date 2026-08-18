import type { Context, Message, Tool } from '@earendil-works/pi-ai';
import type { AgentMessage } from '../types';
import type { ToolDefinition } from '../tools.d/interface';

/** Build the exact pi-ai request context without translating message formats. */
export function toPiContext(
    systemPrompt: string | undefined,
    messages: AgentMessage[],
    tools: ToolDefinition[] = [],
): Context {
    const nativeMessages: Message[] = messages.map(message => {
        if (message.role !== 'user' || message.mutsumi === undefined) return message;
        const { mutsumi: _mutsumi, ...native } = message;
        return native;
    });
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
