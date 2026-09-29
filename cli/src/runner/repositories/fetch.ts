import { existsSync, realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { RepositoryFetch, RepositoryFetchRequest, RepositorySnapshot, WorkspaceSource } from '@hapi/protocol'
import type { MachinePathPolicy } from '@/api/machinePathPolicy'
import { captureFile } from '../artifacts/outputs'
import { git, output, type GitOptions } from '../workspaces/git'
import { fail } from './assets'
import { repositoryReadEnvironment } from './export'
import { stageRepositorySnapshot, verifyRepositorySnapshot } from './verify'

type Identity = Omit<WorkspaceSource, 'baseRef' | 'baseCommit' | 'dirty'>
/** Append verified objects only; accepting code into a branch remains a separate user action. */
export async function fetchRepositoryResult(request: RepositoryFetchRequest, data: string, options: {
    pathPolicy: MachinePathPolicy; gitOptions: GitOptions;
    resolveRepository: (cwd: string, options?: GitOptions) => Promise<Identity>;
    lock: <T>(key: string, action: () => Promise<T>) => Promise<T>;
}): Promise<RepositoryFetch> {
    const hooks = join(data, 'empty-hooks'); await mkdir(hooks, { recursive: true, mode: 0o700 })
    const opts: GitOptions = { ...options.gitOptions,
        config: [`core.hooksPath=${hooks}`, 'submodule.recurse=false', 'gc.auto=0', 'maintenance.auto=false', 'fetch.writeCommitGraph=false'],
        env: { ...options.gitOptions.env, ...repositoryReadEnvironment, GIT_LFS_SKIP_SMUDGE: '1' } }
    async function target() {
        if (!isAbsolute(request.target.cwd)) return fail('repository_target_invalid', 'Result fetch requires an absolute current workspace path.')
        const actual = await options.resolveRepository(request.target.cwd, opts)
        for (const key of ['machineId', 'repositoryId', 'commonDir', 'objectFormat'] as const) {
            if (actual[key] !== request.target[key]) return fail('repository_target_mismatch', 'Fetch must use the original machine and Git common directory.', key)
        }
        return actual
    }
    const origin = await target(), { baseline, output: material, result } = request, snapshot = material.snapshot
    if (baseline.snapshot.sourceMachineId !== origin.machineId || baseline.snapshot.repositoryId !== origin.repositoryId
        || baseline.snapshot.baseCommit !== result.baseCommit || snapshot.baseCommit !== result.resultHead
        || baseline.snapshot.objectFormat !== origin.objectFormat || snapshot.objectFormat !== origin.objectFormat
        || result.resultRef !== `refs/hapi/workspaces/${result.environmentId}/rounds/${result.roundId}`
        || result.checkpoint && result.checkpoint !== result.resultHead) {
        return fail('repository_result_mismatch', 'Recovery materials do not match the origin and sealed result.')
    }
    const modules = (value: RepositorySnapshot) => value.repositories.slice(1).map(repo => ({ path: repo.path,
        module: repo.module, objectFormat: repo.objectFormat, commit: repo.commit }))
    if (!isDeepStrictEqual(modules(baseline.snapshot), modules(snapshot))) {
        return fail('repository_result_modules_changed', 'This workspace result requires the unchanged baseline submodules.')
    }
    for (const [name, input] of [['baseline', baseline], ['output', material]] as const) {
        const directory = join(data, name)
        await stageRepositorySnapshot(input, directory, options.pathPolicy, opts)
        await verifyRepositorySnapshot(input.snapshot, directory, opts)
    }
    const verified = join(data, 'output/verify/0')
    for (const [ancestor, head] of [[result.baseCommit, result.startHead], [result.startHead, result.resultHead]]) {
        if ((await git(verified, ['merge-base', '--is-ancestor', ancestor!, head!], { ...opts, allowFailure: true })).exitCode !== 0) {
            return fail('repository_result_history', 'Recovery bundle does not contain the sealed baseline/start/result ancestry.')
        }
    }
    const changed = (await git(verified, ['diff', '--name-only', '-z', result.startHead, result.resultHead], opts)).stdout.split('\0').filter(Boolean)
    if (changed.length !== result.fileCount || !isDeepStrictEqual(changed.slice(0, 100), result.paths)) {
        return fail('repository_result_mismatch', 'Recovery tree changes differ from the sealed facts.')
    }
    return options.lock(origin.commonDir, async () => {
        const actual = await target(), ref = `refs/hapi/results/${result.environmentId}/${result.roundId}`
        const rootGit = realpathSync(await output(actual.repositoryRoot, ['rev-parse', '--absolute-git-dir'], opts))
        const run = (directory: string, args: string[], extra: GitOptions = {}) => git(directory, ['--git-dir', directory, ...args], { ...opts, ...extra })
        async function expectedRef(directory: string, head: string) {
            const prior = await run(directory, ['rev-parse', '--verify', ref], { allowFailure: true })
            if (prior.exitCode === 0 && prior.stdout.trim() !== head) return fail('repository_ref_conflict', 'The dedicated result reference already has a different commit.', ref)
            return prior.exitCode === 0
        }
        async function pin(directory: string, head: string) {
            if (!await expectedRef(directory, head)) await run(directory, ['update-ref', ref, head, '0'.repeat(head.length)])
        }
        await expectedRef(rootGit, result.resultHead)
        const repositories: RepositoryFetch['repositories'] = []
        const mapping = new Map<string, { directory: string; checkout: string }>([['', { directory: rootGit, checkout: actual.repositoryRoot }]])
        for (const repo of snapshot.repositories) {
            if (repo.module) {
                const parent = mapping.get(repo.module.parent)!, directory = resolve(parent.directory, 'modules', repo.module.name)
                const checkout = resolve(parent.checkout, repo.module.path)
                if (await options.pathPolicy.resolveForCheck(directory) !== directory || !await options.pathPolicy.allowsSpawn(directory)) {
                    return fail('repository_module_mapping', 'Native module storage was redirected or is outside Runner roots.', directory)
                }
                if (existsSync(join(checkout, '.git'))) {
                    const registered = realpathSync(await output(checkout, ['rev-parse', '--absolute-git-dir'], opts))
                    if (registered !== directory) return fail('repository_module_mapping', 'Existing module checkout belongs to a different Git directory.', checkout)
                }
                if (!existsSync(directory)) {
                    await mkdir(directory, { recursive: true, mode: 0o700 })
                    await git(directory, ['init', '--bare', '--template=', `--object-format=${repo.objectFormat}`], opts)
                    // A later native submodule update must recognize this as its working-tree store.
                    await run(directory, ['config', 'core.bare', 'false'])
                    if (snapshot.lfs.some(file => file.repository === repo.path)) {
                        await run(directory, ['lfs', 'install', '--local', '--skip-repo'])
                    }
                }
                const format = (await run(directory, ['rev-parse', '--show-object-format'])).stdout.trim()
                const common = realpathSync((await run(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim())
                if (format !== repo.objectFormat || common !== directory || (await run(directory, ['rev-parse', '--is-bare-repository'])).stdout.trim() === 'true') return fail('repository_module_mapping', 'Existing module object format or common directory differs.', directory)
                const configured = await run(directory, ['config', '--path', '--get', 'core.worktree'], { allowFailure: true })
                if (configured.exitCode > 1 || configured.exitCode === 0 && resolve(directory, configured.stdout.trim()) !== checkout) {
                    return fail('repository_module_mapping', 'Existing module configuration belongs to a different checkout.', directory)
                }
                mapping.set(repo.path, { directory, checkout })
            }
            const entry = mapping.get(repo.path)!
            await expectedRef(entry.directory, repo.commit)
            await run(entry.directory, ['fetch', '--no-tags', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--refmap=',
                join(data, 'output/files', repo.file), repo.bundleRef], { env: { ...opts.env, GIT_ALLOW_PROTOCOL: 'file' } })
            repositories.push({ path: repo.path, directory: entry.directory, commit: repo.commit })
        }
        const lfs: RepositoryFetch['lfs'] = [], seen = new Set<string>()
        for (const [name, value] of [['baseline', baseline.snapshot], ['output', snapshot]] as const) {
            for (const file of value.lfs) {
                const key = `${file.repository}:${file.oid}`; if (seen.has(key)) continue
                const directory = mapping.get(file.repository)!.directory
                const common = file.repository ? directory : actual.commonDir
                const configured = await run(directory, ['config', '--path', '--get', 'lfs.storage'], { allowFailure: true })
                if (configured.exitCode > 1) return fail('repository_lfs_invalid', 'Cannot read target LFS storage configuration.')
                const storage = configured.exitCode === 0 ? resolve(common, configured.stdout.trim()) : join(common, 'lfs')
                const destination = join(storage, 'objects', file.oid.slice(0, 2), file.oid.slice(2, 4), file.oid)
                if (!await options.pathPolicy.allowsSpawn(destination)) return fail('outside_workspace_roots', 'Target LFS storage is outside Runner roots.', destination)
                await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
                const copied = await captureFile(join(data, name, 'files'), { name: file.file, relativePath: file.file }, destination, opts.signal ?? new AbortController().signal)
                if (copied.sha256 !== file.oid || copied.size !== file.size) return fail('repository_lfs_mismatch', 'Target LFS bytes do not match recovery materials.')
                lfs.push({ repository: file.repository, oid: file.oid, size: file.size, path: destination }); seen.add(key)
            }
        }
        // Keep module objects reachable before publishing the root success ref. Never move existing HEADs.
        for (const repo of repositories.filter(repo => repo.path)) await pin(repo.directory, repo.commit)
        await pin(rootGit, result.resultHead)
        return { target: { ...request.target, cwd: actual.sourcePath }, ref, head: result.resultHead, repositories, lfs, fetchedAt: Date.now() }
    })
}
