import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectPath } from '@/claude/utils/path';
import { CodexAppServerClient, CodexRpcError } from '@/codex/codexAppServerClient';
import { initializeSharedClient, resolveSharedCodex } from '@/codex/shared/launch';

export class NativeSessionMissingError extends Error {}

/** No prompt or model call. Only the native store can establish confirmed absence. */
export async function checkNativeResume(agent: string, sessionId: string, directory: string): Promise<void> {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
        throw new Error('Native resume requires a valid session UUID');
    }
    if (agent === 'claude') {
        try {
            const file = await stat(join(getProjectPath(directory), `${sessionId}.jsonl`));
            if (!file.isFile()) throw new Error('Claude transcript path is not a file');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new NativeSessionMissingError(`Claude native session ${sessionId} is missing in this workspace`);
            }
            throw error;
        }
    } else if (agent === 'codex') {
        const client = new CodexAppServerClient({ cwd: directory, command: resolveSharedCodex() });
        try {
            await initializeSharedClient(client);
            try {
                await client.readThread({ threadId: sessionId, includeTurns: false });
            } catch (error) {
                if (!(error instanceof CodexRpcError) || error.code !== -32600
                    || error.message !== `thread not loaded: ${sessionId}`) throw error;
                // Not loaded is not not found. Ask the native store to resolve it.
                try {
                    await client.resumeThread({ threadId: sessionId });
                } catch (resumeError) {
                    if (resumeError instanceof CodexRpcError && resumeError.code === -32600
                        && resumeError.message === `no rollout found for thread id ${sessionId}`) {
                        throw new NativeSessionMissingError(`Codex native session ${sessionId} is missing`);
                    }
                    throw resumeError;
                }
            }
        } finally {
            await client.disconnect();
        }
    }
}
