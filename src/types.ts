/**
 * @fileoverview Core type definitions for the Mutsumi VSCode extension.
 * @module types
 */

import type {
    AssistantMessage,
    ImageContent,
    TextContent,
    ToolResultMessage,
    UserMessage,
} from '@earendil-works/pi-ai';
import type { GhostBlock } from './contextManagement/interfaces';

/**
 * Explicit model + provider pair. Used throughout settings, configuration,
 * persistence, and execution to avoid ambiguous first-match resolution.
 * @interface ModelSelection
 */
export interface ModelSelection {
    /** Model identifier */
    model: string;
    /** Provider name that serves the model */
    provider: string;
}

/**
 * Built-in default model selection pair.
 */
export const DEFAULT_MODEL_SELECTION: ModelSelection = {
    model: "kimi-for-coding",
    provider: "kimi-coding"
};

/**
 * Metadata for an agent session stored in notebook metadata.
 * @interface AgentMetadata
 */
export interface McpToolSelection {
    serverId: string;
    toolNames: string[];
}

export interface AgentMetadata {
    /** Unique identifier for the agent */
    uuid: string;
    /** Display name of the agent */
    name: string;
    /** ISO timestamp when the agent was created */
    created_at: string;
    /** Parent agent ID if this is a sub-agent, null otherwise */
    parent_agent_id: string | null;
    /** List of URIs the agent is allowed to access */
    allowed_uris: string[];
    /** Whether the agent task has been completed */
    is_task_finished?: boolean;
    /** Model identifier used for this agent */
    model?: string;
    /** Provider name that serves the model (disambiguates when the same model appears under multiple providers) */
    provider?: string;
    /** Concrete reasoning effort override; 'default' or unset is represented by the key being absent */
    reasoning_effort?: string;
    /** Persisted context items (Files, Rules) valid for the whole session */
    contextItems?: ContextItem[];
    /** List of active rule filenames for this agent */
    activeRules?: string[];
    /** List of active skill filenames for this agent */
    activeSkills?: string[];
    /** Agent type identifier for role-based configuration */
    agentType?: string;
    /** Frozen selection of MCP tools enabled for this session. */
    enabledMcpTools?: McpToolSelection[];
    
    /** List of sub-agent UUIDs created by this agent */
    sub_agents_list?: string[];
}

/**
 * Text content part for multimodal messages.
 * @interface ContentPartText
 */
export type ContentPartText = TextContent;

/**
 * Image content part for multimodal messages.
 * @interface ContentPartImage
 */
export type ContentPartImage = ImageContent;

/**
 * Message content can be plain text or multimodal parts.
 */
export type MessageContent = UserMessage['content'];

/** Mutsumi-only state attached to persisted user messages. */
export interface MutsumiUserMessageState {
    ghostBlock?: GhostBlock;
}

/**
 * Message in an agent conversation.
 * @interface AgentMessage
 */
export type AgentMessage =
    | (UserMessage & { mutsumi?: MutsumiUserMessageState })
    | AssistantMessage
    | ToolResultMessage;

export type PersistedTextContent = {
    type: 'text';
    text: string;
    textSignature?: unknown;
};

export type PersistedImageContent = {
    type: 'image';
    data: string;
    mimeType: string;
};

export type PersistedThinkingContent = {
    type: 'thinking';
    thinking: string;
    thinkingSignature?: unknown;
    redacted?: unknown;
};

export type PersistedToolCall = {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    thoughtSignature?: unknown;
};

/**
 * On-disk messages keep the pi-ai semantic core strict while allowing provider
 * envelope metadata to evolve independently of the .mtm format.
 */
export type PersistedUserMessage = {
    role: 'user';
    content: string | (PersistedTextContent | PersistedImageContent)[];
    timestamp?: unknown;
    mutsumi?: MutsumiUserMessageState;
};

export type PersistedAssistantMessage = {
    role: 'assistant';
    content: (PersistedTextContent | PersistedThinkingContent | PersistedToolCall)[];
    api: string;
    provider: string;
    model: string;
    usage?: unknown;
    cost?: unknown;
    timestamp?: unknown;
    stopReason?: unknown;
    responseId?: unknown;
    responseModel?: unknown;
    errorMessage?: unknown;
    diagnostics?: unknown;
};

export type PersistedToolResultMessage = {
    role: 'toolResult';
    toolCallId: string;
    toolName: string;
    content: (PersistedTextContent | PersistedImageContent)[];
    isError: boolean;
    timestamp?: unknown;
    usage?: unknown;
    details?: unknown;
    addedToolNames?: unknown;
};

export type PersistedAgentMessage =
    | PersistedUserMessage
    | PersistedAssistantMessage
    | PersistedToolResultMessage;

/** A user-authored Markup cell that is persisted but never sent to a model. */
export interface NotebookNote {
    /** Number of user cells that precede this note. */
    beforeUserIndex: number;
    /** Original Markdown source. */
    markdown: string;
}

/** Current, deliberately strict on-disk .mtm format version. */
export const MTM_FORMAT_VERSION = 1 as const;

/**
 * Complete agent context including metadata and conversation history.
 * @interface AgentContext
 */
export interface AgentContext {
    /** Required on-disk format discriminator. Unversioned files are unsupported. */
    formatVersion: typeof MTM_FORMAT_VERSION;
    /** Agent metadata */
    metadata: AgentMetadata;
    /** Conversation message history */
    context: PersistedAgentMessage[];
    /** User-authored Markup cells, anchored between user cells. */
    notes?: NotebookNote[];
}

/**
 * Tool request from the agent.
 * @interface ToolRequest
 */
export interface ToolRequest {
    /** Name of the tool to execute */
    name: string;
    /** Arguments for the tool */
    arguments: any;
}

/**
 * Result of a tool execution.
 * @interface ToolResult
 */
export interface ToolResult {
    /** Result content as string */
    content: string;
    /** Whether the tool execution resulted in an error */
    isError?: boolean;
}

/**
 * Runtime status of an agent.
 * - 'standby': Main agent, not running
 * - 'running': Currently executing
 * - 'pending': Sub-agent, waiting to run
 * - 'finished': Task completed
 */
export type AgentRuntimeStatus = 'standby' | 'running' | 'pending' | 'finished';

/**
 * Runtime state information for an agent.
 * @interface AgentStateInfo
 */
export interface AgentStateInfo {
    /** Unique identifier for the agent */
    uuid: string;
    /** Parent agent ID if this is a sub-agent */
    parentId: string | null;
    /** Display name of the agent */
    name: string;
    /** File URI string where the agent is stored */
    fileUri: string;
    
    /** Whether the notebook window is currently open */
    isWindowOpen: boolean;
    /** Whether the agent is currently running */
    isRunning: boolean;
    /** Whether the agent task has finished */
    isTaskFinished: boolean;
    
    /** Cached prompt text for the agent */
    prompt?: string;
    
    /** Set of child agent UUIDs for building the tree structure */
    childIds?: Set<string>;
}

/**
 * Context item representing a referenced resource (file, tool result, or rule).
 * Stored in cell metadata for persistence, not in message content.
 * @interface ContextItem
 */
export interface ContextItem {
    /** Type of context item */
    type: 'file' | 'tool' | 'rule' | 'macro';
    /** Key identifier (file path, tool name, or rule name) */
    key: string;
    /** Content or execution result */
    content: string;
    /** Additional metadata (e.g., tool arguments) */
    metadata?: any;
    /** Content hash for change detection (SHA-256) */
    lastHash?: string;
    /** Version number for file history tracking (starts at 1) */
    version?: number;
}
