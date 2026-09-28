import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ stat: vi.fn(), read: vi.fn(), resume: vi.fn(), disconnect: vi.fn(), initialize: vi.fn(), construct: vi.fn() }));
vi.mock('node:fs/promises', async () => ({ ...await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'), stat: mocks.stat }));
vi.mock('@/codex/shared/launch', () => ({ initializeSharedClient: mocks.initialize, resolveSharedCodex: () => ({ command: '/native/codex', args: ['native-prefix'] }) }));
vi.mock('@/codex/codexAppServerClient', async () => ({
    ...await vi.importActual<typeof import('@/codex/codexAppServerClient')>('@/codex/codexAppServerClient'),
    CodexAppServerClient: class {
        constructor(options: unknown) { mocks.construct(options); }
        readThread = mocks.read;
        resumeThread = mocks.resume;
        disconnect = mocks.disconnect;
    }
}));
import { CodexRpcError } from '@/codex/codexAppServerClient';
import { checkNativeResume, NativeSessionMissingError } from './nativeResume';
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => { vi.resetAllMocks(); mocks.stat.mockResolvedValue({ isFile: () => true }); });
describe('native resume preflight', () => {
    it('only treats a missing Claude transcript as absence, preserving IO errors', async () => {
        await checkNativeResume('claude', id, '/work');
        mocks.stat.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        await expect(checkNativeResume('claude', id, '/work')).rejects.toBeInstanceOf(NativeSessionMissingError);
        const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
        mocks.stat.mockRejectedValueOnce(denied);
        await expect(checkNativeResume('claude', id, '/work')).rejects.toBe(denied);
        await expect(checkNativeResume('claude', '../invalid', '/work')).rejects.toThrow('valid session UUID');
    });

    it('does not confuse an unloaded Codex thread with a missing rollout', async () => {
        mocks.read.mockRejectedValueOnce(new CodexRpcError(`thread not loaded: ${id}`, -32600));
        mocks.resume.mockResolvedValueOnce({ thread: { id } });
        await checkNativeResume('codex', id, '/work');
        expect(mocks.construct).toHaveBeenCalledWith({ cwd: '/work', command: { command: '/native/codex', args: ['native-prefix'] } });
        expect(mocks.resume).toHaveBeenCalledWith({ threadId: id });
        expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    });

    it('requires the precise native code and target ID before reporting missing', async () => {
        for (const error of [new CodexRpcError(`no rollout found for thread id ${id}`, -32600),
            new CodexRpcError('no rollout found for thread id another', -32600),
            new CodexRpcError(`no rollout found for thread id ${id}`, -32000),
            new Error(`no rollout found for thread id ${id}`)]) {
            mocks.read.mockRejectedValueOnce(new CodexRpcError(`thread not loaded: ${id}`, -32600));
            mocks.resume.mockRejectedValueOnce(error);
            const result = checkNativeResume('codex', id, '/work');
            if (error instanceof CodexRpcError && error.code === -32600 && error.message.endsWith(id)) {
                await expect(result).rejects.toBeInstanceOf(NativeSessionMissingError);
            } else await expect(result).rejects.toBe(error);
        }
        expect(mocks.disconnect).toHaveBeenCalledTimes(4);
    });

    it('keeps other native errors and always closes the query process', async () => {
        const error = new CodexRpcError('authentication required', -32001);
        mocks.read.mockRejectedValueOnce(error);
        await expect(checkNativeResume('codex', id, '/work')).rejects.toBe(error);
        expect(mocks.resume).not.toHaveBeenCalled();
        expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    });
});
