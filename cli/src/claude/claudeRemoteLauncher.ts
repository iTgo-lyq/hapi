import React from "react";
import { ClaudeExecution } from './execution';
import { InterruptExecutionRequestSchema, RPC_METHODS, type InterruptExecutionResponse } from '@hapi/protocol';
import { Session } from "./session";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { PLAN_FAKE_REJECT } from "./sdk/prompts";
import { EnhancedMode } from "./loop";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import type { ClaudePermissionMode } from "@hapi/protocol/types";
import { applySessionTitleFallback } from './utils/sessionTitleFallback';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from "@/modules/common/remote/RemoteLauncherBase";

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: ClaudePermissionMode;
    allowedTools?: string[];
}

function getRespawnBackoffMs(): number {
    const raw = process.env.CLAUDE_REMOTE_RESPAWN_BACKOFF_MS;
    if (raw === undefined) return 1000;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) return 1000;
    return parsed;
}

class ClaudeRemoteLauncher extends RemoteLauncherBase {
    private readonly session: Session;
    private readonly execution: ClaudeExecution;
    private abortController: AbortController | null = null;
    private abortFuture: Future<void> | null = null;
    private permissionHandler: PermissionHandler | null = null;
    private handleSessionFound: ((sessionId: string) => void) | null = null;

    constructor(session: Session) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.execution = new ClaudeExecution((event, id) => session.client.sendSessionEvent(event, id));
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, context);
    }

    private async abort(): Promise<void> {
        if (this.abortController && !this.abortController.signal.aborted) {
            this.abortController.abort();
        }
        await this.abortFuture?.promise;
    }

    // Waits for `ms`, but resolves early if `signal` aborts -- mirrors
    // cursorLegacyRemoteLauncher.transientBackoff (single completion path so
    // the abort listener is always removed, whether the timer or the abort
    // wins) so a user-initiated switch/exit during the respawn backoff isn't
    // stuck waiting out the full delay.
    private async respawnBackoff(ms: number, signal: AbortSignal): Promise<void> {
        if (ms <= 0 || signal.aborted) return;
        await new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const finish = () => {
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
                signal.removeEventListener('abort', finish);
                resolve();
            };
            timer = setTimeout(finish, ms);
            signal.addEventListener('abort', finish, { once: true });
        });
    }

    private async handleAbortRequest(): Promise<void> {
        logger.debug('[remote]: doAbort');
        await this.abort();
    }

    private async handleSwitchRequest(): Promise<void> {
        logger.debug('[remote]: doSwitch');
        await this.requestExit('switch', async () => {
            await this.abort();
        });
    }

    private async handleExitFromUi(): Promise<void> {
        logger.debug('[remote]: Exiting client via Ctrl-C');
        await this.requestExit('exit', async () => {
            await this.abort();
        });
    }

    private async handleSwitchFromUi(): Promise<void> {
        logger.debug('[remote]: Switching to local mode via double space');
        await this.handleSwitchRequest();
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected async runMainLoop(): Promise<void> {
        logger.debug('[claudeRemoteLauncher] Starting remote launcher');
        logger.debug(`[claudeRemoteLauncher] TTY available: ${this.hasTTY}`);

        const session = this.session;
        const messageBuffer = this.messageBuffer;

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbortRequest(),
            onSwitch: () => this.handleSwitchRequest()
        });

        session.client.updateMetadata(metadata => ({ ...metadata, capabilities: { ...metadata.capabilities, execution: 1 } }));
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.InterruptExecution, async (raw): Promise<InterruptExecutionResponse> => {
            const target = InterruptExecutionRequestSchema.parse(raw);
            const current = this.execution.current;
            if (!current) return { status: 'not_running', executionId: target.executionId, inputLocalIds: [] };
            const result = { executionId: current.id, inputLocalIds: current.inputLocalIds };
            if (target.executionId !== current.id || !current.inputLocalIds.includes(target.inputLocalId)) {
                return { status: 'target_mismatch', ...result };
            }
            // Capture this controller/future before yielding; a late call cannot abort the next SDK process.
            const controller = this.abortController;
            const done = this.abortFuture;
            if (!controller || controller.signal.aborted) return { status: 'not_running', ...result };
            controller.abort();
            await done?.promise;
            return { status: 'requested', ...result };
        });

        const permissionHandler = new PermissionHandler(session);
        this.permissionHandler = permissionHandler;

        const messageQueue = new OutgoingMessageQueue(
            (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
        );

        permissionHandler.setOnPermissionRequest((toolCallId: string) => {
            messageQueue.releaseToolCall(toolCallId);
        });

        const sdkToLogConverter = new SDKToLogConverter({
            sessionId: session.sessionId || 'unknown',
            cwd: session.path,
            version: process.env.npm_package_version,
            selectedModel: session.getModel()
        }, permissionHandler.getResponses());

        const handleSessionFound = (sessionId: string) => {
            sdkToLogConverter.updateSessionId(sessionId);
        };
        this.handleSessionFound = handleSessionFound;
        session.addSessionFoundCallback(handleSessionFound);

        let planModeToolCalls = new Set<string>();
        let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();

        const execution = this.execution;
        function onMessage(message: SDKMessage) {
            execution.observe(message);
            formatClaudeMessageForInk(message, messageBuffer);
            permissionHandler.onMessage(message);

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use' && (c.name === 'exit_plan_mode' || c.name === 'ExitPlanMode')) {
                            logger.debug('[remote]: detected plan mode tool call ' + c.id!);
                            planModeToolCalls.add(c.id! as string);
                        }
                    }
                }
            }

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use') {
                            logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                            ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                        }
                    }
                }
            }
            if (message.type === 'user') {
                let umessage = message as SDKUserMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id) {
                            ongoingToolCalls.delete(c.tool_use_id);
                            messageQueue.releaseToolCall(c.tool_use_id);
                        }
                    }
                }
            }

            let msg = message;

            if (message.type === 'user') {
                let umessage = message as SDKUserMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    msg = {
                        ...umessage,
                        message: {
                            ...umessage.message,
                            content: umessage.message.content.map((c) => {
                                if (c.type === 'tool_result' && c.tool_use_id && planModeToolCalls.has(c.tool_use_id!)) {
                                    if (c.content === PLAN_FAKE_REJECT) {
                                        logger.debug('[remote]: hack plan mode exit');
                                        logger.debugLargeJson('[remote]: hack plan mode exit', c);
                                        return {
                                            ...c,
                                            is_error: false,
                                            content: 'Plan approved',
                                            mode: c.mode
                                        };
                                    } else {
                                        return c;
                                    }
                                }
                                return c;
                            })
                        }
                    };
                }
            }

            const logMessage = sdkToLogConverter.convert(msg);
            if (logMessage) {
                if (logMessage.type === 'user' && logMessage.message?.content) {
                    const content = Array.isArray(logMessage.message.content)
                        ? logMessage.message.content
                        : [];

                    for (let i = 0; i < content.length; i++) {
                        const c = content[i];
                        if (c.type === 'tool_result' && c.tool_use_id) {
                            const responses = permissionHandler.getResponses();
                            const response = responses.get(c.tool_use_id);

                            if (response) {
                                const permissions: PermissionsField = {
                                    date: response.receivedAt || Date.now(),
                                    result: response.approved ? 'approved' : 'denied'
                                };

                                if (response.mode) {
                                    permissions.mode = response.mode;
                                }

                                if (response.allowTools && response.allowTools.length > 0) {
                                    permissions.allowedTools = response.allowTools;
                                }

                                content[i] = {
                                    ...c,
                                    permissions
                                };
                            }
                        }
                    }
                }

                if (logMessage.type === 'assistant' && message.type === 'assistant') {
                    const assistantMsg = message as SDKAssistantMessage;
                    const toolCallIds: string[] = [];

                    if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                        for (const block of assistantMsg.message.content) {
                            if (block.type === 'tool_use' && block.id) {
                                toolCallIds.push(block.id);
                            }
                        }
                    }

                    if (toolCallIds.length > 0) {
                        const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                        if (!isSidechain) {
                            messageQueue.enqueue(logMessage, {
                                delay: 250,
                                toolCallIds
                            });
                            return;
                        }
                    }
                }

                messageQueue.enqueue(logMessage);
            }

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                            const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                            if (logMessage2) {
                                messageQueue.enqueue(logMessage2);
                            }
                        }
                    }
                }
            }
        }

        try {
            let pending: {
                message: string;
                mode: EnhancedMode;
                isolate: boolean;
                hash: string;
                items: Array<{ message: string; localId?: string }>;
            } | null = null;

            let previousSessionId: string | null = null;
            while (!this.exitReason) {
                logger.debug('[remote]: launch');
                messageBuffer.addMessage('═'.repeat(40), 'status');

                const isNewSession = session.sessionId !== previousSessionId;
                if (isNewSession) {
                    messageBuffer.addMessage('Starting new Claude session...', 'status');
                    permissionHandler.reset();
                    sdkToLogConverter.resetParentChain();
                    logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
                } else {
                    messageBuffer.addMessage('Continuing Claude session...', 'status');
                    logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
                }

                previousSessionId = session.sessionId;
                const controller = new AbortController();
                this.abortController = controller;
                this.abortFuture = new Future<void>();
                let modeHash: string | null = null;
                let mode: EnhancedMode | null = null;
                // A dequeued SDK batch can already have side effects. Never restore
                // it merely because the stream ended without a result.
                type InFlightMessage = {
                    items: Array<{ message: string; localId?: string }>;
                    mode: EnhancedMode;
                    isolate: boolean;
                    deliveredText: string;
                };
                // The `as InFlightMessage | null` (rather than plain `= null`)
                // is required, not decorative: the only assignments of a
                // non-null value happen inside the nextMessage()/onReady()
                // closures below, which TS's control-flow narrowing does not
                // see from this function body. Without the cast, TS narrows
                // this declaration to the `null` literal type, and the
                // `if (inFlightMessage)` checks further down then fail
                // typecheck with "Property 'isolate' does not exist on type
                // 'never'" (verified against `bun run typecheck`).
                let inFlightMessage: InFlightMessage | null = null as InFlightMessage | null;
                try {
                    const completion = await claudeRemote({
                        sessionId: session.sessionId,
                        path: session.path,
                        allowedTools: session.allowedTools ?? [],
                        mcpServers: session.mcpServers,
                        hookSettingsPath: session.hookSettingsPath,
                        canCallTool: permissionHandler.handleToolCall,
                        bootstrapMode: {
                            permissionMode: session.getPermissionMode() ?? 'default',
                            model: session.getModel() ?? undefined,
                            effort: session.getEffort() ?? undefined,
                        },
                        isAborted: (toolCallId: string) => {
                            return permissionHandler.isAborted(toolCallId);
                        },
                        nextMessage: async () => {
                            // Flush any pending outgoing messages before consuming the next user
                            // turn. Without this, scheduleProcessing()'s setTimeout(fn,0) fires
                            // after the microtask that sends messages-consumed, causing the hub
                            // to stamp invokedAt on the next user message before it stores the
                            // current turn's queued agent messages — making them sort permanently
                            // below the next user message.
                            // The result summary is enqueued by onMessage immediately before onReady.
                            // Drain it before ready so live clients receive the round metadata before
                            // they close out the running turn.
                            await messageQueue.flush();

                            if (pending) {
                                let p = pending;
                                pending = null;
                                // Seed the mode gate from the parked batch. Without this,
                                // an attempt that starts from `pending` keeps modeHash=null,
                                // so the next mode switch fails the hash check and its
                                // messages are fed into a process spawned with the old
                                // --permission-mode (e.g. auto silently running as default).
                                modeHash = p.hash;
                                mode = p.mode;
                                permissionHandler.handleModeChange(p.mode.permissionMode);
                                // Re-resolve the selected-model seed hint for every turn, not
                                // just the first: a single claudeRemote() call keeps accepting
                                // new turns (potentially with a different model, e.g. after a
                                // mid-session model switch), so a construction-time snapshot
                                // would go stale. See SDKToLogConverter.updateSelectedModel.
                                sdkToLogConverter.updateSelectedModel(p.mode.model ?? null);
                                const deliveredText = session.expandSkillReference(p.message)
                                inFlightMessage = { items: p.items, mode: p.mode, isolate: p.isolate, deliveredText };
                                session.client.notePendingHubPromptEcho(
                                    deliveredText,
                                    p.items.flatMap((item) => item.localId ? [item.localId] : [])
                                )
                                const uuid = this.execution.begin(p.items.flatMap(item => item.localId ? [item.localId] : []), session.sessionId ?? undefined);
                                return { ...p, message: deliveredText, uuid };
                            }

                            let msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);

                            if (msg) {
                                if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                    // Parked into `pending`, not handed to the
                                    // SDK -- deliberately NOT tracked as
                                    // inFlightMessage. `pending` is declared
                                    // outside the while loop and is only ever
                                    // cleared when actually consumed (the
                                    // `if (pending)` branch above), so it
                                    // already survives a throw in this or any
                                    // later attempt without help from the
                                    // restore-on-catch logic below. Tracking
                                    // it here too would restore a second copy
                                    // via queue.unshift() on top of the one
                                    // still safely held in `pending`,
                                    // delivering it twice.
                                    logger.debug('[remote]: mode has changed, pending message');
                                    pending = msg;
                                    return null;
                                }
                                modeHash = msg.hash;
                                mode = msg.mode;
                                permissionHandler.handleModeChange(mode.permissionMode);
                                sdkToLogConverter.updateSelectedModel(mode.model ?? null);
                                const deliveredText = session.expandSkillReference(msg.message)
                                inFlightMessage = { items: msg.items, mode: msg.mode, isolate: msg.isolate, deliveredText };
                                session.client.notePendingHubPromptEcho(
                                    deliveredText,
                                    msg.items.flatMap((item) => item.localId ? [item.localId] : [])
                                )
                                return {
                                    message: deliveredText,
                                    mode: msg.mode,
                                    uuid: this.execution.begin(msg.items.flatMap(item => item.localId ? [item.localId] : []), session.sessionId ?? undefined)
                                };
                            }

                            return null;
                        },
                        onSessionFound: (sessionId) => {
                            session.onSessionFound(sessionId);
                            // The one-time --resume flag must only be dropped once we know
                            // Claude actually captured a session id from it. If claudeRemote()
                            // bails out before this fires (e.g. the initial nextMessage() came
                            // back null because a relaunch trigger arrived before any turn was
                            // ever processed), the flag stays in session.claudeArgs so the next
                            // launch attempt can still resume the original session.
                            session.consumeOneTimeFlags();
                        },
                        onThinkingChange: session.onThinkingChange,
                        claudeEnvVars: session.claudeEnvVars,
                        claudeArgs: session.claudeArgs,
                        onMessage,
                        onFirstResult: (initialMessage) => {
                            applySessionTitleFallback(session.client, initialMessage);
                        },
                        onCompletionEvent: (message: string) => {
                            logger.debug(`[remote]: Completion event: ${message}`);
                            session.client.sendSessionEvent({ type: 'message', message });
                        },
                        onSessionReset: () => {
                            logger.debug('[remote]: Session reset');
                            session.clearSessionId();
                            // /clear discards the resume anchor along with the
                            // context. Without this, the flag would outlive the
                            // reset (claudeRemote() returns before spawning
                            // Claude, so onSessionFound never fires) and the
                            // next launch would resume the session the user
                            // just asked to clear.
                            session.consumeOneTimeFlags();
                        },
                        onReady: async (completionEvent?: string) => {
                            // claudeRemote gates ready on this batch's native UUID.
                            inFlightMessage = null;

                            await messageQueue.flush();

                            if (completionEvent) {
                                logger.debug(`[remote]: Completion event: ${completionEvent}`);
                                session.client.sendSessionEvent({ type: 'message', message: completionEvent });
                            }

                            logger.debug(
                                `[claudeRemoteLauncher][async-debug] onReady callback ` +
                                `(hasPending=${Boolean(pending)}, queueSize=${session.queue.size()})`
                            );
                            if (!pending && session.queue.size() === 0) {
                                session.client.sendSessionEvent({ type: 'ready' });
                                logger.debug('[claudeRemoteLauncher][async-debug] ready event sent to hub');
                            } else {
                                logger.debug('[claudeRemoteLauncher][async-debug] ready event suppressed (pending input exists)');
                            }
                        },
                        signal: controller.signal,
                    });

                    if (completion === 'controlled-stop') this.execution.end('interrupted', 'control', { reason: 'tool_control_stopped' });
                    if (!this.exitReason && controller.signal.aborted) {
                        session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    }

                } catch (e) {
                    logger.debug('[remote]: launch error', e);
                    const detail = e instanceof Error ? e.message : String(e);
                    this.execution.end('unknown', 'transport', { error: detail });
                    if (!this.exitReason && !controller.signal.aborted) {
                        session.client.sendSessionEvent({ type: 'error', message: `Process exited unexpectedly: ${detail}. Input was not automatically resent; inspect the result before retrying.` });
                        await this.respawnBackoff(getRespawnBackoffMs(), controller.signal);
                    }
                } finally {
                    logger.debug('[remote]: launch finally');
                    this.execution.end(controller.signal.aborted ? 'interrupted' : 'unknown',
                        controller.signal.aborted ? 'control' : 'transport',
                        { reason: controller.signal.aborted ? 'native_process_aborted' : 'native_stream_ended_without_result' });
                    for (const item of inFlightMessage?.items ?? []) {
                        if (item.localId) session.client.discardPendingHubPromptEcho(item.localId);
                    }
                    if (inFlightMessage?.deliveredText) session.client.discardPendingHubPromptEchoText(inFlightMessage.deliveredText);


                    for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                        const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                        if (converted) {
                            logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                            session.client.sendClaudeSessionMessage(converted);
                        }
                    }
                    ongoingToolCalls.clear();

                    logger.debug('[remote]: flushing message queue');
                    await messageQueue.flush();
                    messageQueue.destroy();
                    logger.debug('[remote]: message queue flushed');

                    this.abortController = null;
                    this.abortFuture?.resolve(undefined);
                    this.abortFuture = null;
                    logger.debug('[remote]: launch done');
                    permissionHandler.reset();
                    modeHash = null;
                    mode = null;
                }
            }
        } finally {
            if (this.permissionHandler) {
                this.permissionHandler.reset();
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.InterruptExecution, async (raw): Promise<InterruptExecutionResponse> => {
            const target = InterruptExecutionRequestSchema.parse(raw);
            return { status: 'not_running', executionId: target.executionId, inputLocalIds: [] };
        });

        if (this.handleSessionFound) {
            this.session.removeSessionFoundCallback(this.handleSessionFound);
            this.handleSessionFound = null;
        }

        if (this.permissionHandler) {
            this.permissionHandler.reset();
        }

        if (this.abortFuture) {
            this.abortFuture.resolve(undefined);
        }
    }
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    const launcher = new ClaudeRemoteLauncher(session);
    return launcher.launch();
}
