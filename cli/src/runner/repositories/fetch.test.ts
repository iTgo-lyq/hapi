import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ManagedWorkspace, RepositoryFetchRequest, RepositoryOperation, WorkspaceSource } from '@hapi/protocol'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { WorkspaceManager } from '../workspaces/manager'
import { WorkspaceError } from '../workspaces/git'
import { RepositoryManager } from './manager'
import { RepositoryCache } from './cache'

const roots: string[] = [], managers: RepositoryManager[] = [], workspaces: WorkspaceManager[] = []
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
function git(cwd: string, ...args: string[]) { return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function init(path: string, format = 'sha1') {
    mkdirSync(path, { recursive: true }); git(path, 'init', '-q', `--object-format=${format}`)
    git(path, 'config', 'user.name', 'Result Test'); git(path, 'config', 'user.email', 'test@example.invalid'); git(path, 'config', 'commit.gpgsign', 'false')
    return path
}
function commit(path: string) { git(path, 'add', '-A'); git(path, 'commit', '-qm', 'test'); return git(path, 'rev-parse', 'HEAD') }
function machine(home: string, machineId: string, assertStopped = async (_id: string) => {}) {
    const pathPolicy = new MachinePathPolicy(), cache = new RepositoryCache({ home, machineId, scope: 'results-test', pathPolicy })
    const workspace = new WorkspaceManager({ home, machineId, pathPolicy, snapshots: cache, assertStopped })
    const manager = new RepositoryManager({ home, pathPolicy, cache, resolveSource: (...args) => workspace.resolveSource(...args),
        repositoryWorkspaces: dir => workspace.repositoryRecords(dir), withRepositoryLock: (key, action) => workspace.withRepositoryLock(key, action),
        resolveRepository: (cwd, options) => workspace.resolveRepository(cwd, options),
        withSealedResult: (id, round, options, action) => workspace.withSealedResult(id, round, options, action) })
    managers.push(manager); workspaces.push(workspace)
    return { home, manager, workspace }
}
function fixture(format = 'sha1') {
    const parent = resolve(import.meta.dirname, '../../../../../.dev-smoke'); mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(join(parent, 'result-unit-')); roots.push(root)
    const repo = init(join(root, 'source/project'), format); mkdirSync(join(repo, 'app')); writeFileSync(join(repo, 'app/note'), 'baseline'); commit(repo)
    return { root, repo, source: machine(join(root, 'source-home'), 'source'), target: machine(join(root, 'target-home'), 'target') }
}
async function inspect(manager: RepositoryManager, operationId: string) {
    const response = await manager.request({ action: 'inspect', operationId }); if ('error' in response) throw new Error(response.error.message)
    return response.operation
}
async function operation(manager: RepositoryManager, request: RepositoryOperation['request']) {
    await manager.request(request); await manager.settled(); return inspect(manager, request.operationId)
}
async function baseline(f: ReturnType<typeof fixture>) {
    const origin = await f.source.workspace.resolveSource(join(f.repo, 'app'), 'HEAD')
    const exported = await operation(f.source.manager, { action: 'export', operationId: randomUUID(), source: origin })
    expect(exported.status, JSON.stringify(exported.error)).toBe('succeeded')
    renameSync(join(f.root, 'source'), join(f.root, 'source-offline'))
    const imported = await operation(f.target.manager, { action: 'import', operationId: randomUUID(), snapshot: exported.snapshot!,
        files: exported.snapshot!.files.map(file => ({ name: file.name, path: join(exported.directory, file.name) })) })
    expect(imported.status, JSON.stringify(imported.error)).toBe('succeeded')
    return { origin, baseline: exported, source: { ...imported.imported!.source, relativePath: origin.relativePath } }
}
async function prepare(target: ReturnType<typeof machine>, source: WorkspaceSource, previous?: ManagedWorkspace) {
    const environmentId = previous?.environmentId ?? randomUUID(), preparationId = randomUUID(), roundId = randomUUID()
    const expectedHead = previous ? Object.values(previous.results).at(-1)!.resultHead : source.baseCommit
    await target.workspace.request({ action: 'prepare', environmentId, preparationId, roundId, source, expectedHead }); await target.workspace.settled()
    const workspace = await target.workspace.inspect(environmentId)
    expect(workspace.operations[`prepare:${preparationId}`]!.status, JSON.stringify(workspace.operations)).toBe('succeeded')
    return { environmentId, preparationId, roundId, workspace }
}
async function seal(target: ReturnType<typeof machine>, round: Awaited<ReturnType<typeof prepare>>, partial = false, sessionId?: string) {
    const attemptId = randomUUID(); await target.workspace.request({ action: 'finalize', environmentId: round.environmentId,
        preparationId: round.preparationId, roundId: round.roundId, attemptId, partial, ...(sessionId ? { sessionId } : {}) }); await target.workspace.settled()
    const workspace = await target.workspace.inspect(round.environmentId)
    expect(workspace.operations[`finalize:${round.roundId}:${attemptId}`]!.status, JSON.stringify(workspace.operations)).toBe('succeeded')
    return workspace
}
const requestFor = (round: { environmentId: string; roundId: string }) => ({ action: 'export-result' as const,
    operationId: randomUUID(), environmentId: round.environmentId, roundId: round.roundId })
afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.stop()
    for (const workspace of workspaces.splice(0)) await workspace.stop()
    vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function recovery(f: ReturnType<typeof fixture>, input: Awaited<ReturnType<typeof baseline>>, round: Awaited<ReturnType<typeof prepare>>) {
    const workspace = await seal(f.target, round), exported = await operation(f.target.manager, requestFor(round))
    expect(exported.status, JSON.stringify(exported.error)).toBe('succeeded')
    const files = join(f.root, 'published-result'); cpSync(exported.directory, files, { recursive: true })
    await f.target.manager.stop(); await f.target.workspace.stop()
    renameSync(f.target.home, `${f.target.home}-offline`); renameSync(join(f.root, 'source-offline'), join(f.root, 'source'))
    const request: RepositoryFetchRequest = { action: 'fetch-result', operationId: randomUUID(),
        target: { machineId: input.origin.machineId, repositoryId: input.origin.repositoryId, commonDir: input.origin.commonDir,
            objectFormat: input.origin.objectFormat, cwd: f.repo }, result: workspace.results[round.roundId]!,
        baseline: { snapshot: input.baseline.snapshot!, files: input.baseline.snapshot!.files.map(file => ({ name: file.name, path: join(input.baseline.directory, file.name) })) },
        output: { snapshot: exported.snapshot!, files: exported.snapshot!.files.map(file => ({ name: file.name, path: join(files, file.name) })) } }
    return request
}
function protectedState(repo: string) {
    const files = ['.git/config', '.git/index', '.git/FETCH_HEAD', 'app/note', 'untracked']
    return { files: Object.fromEntries(files.filter(file => existsSync(join(repo, file))).map(file => [file, readFileSync(join(repo, file)).toString('base64')])),
        head: git(repo, 'rev-parse', 'HEAD'), refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(line => line && !line.startsWith('refs/hapi/results/')) }
}

it.each(['sha1', 'sha256'])('fetches %s after executor loss without changing parent files/config or running hooks', async format => {
    const f = fixture(format), input = await baseline(f), round = await prepare(f.target, input.source)
    writeFileSync(join(round.workspace.checkout, 'result.txt'), 'offline recovered code')
    const request = await recovery(f, input, round), base = input.origin.baseCommit
    git(f.repo, 'checkout', '--detach', base)
    for (const ref of git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').filter(Boolean)) git(f.repo, 'update-ref', '-d', ref)
    writeFileSync(join(f.repo, 'app/note'), 'staged'); git(f.repo, 'add', 'app/note'); writeFileSync(join(f.repo, 'app/note'), 'unstaged')
    writeFileSync(join(f.repo, 'untracked'), 'untracked'); writeFileSync(join(f.repo, '.git/FETCH_HEAD'), 'leave this exact file alone\n')
    const hooks = join(f.root, 'hooks'), marker = join(f.root, 'hook-ran'); mkdirSync(hooks)
    writeFileSync(join(hooks, 'reference-transaction'), `#!/bin/sh\necho hook > '${marker}'\nexit 55\n`); chmodSync(join(hooks, 'reference-transaction'), 0o700)
    git(f.repo, 'config', 'core.hooksPath', hooks); git(f.repo, 'config', 'submodule.recurse', 'true'); git(f.repo, 'config', 'fetch.recurseSubmodules', 'true')
    git(f.repo, 'config', 'gc.auto', '1'); git(f.repo, 'config', 'maintenance.auto', 'true'); git(f.repo, 'config', 'fetch.writeCommitGraph', 'true')
    git(f.repo, 'config', 'fetch.prune', 'true'); git(f.repo, 'config', 'fetch.pruneTags', 'true')
    const before = protectedState(f.repo), fetched = await operation(f.source.manager, request)
    expect(fetched.status, JSON.stringify(fetched.error)).toBe('succeeded'); expect(protectedState(f.repo)).toEqual(before); expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(f.repo, '.git/objects/info/commit-graph'))).toBe(false)
    const ref = `refs/hapi/results/${round.environmentId}/${round.roundId}`
    expect(fetched.fetched!.ref).toBe(ref); expect(git(f.repo, 'show', `${ref}:result.txt`)).toBe('offline recovered code')
    expect(await f.source.manager.request(request)).toEqual({ operation: fetched })
    expect((await operation(f.source.manager, { ...request, operationId: randomUUID() })).status).toBe('succeeded'); expect(protectedState(f.repo)).toEqual(before)
    const restarted = machine(f.source.home, 'source'); expect(await restarted.manager.request(request)).toEqual({ operation: fetched })
    await restarted.manager.request({ action: 'release', operationId: request.operationId }); expect(existsSync(join(f.source.home, 'workspaces/fetches', request.operationId, 'data'))).toBe(false)
    expect(git(f.repo, 'rev-parse', ref)).toBe(request.result.resultHead)
    git(f.repo, '-c', 'core.hooksPath=/dev/null', 'update-ref', ref, base)
    expect((await operation(restarted.manager, { ...request, operationId: randomUUID() })).error?.code).toBe('repository_ref_conflict')
    expect(git(f.repo, 'rev-parse', ref)).toBe(base)
    git(f.repo, '-c', 'core.hooksPath=/dev/null', 'update-ref', ref, request.result.resultHead)
    rmSync(join(hooks, 'reference-transaction'))
    // A separate, explicit accept command can merge without touching unrelated parent dirty files.
    git(f.repo, '-c', 'submodule.recurse=false', 'merge', '--ff-only', ref)
    expect(readFileSync(join(f.repo, 'result.txt'), 'utf8')).toBe('offline recovered code')
    expect(readFileSync(join(f.repo, 'app/note'), 'utf8')).toBe('unstaged')
}, 40_000)

it('restores old/new LFS and native recursive module stores for later explicit offline initialization', async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null'); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    const f = fixture(), leaf = init(join(f.root, 'source/leaf')), module = init(join(f.root, 'source/module'))
    git(leaf, 'lfs', 'install', '--local'); writeFileSync(join(leaf, '.gitattributes'), '*.dat filter=lfs diff=lfs merge=lfs -text\n')
    const moduleBytes = Buffer.from('module entity\0'.repeat(128)); writeFileSync(join(leaf, 'asset.dat'), moduleBytes)
    writeFileSync(join(leaf, 'leaf'), 'leaf content'); commit(leaf)
    git(module, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'same', leaf, 'nested'); commit(module)
    git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'same', module, 'lib'); commit(f.repo)
    git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive')
    cpSync(join(leaf, '.git/lfs'), join(f.repo, '.git/modules/same/modules/same/lfs'), { recursive: true })
    git(f.repo, 'lfs', 'install', '--local'); git(f.repo, 'config', 'lfs.storage', 'custom-lfs')
    writeFileSync(join(f.repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    const old = Buffer.from('old entity\0'.repeat(128)), changed = Buffer.from('new entity\0'.repeat(1024))
    writeFileSync(join(f.repo, 'asset.bin'), old); commit(f.repo)
    const input = await baseline(f), round = await prepare(f.target, input.source)
    writeFileSync(join(round.workspace.checkout, 'asset.bin'), changed)
    const request = await recovery(f, input, round)
    git(f.repo, 'submodule', 'deinit', '-f', '--all'); renameSync(join(f.repo, '.git/modules/same'), join(f.root, 'old-modules'))
    renameSync(join(f.repo, '.git/custom-lfs/objects'), join(f.root, 'old-lfs-objects'))
    const before = protectedState(f.repo), fetched = await operation(f.source.manager, request)
    expect(fetched.status, JSON.stringify(fetched.error)).toBe('succeeded'); expect(protectedState(f.repo)).toEqual(before)
    for (const bytes of [old, changed]) {
        const oid = createHash('sha256').update(bytes).digest('hex')
        const found = fetched.fetched!.lfs.find(file => file.oid === oid)!; expect(found).toBeDefined()
        expect(found.path).toContain('/.git/custom-lfs/objects/'); expect(readFileSync(found.path)).toEqual(bytes)
    }
    expect(fetched.fetched!.repositories.map(repo => repo.directory)).toEqual([join(f.repo, '.git'), join(f.repo, '.git/modules/same'), join(f.repo, '.git/modules/same/modules/same')])
    expect(existsSync(join(f.repo, 'lib/.git'))).toBe(false)
    // Make every recorded upstream URL unusable; no-fetch can still initialize both recovered stores.
    renameSync(join(f.root, 'source/module'), join(f.root, 'module-offline')); renameSync(join(f.root, 'source/leaf'), join(f.root, 'leaf-offline'))
    git(f.repo, 'merge', '--ff-only', fetched.fetched!.ref); git(f.repo, 'lfs', 'checkout')
    git(f.repo, 'submodule', 'update', '--init', '--recursive', '--no-fetch')
    git(join(f.repo, 'lib/nested'), 'lfs', 'checkout'); expect(readFileSync(join(f.repo, 'lib/nested/asset.dat'))).toEqual(moduleBytes)
    expect(readFileSync(join(f.repo, 'asset.bin'))).toEqual(changed); expect(readFileSync(join(f.repo, 'lib/nested/leaf'), 'utf8')).toBe('leaf content')
    const configs = fetched.fetched!.repositories.map(repo => readFileSync(join(repo.directory, 'config')))
    expect((await operation(f.source.manager, { ...request, operationId: randomUUID() })).status).toBe('succeeded')
    expect(fetched.fetched!.repositories.map(repo => readFileSync(join(repo.directory, 'config')))).toEqual(configs)
    const moduleDir = fetched.fetched!.repositories[1]!.directory
    git(moduleDir, '--git-dir', moduleDir, 'config', 'core.worktree', f.repo)
    const wrongConfig = readFileSync(join(moduleDir, 'config'))
    expect((await operation(f.source.manager, { ...request, operationId: randomUUID() })).error?.code).toBe('repository_module_mapping')
    expect(readFileSync(join(moduleDir, 'config'))).toEqual(wrongConfig)
}, 45_000)

it('uses the original common directory through a linked worktree even after the original base object is lost', async () => {
    const f = fixture(), input = await baseline(f), round = await prepare(f.target, input.source)
    writeFileSync(join(round.workspace.checkout, 'result.txt'), 'linked result'); const request = await recovery(f, input, round)
    const unrelated = git(f.repo, 'commit-tree', git(f.repo, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated replacement root')
    const current = git(f.repo, 'symbolic-ref', 'HEAD'); git(f.repo, 'update-ref', current, unrelated)
    const linked = join(f.root, 'linked'); git(f.repo, 'worktree', 'add', '--detach', linked, unrelated)
    const baseObject = join(f.repo, '.git/objects', input.origin.baseCommit.slice(0, 2), input.origin.baseCommit.slice(2))
    expect(existsSync(baseObject)).toBe(true); renameSync(baseObject, join(f.root, 'lost-base-object'))
    expect(() => git(f.repo, 'cat-file', '-e', input.origin.baseCommit)).toThrow()
    const index = readFileSync(join(f.repo, '.git/worktrees/linked/index')), config = readFileSync(join(f.repo, '.git/config'))
    const fetched = await operation(f.source.manager, { ...request, target: { ...request.target, cwd: linked } })
    expect(fetched.status, JSON.stringify(fetched.error)).toBe('succeeded'); expect(git(linked, 'rev-parse', 'HEAD')).toBe(unrelated)
    expect(readFileSync(join(f.repo, '.git/worktrees/linked/index'))).toEqual(index); expect(readFileSync(join(f.repo, '.git/config'))).toEqual(config)
    expect(git(f.repo, 'cat-file', '-t', input.origin.baseCommit)).toBe('commit')
    const other = init(join(f.root, 'other')); writeFileSync(join(other, 'x'), 'same machine, different clone'); commit(other)
    expect((await operation(f.source.manager, { ...request, operationId: randomUUID(), target: { ...request.target, cwd: other } })).error?.code).toBe('repository_target_mismatch')
}, 35_000)

it('refuses corrupt recovery materials and leaves failed partial object appends repairable', async () => {
    const f = fixture(); git(f.repo, 'lfs', 'install', '--local'); writeFileSync(join(f.repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    writeFileSync(join(f.repo, 'asset.bin'), 'old'); commit(f.repo)
    const input = await baseline(f), round = await prepare(f.target, input.source); writeFileSync(join(round.workspace.checkout, 'asset.bin'), 'new')
    const request = await recovery(f, input, round), broken = structuredClone(request)
    broken.baseline.snapshot.files[0]!.sha256 = 'f'.repeat(64)
    expect((await operation(f.source.manager, broken)).error?.code).toBe('repository_file_mismatch')
    expect(() => git(f.repo, 'cat-file', '-e', request.result.resultHead)).toThrow()
    const storage = join(f.root, 'storage-is-a-file'); writeFileSync(storage, 'blocked destination'); git(f.repo, 'config', 'lfs.storage', storage)
    const attempt = await operation(f.source.manager, { ...request, operationId: randomUUID() })
    expect(attempt.status).toBe('failed'); expect(attempt.fetched).toBeUndefined()
    const ref = `refs/hapi/results/${request.result.environmentId}/${request.result.roundId}`
    expect(() => git(f.repo, 'rev-parse', '--verify', ref)).toThrow(); expect(git(f.repo, 'cat-file', '-t', request.result.resultHead)).toBe('commit')
    // Lose the terminal receipt after objects were appended. Inspection must not restart the write.
    const receiptPath = join(f.source.home, 'workspaces/fetches', attempt.request.operationId, 'operation.json')
    const interrupted = JSON.parse(readFileSync(receiptPath, 'utf8')) as RepositoryOperation
    interrupted.status = 'running'; delete interrupted.error; writeFileSync(receiptPath, JSON.stringify(interrupted))
    rmSync(storage); mkdirSync(storage)
    const restarted = machine(f.source.home, 'source'), reconciled = await inspect(restarted.manager, attempt.request.operationId)
    expect(reconciled.status).toBe('failed'); expect(reconciled.error?.code).toBe('repository_fetch-result_interrupted')
    expect(() => git(f.repo, 'rev-parse', '--verify', ref)).toThrow()
    await restarted.manager.request({ action: 'release', operationId: attempt.request.operationId })
    expect(git(f.repo, 'cat-file', '-t', request.result.resultHead)).toBe('commit'); expect(existsSync(storage)).toBe(true)
    const repaired = await operation(restarted.manager, { ...request, operationId: randomUUID() }); expect(repaired.status, JSON.stringify(repaired.error)).toBe('succeeded')
    expect(await restarted.manager.request(attempt.request)).toMatchObject({ operation: { status: 'failed' } })
}, 35_000)
