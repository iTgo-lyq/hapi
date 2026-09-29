import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { RepositoryExportRequest, RepositoryOperation } from '@hapi/protocol'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { WorkspaceManager } from '../workspaces/manager'
import { RepositoryManager } from './manager'

const roots: string[] = [], managers: RepositoryManager[] = []
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
function git(cwd: string, ...args: string[]) { return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim() }
function init(path: string, format = 'sha1') {
    mkdirSync(path, { recursive: true }); git(path, 'init', '-q', `--object-format=${format}`)
    git(path, 'config', 'user.name', 'Repository Test'); git(path, 'config', 'user.email', 'test@example.invalid'); git(path, 'config', 'commit.gpgsign', 'false')
    return path
}
function commit(path: string, message = 'base') { git(path, 'add', '-A'); git(path, 'commit', '-qm', message); return git(path, 'rev-parse', 'HEAD') }
function fixture(format = 'sha1') {
    const parent = resolve(import.meta.dirname, '../../../../../.dev-smoke'); mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(join(parent, 'repository-unit-')); roots.push(root)
    const repo = init(join(root, 'repo'), format); mkdirSync(join(repo, 'app')); writeFileSync(join(repo, 'app/file'), 'base'); commit(repo)
    const home = join(root, 'hapi'), pathPolicy = new MachinePathPolicy()
    const workspaces = new WorkspaceManager({ home, machineId: 'machine', pathPolicy, assertStopped: async () => { throw new Error('No session was created') } })
    const create = () => { const value = new RepositoryManager({ home, pathPolicy, resolveSource: (...args) => workspaces.resolveSource(...args) }); managers.push(value); return value }
    const manager = create()
    return { root, repo, home, workspaces, manager, create }
}
async function operation(manager: RepositoryManager, id: string) {
    const result = await manager.request({ action: 'inspect', operationId: id }); if ('error' in result) throw new Error(result.error.message)
    return result.operation
}
async function exportSource(f: ReturnType<typeof fixture>, cwd = f.repo) {
    const source = await f.workspaces.resolveSource(cwd, 'HEAD', {}, false)
    const request: RepositoryExportRequest = { action: 'export', operationId: randomUUID(), source }
    const result = await f.manager.request(request); expect('operation' in result && result.operation.status).toBe('accepted')
    await f.manager.settled(); return { request, result: await operation(f.manager, request.operationId) }
}
function importBundles(f: ReturnType<typeof fixture>, result: RepositoryOperation) {
    expect(result.status, JSON.stringify(result.error)).toBe('succeeded')
    for (const item of result.snapshot!.repositories) {
        const destination = join(f.root, `verify-${randomUUID()}`); mkdirSync(destination); git(destination, 'init', '--bare', `--object-format=${item.objectFormat}`)
        git(destination, 'fetch', join(result.directory, item.file), `${item.bundleRef}:${item.bundleRef}`)
        expect(git(destination, 'rev-parse', item.bundleRef)).toBe(item.commit)
        git(destination, 'fsck', '--full', '--no-reflogs', item.commit)
    }
}
afterEach(async () => { for (const manager of managers.splice(0)) await manager.stop(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('repository baseline export', () => {
    it.each(['sha1', 'sha256'])('exports fixed %s objects without source writes or a remote, and survives receipt loss/restart', async format => {
        const f = fixture(format), source = await f.workspaces.resolveSource(join(f.repo, 'app'), 'HEAD')
        const request: RepositoryExportRequest = { action: 'export', operationId: randomUUID(), source }
        writeFileSync(join(f.repo, 'app/file'), 'later committed'); commit(f.repo, 'moved branch')
        writeFileSync(join(f.repo, 'app/file'), 'staged'); git(f.repo, 'add', '.'); writeFileSync(join(f.repo, 'untracked'), 'excluded')
        const refs = git(f.repo, 'show-ref'), index = readFileSync(join(f.repo, '.git/index')), config = readFileSync(join(f.repo, '.git/config'))
        await f.manager.request(request); await f.manager.settled()
        const result = await operation(f.manager, request.operationId); expect(result.status, JSON.stringify(result.error)).toBe('succeeded'); expect(result.snapshot?.baseCommit).toBe(source.baseCommit)
        expect(git(f.repo, 'show-ref')).toBe(refs); expect(readFileSync(join(f.repo, '.git/index'))).toEqual(index); expect(readFileSync(join(f.repo, '.git/config'))).toEqual(config)
        expect(readFileSync(join(f.repo, 'app/file'), 'utf8')).toBe('staged'); expect(existsSync(join(f.repo, 'untracked'))).toBe(true)
        renameSync(f.repo, `${f.repo}-offline`); importBundles(f, result)
        const reopened = f.create(); expect(await reopened.request(request)).toEqual({ operation: result })
        expect((await operation(reopened, request.operationId)).snapshot).toEqual(result.snapshot)
        await expect(reopened.request({ ...request, source: { ...source, baseRef: 'other' } })).rejects.toMatchObject({ code: 'repository_request_conflict' })
        const released = await reopened.request({ action: 'release', operationId: request.operationId }); expect('operation' in released && released.operation.retention).toBe('released')
        expect(existsSync(result.directory)).toBe(false); expect((await operation(reopened, request.operationId)).snapshot).toEqual(result.snapshot)
        expect((await reopened.request(request))).toEqual(released)
    })

    it('exports fixed recursive gitlinks and LFS entities despite later commits and dirty source files', async () => {
        const f = fixture(), leaf = init(join(f.root, 'leaf')); git(leaf, 'lfs', 'install', '--local')
        writeFileSync(join(leaf, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
        const content = Buffer.from('binary baseline\0'.repeat(1000)); writeFileSync(join(leaf, 'asset.bin'), content); const old = commit(leaf)
        const middle = init(join(f.root, 'middle')); writeFileSync(join(middle, 'note'), 'middle'); commit(middle)
        git(middle, '-c', 'protocol.file.allow=always', 'submodule', 'add', leaf, 'nested module'); commit(middle)
        git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', middle, 'vendor/lib'); commit(f.repo)
        git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive')
        const nested = join(f.repo, 'vendor/lib/nested module'); git(nested, 'lfs', 'install', '--local')
        // Populate the source LFS object without relying on a Git LFS server.
        const oid = createHash('sha256').update(content).digest('hex'), common = git(nested, 'rev-parse', '--path-format=absolute', '--git-common-dir')
        const entity = join(common, 'lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid); mkdirSync(join(entity, '..'), { recursive: true }); writeFileSync(entity, content)
        git(nested, 'config', 'user.name', 'Test'); git(nested, 'config', 'user.email', 'test@example.invalid')
        writeFileSync(join(nested, 'asset.bin'), 'new content'); commit(nested, 'newer than gitlink'); writeFileSync(join(nested, 'asset.bin'), 'dirty')
        const { result, request } = await exportSource(f)
        expect(result.status, JSON.stringify(result.error)).toBe('succeeded')
        expect(result.snapshot!.repositories.map(repo => repo.path)).toEqual(['', 'vendor/lib', 'vendor/lib/nested module'])
        expect(result.snapshot!.repositories[2]!.commit).toBe(old)
        expect(result.snapshot!.lfs).toEqual([{ repository: 'vendor/lib/nested module', path: 'asset.bin', oid, size: content.length, file: `lfs-${oid}` }])
        expect(readFileSync(join(result.directory, `lfs-${oid}`))).toEqual(content)
        importBundles(f, result)
        await f.manager.request({ action: 'release', operationId: request.operationId, names: [`lfs-${oid}`] })
        expect(existsSync(join(result.directory, `lfs-${oid}`))).toBe(false)
        expect(existsSync(join(result.directory, result.snapshot!.repositories[0]!.file))).toBe(true)
        expect((await operation(f.manager, request.operationId)).retention).toBe('retained')
    }, 30_000)

    it('rejects missing and corrupt LFS entities, preserving error receipts', async () => {
        const f = fixture(); git(f.repo, 'lfs', 'install', '--local'); writeFileSync(join(f.repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
        const bytes = Buffer.from('LFS entity'); writeFileSync(join(f.repo, 'file.bin'), bytes); commit(f.repo)
        const oid = createHash('sha256').update(bytes).digest('hex'), entity = join(f.repo, '.git/lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid)
        await rm(entity); const missing = await exportSource(f); expect(missing.result.error?.code).toBe('repository_lfs_missing')
        mkdirSync(join(entity, '..'), { recursive: true }); writeFileSync(entity, 'corrupt')
        const corrupt = await exportSource(f); expect(corrupt.result.error?.code).toBe('repository_lfs_mismatch')
        expect((await operation(f.create(), corrupt.request.operationId)).status).toBe('failed')
        const released = await f.manager.request({ action: 'release', operationId: corrupt.request.operationId }); expect('operation' in released && released.operation.retention).toBe('released')
    })

    it('rejects shallow and incomplete partial sources without lazy fetch', async () => {
        const f = fixture(); writeFileSync(join(f.repo, 'app/file'), 'second'); commit(f.repo)
        git(f.repo, 'config', 'uploadpack.allowFilter', 'true')
        const shallow = join(f.root, 'shallow'); git(f.root, 'clone', '--depth=1', `file://${f.repo}`, shallow)
        const first = await exportSource(f, shallow); expect(first.result.error?.code).toBe('repository_shallow')
        const partial = join(f.root, 'partial'); git(f.root, 'clone', '--filter=blob:none', '--no-checkout', `file://${f.repo}`, partial)
        const source = await f.workspaces.resolveSource(partial, 'HEAD'), head = source.baseCommit
        // Keep the promisor source reachable: missing-object failure must not be a side effect of an offline URL.
        const request = { action: 'export', operationId: randomUUID(), source }; await f.manager.request(request); await f.manager.settled()
        const result = await operation(f.manager, request.operationId); expect(result.status).toBe('failed'); expect(result.snapshot).toBeUndefined()
        expect(git(partial, 'rev-parse', 'HEAD')).toBe(head)
        expect(result.error?.hint).toMatch(/unable to read|Could not read/)
    })

    it('rejects changed source identity and incomplete submodule objects; recovers a stopped interrupted receipt without rerunning', async () => {
        const f = fixture(), source = await f.workspaces.resolveSource(f.repo, 'HEAD')
        const bad = { action: 'export', operationId: randomUUID(), source: { ...source, repositoryId: 'wrong' } }
        await f.manager.request(bad); await f.manager.settled(); expect((await operation(f.manager, bad.operationId)).error?.code).toBe('repository_source_changed')
        const child = init(join(f.root, 'child')); writeFileSync(join(child, 'file'), 'child'); commit(child)
        git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'child'); commit(f.repo)
        git(f.repo, 'submodule', 'deinit', '--force', '--all'); await rm(join(f.repo, '.git/modules/child'), { recursive: true })
        const incomplete = await exportSource(f); expect(incomplete.result.error?.code).toBe('repository_submodule_missing')
        const receipt = join(f.home, 'workspaces/exports', incomplete.request.operationId, 'operation.json')
        const record = JSON.parse(readFileSync(receipt, 'utf8')); record.status = 'running'; record.error = undefined; writeFileSync(receipt, JSON.stringify(record))
        const recovered = await operation(f.create(), incomplete.request.operationId); expect(recovered.status).toBe('failed'); expect(recovered.error?.code).toBe('repository_export_interrupted')
        expect((await f.manager.request(incomplete.request))).toEqual({ operation: recovered })
    })
    it('handles linked worktrees and custom source LFS storage without copying source configuration', async () => {
        const f = fixture(); git(f.repo, 'lfs', 'install', '--local')
        git(f.repo, 'config', 'lfs.storage', '../shared-lfs')
        writeFileSync(join(f.repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
        writeFileSync(join(f.repo, 'asset.bin'), Buffer.from('shared LFS\0')); commit(f.repo)
        const linked = join(f.root, 'linked'); git(f.repo, 'worktree', 'add', '-b', 'linked-source', linked)
        const config = readFileSync(join(f.repo, '.git/config')), refs = git(f.repo, 'show-ref')
        const { result } = await exportSource(f, linked)
        expect(result.status, JSON.stringify(result.error)).toBe('succeeded'); expect(result.snapshot!.lfs).toHaveLength(1)
        expect(readFileSync(join(f.repo, '.git/config'))).toEqual(config); expect(git(f.repo, 'show-ref')).toBe(refs)
        importBundles(f, result)
    })

    it('does not require git-lfs for ordinary repositories, but rejects committed pointers when it is absent', async () => {
        const f = fixture(), bin = join(f.root, 'bin'); mkdirSync(bin)
        const native = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
        writeFileSync(join(bin, 'git'), '#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = lfs ]; then exit 1; fi\ndone\nexec "' + native + '" "$@"\n'); chmodSync(join(bin, 'git'), 0o700)
        vi.stubEnv('PATH', bin + ':' + process.env.PATH)
        const ordinary = await exportSource(f); expect(ordinary.result.status, JSON.stringify(ordinary.result.error)).toBe('succeeded')
        writeFileSync(join(f.repo, 'pointer'), 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 4\n'); commit(f.repo)
        const pointer = await exportSource(f); expect(pointer.result.error?.code).toBe('repository_lfs_unavailable')
    })

})
