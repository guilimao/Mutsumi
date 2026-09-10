/**
 * @fileoverview Agent runner for executing LLM interactions and tool calls.
 * @module agent/agentRunner
 */

import * as vscode from 'vscode';
import { ToolSet } from '../tools.d/toolManager';
import { AgentMessage } from '../types';
import { UIRenderer } from './uiRenderer';
import { MUTSUMI_AGENT_CHAT_MIME, RenderBlock, toBlockUsage } from '../notebook/renderTypes';
import { LLMStreamHandler } from './llmStream';
import { ToolExecutor, type ToolExecutionResult } from './toolExecutor';
import { TitleGenerator } from './titleGenerator';
import { LLMClient } from './llmClient';
import { IAgentSession, AgentSessionConfig } from '../adapters/interfaces';
import { LiteAgentSession } from '../adapters/liteAdapter';
import { debugLogger } from '../debugLogger';
import { getTitleModelSelection } from '../utils';
import { AgentRunContext, AgentRunOptions, AgentRunResult } from './types';
import type { ToolCall } from '@earendil-works/pi-ai';
import { assistantTextBlocks } from '../llm/messageText';
import { t } from '../i18n';

export { AgentRunOptions } from './types';

/**
 * Executes the main agent loop for LLM interactions.
 * @description Manages the conversation flow with the LLM, handling streaming responses,
 * tool calls, and UI updates. Implements the core agent execution logic.
 * @class AgentRunner
 * @example
 * const runner = new AgentRunner(options, toolSet, session);
 * const result = await runner.run(abortController, initialContext);
 */
export class AgentRunner {
    /** Maximum number of tool interaction loops */
    private maxLoops: number;
    /** UI renderer for notebook output */
    private uiRenderer: UIRenderer;
    /** LLM streaming handler */
    private llmStreamHandler: LLMStreamHandler;
    /** Tool executor for handling tool calls */
    private toolExecutor: ToolExecutor | undefined;
    /** Title generator for notebook titles */
    private titleGenerator: TitleGenerator;
    /** LLM client for API communication */
    private llmClient: LLMClient;
    /** Agent session for UI interactions */
    private session: IAgentSession;
    /** Tool set for this agent instance */
    private toolSet: ToolSet;

    /**
     * Creates a new AgentRunner instance.
     * @constructor
     * @param {AgentRunOptions} options - Configuration options
     * @param {ToolSet} toolSet - Tool set for this agent instance
     * @param {IAgentSession} session - The agent session
     */
    constructor(
        options: AgentRunOptions,
        toolSet: ToolSet,
        session: IAgentSession
    ) {
        this.session = session;
        this.toolSet = toolSet;
        this.maxLoops = options.maxLoops || 30;
        this.llmClient = new LLMClient({
            provider: options.provider,
            model: options.model,
            reasoningEffort: options.reasoningEffort
        });
        this.uiRenderer = new UIRenderer();
        this.llmStreamHandler = new LLMStreamHandler(this.llmClient);
        // ToolExecutor will be initialized in run() after we can await getConfig()
        this.titleGenerator = new TitleGenerator();
    }

    /**
     * Executes the main agent loop.
     * @description Runs the conversation loop with the LLM, handling streaming,
     * tool calls, and termination conditions.
     * @param {AbortController} abortController - Controller for cancellation
     * @param {AgentRunContext} initialContext - Provider-ready prompt and message history
     * @returns {Promise<AgentRunResult>} Explicit status plus native messages safe to persist
     * @example
     * const result = await runner.run(abortController, context);
     */
    async run(
        abortController: AbortController,
        initialContext: AgentRunContext
    ): Promise<AgentRunResult> {
        // Get config from session at the start of run
        const config = await this.session.getConfig();
        const allowedUris = config.allowedUris || [];
        const isSubAgent = config.isSubAgent || false;

        // Initialize ToolExecutor here since we needed async config
        if (!this.toolExecutor) {
            this.toolExecutor = new ToolExecutor(
                this.toolSet,
                allowedUris,
                this.session,
                isSubAgent,
                this.uiRenderer
            );
        }

        const messages = [...initialContext.messages];
        const newMessages: AgentMessage[] = [];
        let loopCount = 0;
        let status: AgentRunResult['status'] = 'completed';
        let failure: AgentRunResult['error'];

        while (loopCount < this.maxLoops) {
            if (this.session.token.isCancellationRequested) {
                status = 'cancelled';
                break;
            }
            loopCount++;

            let assistantMessage: Extract<AgentMessage, { role: 'assistant' }>;

            try {
                const result = await this.llmStreamHandler.streamResponse(
                    initialContext.systemPrompt,
                    messages,
                    this.toolSet.getDefinitions(),
                    abortController.signal,
                    async (contentBlocks, reasoning, partialToolCalls) => {
                        if (this.session.token.isCancellationRequested) {
                            return;
                        }

                        const pendingTools = this.uiRenderer.formatPendingToolCalls(
                            partialToolCalls,
                            this.toolSet,
                            isSubAgent
                        );

                        const renderData = this.uiRenderer.updateActive(contentBlocks, reasoning, pendingTools);
                        await this.session.replaceOutput(JSON.stringify(renderData), { mimeType: MUTSUMI_AGENT_CHAT_MIME });
                    }
                );
                assistantMessage = result.message;
            } catch (error: any) {
                // Handle network/API errors gracefully
                const isCancellation = 
                    error.name === 'APIUserAbortError' ||
                    error.name === 'AbortError' ||
                    abortController.signal.aborted;

                if (isCancellation) {
                    status = 'cancelled';
                    break;
                }

                // Network/API error - show notification and preserve history
                const errorMessage = error.message || String(error);
                status = 'failed';
                failure = {
                    code: typeof error.code === 'string' && error.code ? error.code : 'LLM_STREAM_ERROR',
                    message: errorMessage,
                };
                console.error('LLM Stream Error:', error);
                
                // Show error as VSCode notification (non-modal)
                const copyDetailsBtn = t('controller.copyDetails');
                vscode.window.showErrorMessage(
                    t('agentRunner.llmError', errorMessage),
                    copyDetailsBtn
                ).then(selection => {
                    if (selection === copyDetailsBtn) {
                        vscode.env.clipboard.writeText(error.stack || errorMessage);
                    }
                });

                const errorMarkdown = `\n\n> ⚠️ **Error**: ${errorMessage.replace(/\n/g, ' ')}\n\n*Execution stopped due to network error. Previous output is preserved above.*`;
                this.uiRenderer.appendBlock({ type: 'content', markdown: errorMarkdown });
                try {
                    await this.session.replaceOutput(JSON.stringify(this.uiRenderer.getCommittedRenderData()), { mimeType: MUTSUMI_AGENT_CHAT_MIME });
                } catch (renderError) {
                    console.error('Failed to render LLM error state:', renderError);
                }

                break;
            }

            const thinkingBlocks = assistantMessage.content.filter(block => block.type === 'thinking');
            const toolCalls = assistantMessage.content.filter((block): block is ToolCall => block.type === 'toolCall');
            const roundContentBlocks = assistantTextBlocks(assistantMessage);
            const roundContent = roundContentBlocks.join('');
            const roundReasoning = thinkingBlocks.map(block => block.thinking).join('');

            const roundMessageStart = messages.length;
            const newRoundStart = newMessages.length;
            messages.push(assistantMessage);
            newMessages.push(assistantMessage);

            if (!toolCalls.length && !roundContent && !roundReasoning) {
                this.uiRenderer.appendBlock({ type: 'content', markdown: '_Mutsumi Debug: No content, reasoning, or tool calls received from API._' });
                this.uiRenderer.appendUsage(toBlockUsage(assistantMessage.usage));
                await this.session.replaceOutput(JSON.stringify(this.uiRenderer.getCommittedRenderData()), { mimeType: MUTSUMI_AGENT_CHAT_MIME });
                break;
            }

            if (toolCalls.length === 0) {
                this.uiRenderer.commitRoundUI(roundContentBlocks, roundReasoning, toBlockUsage(assistantMessage.usage));
                await this.session.replaceOutput(JSON.stringify(this.uiRenderer.getCommittedRenderData()), { mimeType: MUTSUMI_AGENT_CHAT_MIME });
                break;
            }

            this.uiRenderer.commitRoundUI(roundContentBlocks, roundReasoning, toBlockUsage(assistantMessage.usage));

            let result: ToolExecutionResult;
            try {
                result = await this.toolExecutor.executeTools(
                    toolCalls,
                    abortController.signal,
                    {
                        appendOutput: async (block: RenderBlock) => {
                            this.uiRenderer.appendBlock(block);
                            await this.session.replaceOutput(JSON.stringify(this.uiRenderer.getCommittedRenderData()), { mimeType: MUTSUMI_AGENT_CHAT_MIME });
                        },
                        signalTermination: () => {
                            // Termination handled via return values
                        }
                    }
                );
            } catch (error: any) {
                // An incomplete tool round cannot be replayed safely.
                messages.splice(roundMessageStart);
                newMessages.splice(newRoundStart);
                if (abortController.signal.aborted || this.session.token.isCancellationRequested
                    || error?.name === 'AbortError' || error?.name === 'APIUserAbortError') {
                    status = 'cancelled';
                } else {
                    status = 'failed';
                    failure = {
                        code: typeof error?.code === 'string' && error.code ? error.code : 'TOOL_EXECUTION_ERROR',
                        message: error?.message || String(error),
                    };
                    console.error('Tool execution infrastructure error:', error);
                }
                break;
            }
            const toolMessages = result.messages;
            messages.push(...toolMessages);
            newMessages.push(...toolMessages);

            if (abortController.signal.aborted || this.session.token.isCancellationRequested) {
                // A cancelled tool round is not a replayable conversation turn.
                messages.splice(roundMessageStart);
                newMessages.splice(newRoundStart);
                status = 'cancelled';
                break;
            }

            // Handle task completion (e.g., from task_finish tool)
            if (result.isTaskComplete) {
                await this.markSessionAsFinished();
                break;
            }

            // Handle other termination cases (e.g., edit rejection)
            if (result.shouldTerminate) {
                status = 'failed';
                failure = {
                    code: 'TOOL_TERMINATED',
                    message: 'A tool terminated the agent run before task completion',
                };
                break;
            }

            if (loopCount >= this.maxLoops) {
                status = 'failed';
                failure = {
                    code: 'MAX_LOOPS_EXCEEDED',
                    message: `Agent reached the maximum of ${this.maxLoops} tool interaction loops`,
                };
                break;
            }
        }

        // Generate title after first user message (only once)
        // Skip for LiteAgentSession which is used for background tasks like title generation
        const userMessageCount = messages.filter(m => m.role === 'user').length;
        if (status === 'completed' && userMessageCount === 1 && !(this.session instanceof LiteAgentSession)) {
            void this.generateTitleIfNeeded(this.session, messages, config);
        }

        return {
            messages: newMessages,
            status,
            ...(failure ? { error: failure } : {}),
        };
    }

    /**
     * Generates a title for the session after first user message.
     * @private
     * @param {IAgentSession} session - The agent session
     * @param {AgentMessage[]} allMessages - Complete message history
     * @param {AgentSessionConfig} sessionConfig - Session configuration
     * @returns {Promise<void>}
     */
    private async generateTitleIfNeeded(
        session: IAgentSession,
        allMessages: AgentMessage[],
        sessionConfig: AgentSessionConfig
    ): Promise<void> {
        // Title model priority: settings titleGeneratorModel > session metadata pair
        let titleSelection = getTitleModelSelection();
        if (!titleSelection && sessionConfig.metadata?.model && sessionConfig.metadata?.provider) {
            titleSelection = { model: sessionConfig.metadata.model, provider: sessionConfig.metadata.provider };
        }

        if (!titleSelection) {
            debugLogger.log('[AgentRunner] Title generation skipped: no titleGeneratorModel setting or session metadata pair');
            return;
        }

        debugLogger.log(`[AgentRunner] Generating title for session (first user message received)`);

        const notebook = session.supportsUI && 'execution' in session
            ? (session as any).execution?.cell?.notebook
            : undefined;

        await this.titleGenerator.generateTitleForSession(session, allMessages, {
            modelSelection: titleSelection
        }, notebook);
    }

    /**
     * Marks the session as finished.
     * @private
     * @returns {Promise<void>}
     */
    private async markSessionAsFinished(): Promise<void> {
        // Persist the finished state via the session
        // The session adapter will handle the actual persistence (e.g., notebook metadata, file, etc.)
        const config = await this.session.getConfig();
        if (config.metadata) {
            // Use setConfig to safely update metadata, avoiding read-only object issues
            this.session.setConfig({
                metadata: { ...config.metadata, is_task_finished: true }
            });
        }
        await this.session.save();
    }
}
