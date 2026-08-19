import * as vscode from 'vscode';
import { TextDecoder, TextEncoder } from 'util';
import { AgentContext, AgentMessage, AgentMetadata, MTM_FORMAT_VERSION } from '../types';
import { AgentOrchestrator } from '../agent/agentOrchestrator';
import { ToolManager } from '../tools.d/toolManager';
import { v4 as uuidv4 } from 'uuid';
import { debugLogger } from '../debugLogger';
import { resolveAgentDefaults } from '../config/resolver';
import { RenderBlock, RenderData } from './renderTypes';
import { GhostBlock } from '../contextManagement/interfaces';
import { decodeGhostBlock } from '../contextManagement/ghostBlocks';
import { t } from '../i18n';
import type { McpToolSelection } from '../mcp/interfaces';
import { decodeAgentContext, encodeAgentContext, isMtmFormatError, UNSUPPORTED_MTM_FORMAT } from '../mtmFormat';

// ============================================================================
// Core Data Structures (VSCode-agnostic)
// ============================================================================

/**
 * Generic cell data structure, independent of VSCode API.
 * Used by both NotebookSerializer and HeadlessAdapter.
 */
export interface GenericCellData {
    /** Cell kind: 1 = Markup (assistant), 2 = Code (user) */
    kind: 1 | 2;
    /** Cell content value */
    value: string;
    /** Cell metadata including role, ghost blocks, interaction */
    metadata?: {
        role?: 'user' | 'assistant';
        timestamp?: number;
        /** Raw persisted ghost block metadata; decoded at adapter/serializer boundaries */
        last_ghost_block?: unknown;
        mutsumi_interaction?: AgentMessage[];
        [key: string]: any;
    };
}

/**
 * Result of converting AgentMessage array to cells.
 */
export interface MessageToCellsResult {
    cells: GenericCellData[];
}

/**
 * Convert AgentMessage array to generic cells (message grouping logic).
 * This is the core algorithm shared between Notebook and Headless adapters.
 * 
 * Rules:
 * - User messages become Code cells (kind: 2)
 * - Assistant messages become Markup cells (kind: 1)
 * - Consecutive assistant + toolResult messages are grouped into one cell's mutsumi_interaction
 * 
 * IMPORTANT: mutsumi_interaction ONLY exists on user cells, never on assistant cells.
 * Assistant/tool messages following a user message are stored in that user cell's
 * mutsumi_interaction array for rendering as output.
 */
export function messagesToGenericCells(messages: AgentMessage[]): GenericCellData[] {
    debugLogger.log(`[messagesToGenericCells] ==== START, input message count: ${messages?.length ?? 0} ====`);
    const cells: GenericCellData[] = [];

    if (!messages || messages.length === 0) {
        debugLogger.log('[messagesToGenericCells] Empty messages array, returning empty cells');
        return cells;
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        debugLogger.log(`[messagesToGenericCells] Processing message ${i}: role=${msg.role}`);

        if (msg.role === 'user') {
            // User message as Code cell
            const cellValue = serializeContentToString(msg.content);
            debugLogger.log(`[messagesToGenericCells]   - User cell, content length: ${cellValue.length}`);
            const cell: GenericCellData = {
                kind: 2,
                value: cellValue,
                metadata: { role: 'user', timestamp: msg.timestamp }
            };

            // Preserve metadata (especially ghost block state)
            if (msg.mutsumi?.ghostBlock) {
                cell.metadata!.last_ghost_block = msg.mutsumi.ghostBlock;
            }

            // Look ahead for associated assistant/tool messages
            // These will be stored in mutsumi_interaction and rendered as this cell's output
            const group: AgentMessage[] = [];
            let j = i + 1;
            while (j < messages.length) {
                const next = messages[j];
                if (next.role === 'user') {
                    break;
                }
                group.push(next);
                j++;
            }

            if (group.length > 0) {
                i = j - 1;
                cell.metadata = cell.metadata || {};
                cell.metadata.mutsumi_interaction = group;
                debugLogger.log(`[messagesToGenericCells]   - Attached interaction group with ${group.length} messages, advanced i to ${i}`);
            }

            cells.push(cell);
            debugLogger.log(`[messagesToGenericCells]   - Added user cell #${cells.length}`);
        } else {
            throw new Error(t('serializer.standaloneMessagesUnsupported', MTM_FORMAT_VERSION));
        }
    }

    debugLogger.log(`[messagesToGenericCells] ==== END, generated ${cells.length} cells ====`);
    return cells;
}

/**
 * Convert generic cells back to AgentMessage array.
 * Used for serialization to file.
 * 
 * NOTE: mutsumi_interaction is ONLY expanded from user cells, never from assistant cells.
 */
export function genericCellsToMessages(cells: GenericCellData[]): AgentMessage[] {
    debugLogger.log(`[genericCellsToMessages] ==== START, input ${cells?.length ?? 0} cells ====`);
    const messages: AgentMessage[] = [];

    if (!cells || cells.length === 0) {
        debugLogger.log('[genericCellsToMessages] Empty cells array, returning empty messages');
        return messages;
    }

    for (let idx = 0; idx < cells.length; idx++) {
        const cell = cells[idx];
        const role = cell.metadata?.role ?? (cell.kind === 2 ? 'user' : 'assistant');
        debugLogger.log(`[genericCellsToMessages] Cell ${idx}: kind=${cell.kind}, role=${role}, value length=${cell.value?.length ?? 0}`);

        if (role === 'user') {
            // Strip ghost block from persisted content
            const cleanContent = stripGhostBlockFromCell(cell.value);

            const userMsg: AgentMessage = {
                role: 'user',
                content: parseSerializedUserContent(cleanContent),
                timestamp: Number(cell.metadata?.timestamp) || 0,
            };

            const ghostBlock = decodeGhostBlock(cell.metadata?.last_ghost_block);
            if (ghostBlock) {
                userMsg.mutsumi = { ghostBlock };
            }

            messages.push(userMsg);
            debugLogger.log(`[genericCellsToMessages]   - Added user message, content length: ${cleanContent.length}`);

            // Expand interaction if exists (ONLY for user cells)
            if (cell.metadata?.mutsumi_interaction) {
                messages.push(...cell.metadata.mutsumi_interaction);
                debugLogger.log(`[genericCellsToMessages]   - Expanded interaction: ${cell.metadata.mutsumi_interaction.length} messages`);
            }
        } else {
            throw new Error(t('serializer.standaloneAssistantSerializationUnsupported', MTM_FORMAT_VERSION));
        }
    }

    debugLogger.log(`[genericCellsToMessages] ==== END, generated ${messages.length} messages ====`);
    return messages;
}

/**
 * Extract and decode ghost blocks from generic cells.
 * Returns one entry per user cell in order; absent or structurally invalid
 * persisted values decode to null so history replay stays index-aligned.
 * @param cells - Generic cells converted from messages or notebook data
 * @returns Structured ghost blocks or null placeholders in user-cell order
 */
export function extractGhostBlocksFromCells(cells: GenericCellData[]): (GhostBlock | null)[] {
    const ghostBlocks: (GhostBlock | null)[] = [];

    for (const cell of cells) {
        if (cell.metadata?.role === 'user' || (!cell.metadata?.role && cell.kind === 2)) {
            ghostBlocks.push(decodeGhostBlock(cell.metadata?.last_ghost_block));
        }
    }

    return ghostBlocks;
}

/**
 * Build RenderBlocks from an interaction message group.
 * Pure function shared by deserializeNotebook output generation.
 */
function buildInteractionRenderBlocks(group: AgentMessage[], isSubAgent: boolean): RenderBlock[] {
    const blocks: RenderBlock[] = [];
    const toolResults = new Map<string, Extract<AgentMessage, { role: 'toolResult' }>>();
    for (const message of group) {
        if (message.role === 'toolResult') toolResults.set(message.toolCallId, message);
    }

    for (const m of group) {
        if (m.role === 'assistant') {
            for (const part of m.content) {
                if (part.type === 'thinking' && part.thinking) {
                    blocks.push({ type: 'reasoning', markdown: part.thinking, collapsed: true });
                } else if (part.type === 'text' && part.text) {
                    blocks.push({ type: 'content', markdown: part.text });
                } else if (part.type === 'toolCall') {
                    const result = toolResults.get(part.id);
                    const summary = ToolManager.getInstance().getPrettyPrint(part.name, part.arguments, isSubAgent);
                    const renderingConfig = ToolManager.getInstance().getToolRenderingConfig(part.name, isSubAgent);
                    blocks.push({
                        type: 'toolCall',
                        name: part.name,
                        args: part.arguments,
                        summary,
                        result: result ? serializeContentToString(result.content) : undefined,
                        isStreaming: false,
                        renderingConfig,
                    });
                }
            }
        }
    }
    return blocks;
}

/**
 * Strip ghost block from cell content.
 */
function stripGhostBlockFromCell(value: string): string {
    const GHOST_BLOCK_MARKER = '<content_reference>';
    const index = value.indexOf(GHOST_BLOCK_MARKER);
    if (index !== -1) {
        return value.substring(0, index).trimEnd();
    }
    return value;
}

/** Restore native image blocks emitted by serializeContentToString. */
function parseSerializedUserContent(value: string): Extract<AgentMessage, { role: 'user' }>['content'] {
    const pattern = /!\[[^\]]*\]\(data:([^;,]+);base64,([^)]+)\)/g;
    const matches = [...value.matchAll(pattern)];
    if (matches.length === 0) return value;
    const parts: Extract<AgentMessage, { role: 'user' }>['content'] = [];
    let offset = 0;
    for (const match of matches) {
        const index = match.index ?? 0;
        if (index > offset) parts.push({ type: 'text', text: value.slice(offset, index) });
        parts.push({ type: 'image', mimeType: match[1], data: match[2] });
        offset = index + match[0].length;
    }
    if (offset < value.length) parts.push({ type: 'text', text: value.slice(offset) });
    return parts;
}

/**
 * Serialize message content to string.
 */
function serializeContentToString(content: string | readonly ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]): string {
    if (!content) return '';
    if (typeof content === 'string') return content;

    return content.map(part => {
        if (part.type === 'text') {
            return part.text;
        } else if (part.type === 'image') {
            return `![image](data:${part.mimeType};base64,${part.data})`;
        }
        return '';
    }).join('');
}

// ============================================================================
// VSCode-specific Serialization
// ============================================================================

/**
 * @description Mutsumi Notebook serializer class
 * @class MutsumiSerializer
 * @implements {vscode.NotebookSerializer}
 * 
 * Responsible for serializing and deserializing Agent conversation notebooks, 
 * converting notebook data to JSON format for storage, 
 * and restoring to VS Code Notebook cell structure when loading.
 */
export class MutsumiSerializer implements vscode.NotebookSerializer {

    /**
     * @description Deserialize notebook data
     * @param {Uint8Array} content - Byte array of file content
     * @param {vscode.CancellationToken} _token - Cancellation token
     * @returns {Promise<vscode.NotebookData>} Parsed notebook data
     * 
     * @example
     * const serializer = new MutsumiSerializer();
     * const notebookData = await serializer.deserializeNotebook(fileContent, token);
     */
    async deserializeNotebook(
        content: Uint8Array,
        _token: vscode.CancellationToken
    ): Promise<vscode.NotebookData> {
        debugLogger.log('[deserializeNotebook] ==== START ====');
        let raw: AgentContext;
        try {
            raw = decodeAgentContext(content);
        } catch (error) {
            if (isMtmFormatError(error)) {
                const message = error.code === UNSUPPORTED_MTM_FORMAT
                    ? t('serializer.unsupportedFormat', MTM_FORMAT_VERSION, String(error.actualVersion))
                    : t('serializer.invalidFormat', error.message);
                void vscode.window.showErrorMessage(message);
            }
            throw error;
        }
        debugLogger.log(`[deserializeNotebook] Parsed formatVersion=${raw.formatVersion}, uuid=${raw.metadata.uuid}`);

        // Use generic cell conversion
        debugLogger.log(`[deserializeNotebook] Converting ${raw.context?.length ?? 0} messages to generic cells...`);
        const genericCells = messagesToGenericCells(raw.context);
        debugLogger.log(`[deserializeNotebook] Generated ${genericCells.length} generic cells`);
        genericCells.forEach((cell, idx) => {
            debugLogger.log(`[deserializeNotebook] GenericCell ${idx}: kind=${cell.kind}, role=${cell.metadata?.role}, value length=${cell.value?.length ?? 0}, has interaction=${!!cell.metadata?.mutsumi_interaction}`);
            if (cell.metadata?.mutsumi_interaction) {
                debugLogger.log(`[deserializeNotebook]   - interaction count: ${cell.metadata.mutsumi_interaction.length}`);
            }
        });
        
        // Convert to VSCode cells
        debugLogger.log(`[deserializeNotebook] Converting generic cells to VSCode NotebookCellData...`);
        const cells: vscode.NotebookCellData[] = genericCells.map((genCell, idx) => {
            const cell = new vscode.NotebookCellData(
                genCell.kind === 2 ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup,
                genCell.value,
                'markdown'
            );
            cell.metadata = genCell.metadata;
            debugLogger.log(`[deserializeNotebook] VSCode Cell ${idx}: kind=${cell.kind}, metadata role=${cell.metadata?.role}, metadata keys=${Object.keys(cell.metadata ?? {}).join(',')}`);

            // Add outputs for user cells with mutsumi_interaction
            // mutsumi_interaction contains assistant/tool messages that should be rendered as output
            if (genCell.metadata?.role === 'user' && genCell.metadata?.mutsumi_interaction) {
                const blocks = buildInteractionRenderBlocks(genCell.metadata.mutsumi_interaction, !!raw.metadata.parent_agent_id);
                const renderData: RenderData = { committed: blocks, active: null };
                const item = vscode.NotebookCellOutputItem.json(renderData, 'application/vnd.mutsumi.agent-chat');
                cell.outputs = [new vscode.NotebookCellOutput([item])];
                debugLogger.log(`[deserializeNotebook]   - added output for user cell with ${blocks.length} render blocks`);
            }

            return cell;
        });

        const notebookData = new vscode.NotebookData(cells);
        notebookData.metadata = raw.metadata;
        debugLogger.log(`[deserializeNotebook] NotebookData created with ${cells.length} cells`);

        // Sync sub_agents_list to agentRegistry childIds on load
        if (raw.metadata.uuid) {
            const agent = AgentOrchestrator.getInstance().getAgentById(raw.metadata.uuid);
            if (agent && raw.metadata.sub_agents_list) {
                agent.childIds = new Set(raw.metadata.sub_agents_list);
                debugLogger.log(`[deserializeNotebook] Synced sub_agents_list: ${raw.metadata.sub_agents_list.length} items`);
            }
        }

        debugLogger.log('[deserializeNotebook] ==== END ====');
        return notebookData;
    }

    /**
     * @description Create default notebook content
     * @param {string[]} allowedUris - List of allowed URIs
     * @param {string} [agentType] - Optional agent type identifier (e.g., 'chat', 'orchestrator', 'implementer', 'reviewer')
     * @param {string[]} activeRules - Optional list of active rules to start with
     * @param {string} [uuid] - Optional UUID for the agent. If not provided, a new UUID will be generated.
     * @param {string[]} [activeSkills] - Optional list of active skills to start with
     * @returns {Uint8Array} Encoded default content
     * @static
     * 
     * @example
     * const content = MutsumiSerializer.createDefaultContent(['/workspace/project'], 'implementer', ['default.md']);
     * await vscode.workspace.fs.writeFile(uri, content);
     */
    static createDefaultContent(
        allowedUris: string[], 
        agentType: string,
        activeRules?: string[], 
        uuid?: string, 
        activeSkills?: string[],
        enabledMcpTools?: McpToolSelection[]
    ): Uint8Array {
        // Resolve agent type defaults using centralized resolver
        const defaults = resolveAgentDefaults(agentType, {
            rules: activeRules,
            skills: activeSkills
        });

        const raw: AgentContext = {
            formatVersion: MTM_FORMAT_VERSION,
            metadata: {
                uuid: uuid ?? uuidv4(),
                name: t('serializer.newAgent'),
                created_at: new Date().toISOString(),
                parent_agent_id: null,
                allowed_uris: allowedUris,
                model: defaults.model,
                provider: defaults.provider,
                contextItems: [
                    {
                        type: 'macro',
                        key: 'ROLE',
                        content: agentType
                    }
                ],
                activeRules: defaults.rules,
                activeSkills: defaults.skills,
                agentType: agentType,
                enabledMcpTools
            },
            context: []
        };
        return encodeAgentContext(raw);
    }

    /**
     * @description Serialize notebook data
     * @param {vscode.NotebookData} data - Notebook data
     * @param {vscode.CancellationToken} _token - Cancellation token
     * @returns {Promise<Uint8Array>} Serialized byte array
     * 
     * @example
     * const serializer = new MutsumiSerializer();
     * const bytes = await serializer.serializeNotebook(notebookData, token);
     * await vscode.workspace.fs.writeFile(uri, bytes);
     */
    async serializeNotebook(
        data: vscode.NotebookData,
        _token: vscode.CancellationToken
    ): Promise<Uint8Array> {
        debugLogger.log('[serializeNotebook] ==== START ====');
        debugLogger.log(`[serializeNotebook] Input: ${data.cells.length} cells`);

        // Convert VSCode cells to generic cells
        const genericCells: GenericCellData[] = data.cells.map((cell, idx) => {
            debugLogger.log(`[serializeNotebook] Cell ${idx}: kind=${cell.kind}, metadata role=${cell.metadata?.role}, value length=${cell.value?.length ?? 0}`);
            return {
                kind: cell.kind === vscode.NotebookCellKind.Code ? 2 : 1,
                value: cell.value,
                metadata: cell.metadata as GenericCellData['metadata']
            };
        });

        // Use generic conversion
        debugLogger.log(`[serializeNotebook] Converting ${genericCells.length} generic cells to messages...`);
        const context = genericCellsToMessages(genericCells);
        debugLogger.log(`[serializeNotebook] Generated ${context.length} messages`);
        context.forEach((msg, idx) => {
            debugLogger.log(`[serializeNotebook] Message ${idx}: role=${msg.role}, content length=${typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length}`);
        });

        // Build metadata with sub_agents_list from agentRegistry
        // This ensures the relationship is only persisted when this agent is saved,
        // not when child agents are created
        const metadata = { ...data.metadata } as AgentMetadata;
        if (metadata.uuid) {
            const agent = AgentOrchestrator.getInstance().getAgentById(metadata.uuid);
            if (agent?.childIds) {
                metadata.sub_agents_list = Array.from(agent.childIds);
                debugLogger.log(`[serializeNotebook] Synced sub_agents_list: ${metadata.sub_agents_list.length} items`);
            }
        }

        const output: AgentContext = {
            formatVersion: MTM_FORMAT_VERSION,
            metadata,
            context
        };

        const encoded = encodeAgentContext(output);
        debugLogger.log(`[serializeNotebook] ==== END, output size: ${encoded.length} bytes ====`);
        return encoded;
    }

}
