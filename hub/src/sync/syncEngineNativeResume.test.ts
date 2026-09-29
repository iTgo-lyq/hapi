import { expect, test } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

test('confirmed native absence survives the machine boundary and preserves archive state', async () => {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const internals = engine as any
    internals.machineCache.getOnlineMachinesByNamespace = () => [{ id: 'machine', metadata: { host: 'host' } }]
    internals.rpcGateway.spawnSession = async () => ({ type: 'error', message: 'native history is missing', code: 'native_session_missing', childStarted: false })
    try {
        const session = engine.getOrCreateSession('native-missing', {
            flavor: 'codex', path: '/workspace', host: 'host', machineId: 'machine', codexSessionId: 'native-id',
            lifecycleState: 'archived', lifecycleStateSince: 123, archivedBy: 'hub', archiveReason: 'round completed'
        }, {}, 'default')
        expect(await engine.resumeSession(session.id, 'default')).toMatchObject({ type: 'error', code: 'native_session_missing' })
        expect(engine.getSession(session.id)?.metadata).toMatchObject({ lifecycleState: 'archived', lifecycleStateSince: 123, archiveReason: 'round completed' })
        expect(engine.getSession(session.id)?.active).toBe(false)
    } finally { engine.stop(); store.close() }
})

test('does not reactivate a filtered session on an older runner', async () => {
    const store = new Store(':memory:');
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never);
    const internals = engine as any;
    internals.machineCache.getOnlineMachinesByNamespace = () => [{ id: 'machine', metadata: { host: 'host' } }];
    let spawned = false;
    internals.rpcGateway.spawnSession = async () => { spawned = true; throw new Error('must not dispatch'); };
    try {
        const session = engine.getOrCreateSession('filtered', { flavor: 'codex', path: '/workspace', host: 'host', machineId: 'machine', codexSessionId: 'native-id',
            disabledMcpServers: ['runweft'], lifecycleState: 'archived', archivedBy: 'hub' }, {}, 'default');
        expect(await engine.resumeSession(session.id, 'default')).toMatchObject({ type: 'error', code: 'resume_failed', message: 'MCP tool filtering requires an upgraded runner' });
        expect(spawned).toBe(false);
        expect(engine.getSession(session.id)?.metadata?.lifecycleState).toBe('archived');
    } finally { engine.stop(); store.close(); }
});
