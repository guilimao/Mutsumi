import * as vscode from 'vscode';
import type { Usage } from '@earendil-works/pi-ai';
import { AgentMessage, AgentMetadata, ContextItem, PersistedAgentMessage } from '../types';
import { IAgentSession } from '../adapters/interfaces';
import { getSystemPrompt, getRulesContext } from './prompts';
import { TemplateEngine } from './templateEngine';
import { SkillManager } from './skillManager';
import {
    collectAvailableFileVersions,
    ghostBlockFromContextItems,
    ghostBlockToMarkdown,
    isEmptyGhostBlock
} from './ghostBlocks';
import {
    parseUserMessageWithImages,
    extractMacroDefinitions,
    computeHash
} from './utils';

const ZERO_USAGE: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function validUsage(value: unknown): value is Usage {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const usage = value as Record<string, unknown>;
    if (!usage.cost || typeof usage.cost !== 'object' || Array.isArray(usage.cost)) return false;
    const cost = usage.cost as Record<string, unknown>;
    return ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => finiteNumber(usage[key]))
        && (usage.cacheWrite1h === undefined || finiteNumber(usage.cacheWrite1h))
        && (usage.reasoning === undefined || finiteNumber(usage.reasoning))
        && ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(key => finiteNumber(cost[key]));
}

/** Create the strict temporary message shape required by pi-ai without changing disk data. */
export function hydrateProviderMessage(message: PersistedAgentMessage): AgentMessage {
    if (message.role === 'user') {
        return {
            ...message,
            timestamp: finiteNumber(message.timestamp) ? message.timestamp : 0,
        } as AgentMessage;
    }
    if (message.role === 'assistant') {
        const stopReasons = new Set(['stop', 'length', 'toolUse', 'error', 'aborted']);
        const inferredStopReason = message.content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop';
        return {
            ...message,
            usage: validUsage(message.usage) ? message.usage : { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
            timestamp: finiteNumber(message.timestamp) ? message.timestamp : 0,
            stopReason: typeof message.stopReason === 'string' && stopReasons.has(message.stopReason)
                ? message.stopReason
                : inferredStopReason,
        } as AgentMessage;
    }
    return {
        ...message,
        usage: validUsage(message.usage) ? message.usage : { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        timestamp: finiteNumber(message.timestamp) ? message.timestamp : 0,
    } as AgentMessage;
}

function userContentParts(content: Extract<AgentMessage, { role: 'user' }>['content']) {
    return typeof content === 'string' ? [{ type: 'text' as const, text: content }] : [...content];
}

/** Merge pending adjacent user turns only at the provider boundary. */
export function mergeConsecutiveUserMessages(messages: AgentMessage[]): AgentMessage[] {
    const merged: AgentMessage[] = [];
    for (const message of messages) {
        const previous = merged[merged.length - 1];
        if (message.role !== 'user' || previous?.role !== 'user') {
            merged.push(message);
            continue;
        }
        const content = typeof previous.content === 'string' && typeof message.content === 'string'
            ? `${previous.content}\n\n${message.content}`
            : [
                ...userContentParts(previous.content),
                { type: 'text' as const, text: '\n\n' },
                ...userContentParts(message.content),
            ];
        merged[merged.length - 1] = {
            ...previous,
            content,
            timestamp: message.timestamp,
        };
    }
    return merged;
}

/**
 * @description Build Agent's conversation history context.
 * Ghost blocks are consumed and persisted as structured GhostBlock objects;
 * markdown is projected only when assembling provider-facing message content.
 * @param session - The agent session providing history and persistence
 * @param currentPrompt - Optional current user prompt (if not provided, uses session.getInput())
 * @returns Object containing messages array, allowed URIs, and sub-agent status
 */
export async function buildInteractionHistory(
    session: IAgentSession,
    currentPrompt?: string,
    baseHistory?: PersistedAgentMessage[],
): Promise<{
    systemPrompt: string;
    messages: AgentMessage[];
    persistedMessages: PersistedAgentMessage[];
    allowedUris: string[];
    isSubAgent: boolean;
}> {
    // Get current prompt from session if not provided
    if (currentPrompt === undefined) {
        currentPrompt = await session.getInput();
    }
    const messages: AgentMessage[] = [];

    // Get config and metadata from session
    const config = await session.getConfig();
    const metadata = config.metadata || {} as AgentMetadata;
    const allowedUris = config.allowedUris || metadata.allowed_uris || ['/'];
    const isSubAgent = config.isSubAgent || !!metadata.parent_agent_id;

    // Get workspace URI
    const wsUri = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri :
        (config.resourceUri ? vscode.Uri.parse(config.resourceUri) : undefined);

    if (!wsUri) {
        throw new Error('No workspace available for resolving context references');
    }

    // Extract and merge macros
    const persistedMacroItems = (metadata.contextItems || []).filter(item => item.type === 'macro');
    const persistedMacros: Record<string, string> = {};
    for (const item of persistedMacroItems) {
        persistedMacros[item.key] = item.content;
    }
    const localMacros = extractMacroDefinitions(currentPrompt);
    const macros = { ...persistedMacros, ...localMacros };
    const macroContextItems: ContextItem[] = Object.entries(macros).map(([key, content]) => ({
        type: 'macro' as const,
        key,
        content,
    }));

    // 1. Static System Prompt (Now includes Rules)
    const activeRules = metadata.activeRules;
    const rulesItems = await getRulesContext(wsUri, allowedUris, activeRules, macros);
    let systemPromptContent = await getSystemPrompt(wsUri, allowedUris, rulesItems, isSubAgent);

    // Append skills information if available
    const activeSkills = metadata.activeSkills;
    const skillsMarkdown = SkillManager.getInstance().generateSkillsMarkdown(activeSkills);
    if (skillsMarkdown && skillsMarkdown.trim()) {
        systemPromptContent += '\n\n# Installed Skills\n' + skillsMarkdown;
    }

    // Get previous ghost blocks for version tracking
    const previousGhostBlocks = session.getPreviousGhostBlocks
        ? await session.getPreviousGhostBlocks()
        : [];
    const availableContentVersions = collectAvailableFileVersions(previousGhostBlocks);

    // 2. Prepare Context Map & Differential Update
    const persistedItems: ContextItem[] = metadata.contextItems || [];
    const persistedMap = new Map<string, ContextItem>();
    for (const item of persistedItems) {
        if (item.type === 'file') {
            persistedMap.set(item.key, item);
        }
    }

    // 2a. Parse Current Prompt using TemplateEngine (APPEND mode)
    const { renderedText: processedPrompt, collectedItems: currentContext } = await TemplateEngine.render(
        currentPrompt,
        macros,
        wsUri,
        allowedUris,
        'APPEND'
    );

    const finalItemsToDisplay: ContextItem[] = [];
    const newContextItemsForMetadata: ContextItem[] = persistedItems.filter(item => item.type === 'file');

    for (const item of currentContext) {
        if (item.type === 'file') {
            const currentHash = computeHash(item.content);
            const prevItem = persistedMap.get(item.key);

            let version = 1;
            let isModified = true;

            if (prevItem) {
                if (prevItem.lastHash === currentHash) {
                    isModified = false;
                    version = prevItem.version || 1;
                } else {
                    version = (prevItem.version || 0) + 1;
                }
            } else {
                // Check if this file was in persistedItems under a different object reference but same key?
                // persistedMap handles keys. If not in map, it's new.
                version = 1;
            }

            // Update item metadata
            item.lastHash = currentHash;
            item.version = version;

            const hasPreviousContent = !isModified && availableContentVersions.has(`${item.key}::${version}`);

            if (isModified || !hasPreviousContent) {
                // Full content
                finalItemsToDisplay.push(item);
            } else {
                // Reference only
                const refItem = { ...item };
                refItem.metadata = { ...refItem.metadata, isReference: true };
                finalItemsToDisplay.push(refItem);
            }

            // Update global metadata tracking
            const index = newContextItemsForMetadata.findIndex(i => i.key === item.key && i.type === 'file');
            if (index !== -1) {
                newContextItemsForMetadata[index] = item;
            } else {
                newContextItemsForMetadata.push(item);
            }
        } else {
            // Tools are always displayed
            finalItemsToDisplay.push(item);
        }
    }

    newContextItemsForMetadata.push(...macroContextItems);

    // 3. Build Message History from session
    const history = baseHistory ?? await session.getHistory();

    // Track ghost block index separately (only for user messages)
    let ghostBlockIndex = 0;

    // Project persisted ghost blocks into provider-facing user content. The
    // session already returns canonical, expanded pi-ai messages.
    for (const msg of history) {
        if (msg.role === 'user') {
            const multiModalContent = typeof msg.content === 'string'
                ? await parseUserMessageWithImages(msg.content)
                : [...msg.content];
            // Append the persisted ghost block if it exists
            const savedGhostBlock = previousGhostBlocks[ghostBlockIndex] ?? null;
            ghostBlockIndex++;
            const savedGhostMarkdown = savedGhostBlock && !isEmptyGhostBlock(savedGhostBlock)
                ? ghostBlockToMarkdown(savedGhostBlock)
                : '';

            if (savedGhostMarkdown) {
                if (Array.isArray(multiModalContent)) {
                    messages.push(hydrateProviderMessage({
                        role: 'user',
                        content: [...multiModalContent, { type: 'text', text: savedGhostMarkdown }],
                        timestamp: msg.timestamp,
                    }));
                } else {
                    messages.push(hydrateProviderMessage({
                        role: 'user',
                        content: multiModalContent + savedGhostMarkdown,
                        timestamp: msg.timestamp,
                    }));
                }
            } else {
                messages.push(hydrateProviderMessage({ role: 'user', content: multiModalContent, timestamp: msg.timestamp }));
            }
        } else {
            messages.push(hydrateProviderMessage(msg));
        }
    }

    // 4. Assemble Final User Message
    const currentGhostBlock = ghostBlockFromContextItems(finalItemsToDisplay);
    const currentGhostMarkdown = isEmptyGhostBlock(currentGhostBlock)
        ? ''
        : ghostBlockToMarkdown(currentGhostBlock);

    // 5. Persist context items and ghost block via session
    if (session.updateContextItems) {
        await session.updateContextItems(newContextItemsForMetadata);
    }

    if (session.persistGhostBlock) {
        await session.persistGhostBlock(currentGhostBlock);
    }

    // 6. Push final message
    const currentTimestamp = Date.now();
    const persistedMessages: PersistedAgentMessage[] = [
        ...history,
        { role: 'user', content: currentPrompt, timestamp: currentTimestamp },
    ];
    const currentMultiModalContent = await parseUserMessageWithImages(processedPrompt);
    if (currentGhostMarkdown) {
        if (Array.isArray(currentMultiModalContent)) {
            currentMultiModalContent.push({ type: 'text', text: currentGhostMarkdown });
            messages.push({ role: 'user', content: currentMultiModalContent, timestamp: currentTimestamp });
        } else {
            messages.push({ role: 'user', content: currentMultiModalContent + currentGhostMarkdown, timestamp: currentTimestamp });
        }
    } else {
        messages.push({ role: 'user', content: currentMultiModalContent, timestamp: currentTimestamp });
    }

    return {
        systemPrompt: systemPromptContent,
        messages: mergeConsecutiveUserMessages(messages),
        persistedMessages,
        allowedUris,
        isSubAgent,
    };
}
