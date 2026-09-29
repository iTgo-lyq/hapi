import { RepositoryPathSchema } from '@hapi/protocol'
import { git, WorkspaceError, type GitOptions } from '../workspaces/git'

export const fail = (code: string, message: string, hint?: string): never => { throw new WorkspaceError(code, message, hint) }
export function logical(value: string, allowEmpty = false) {
    if (!RepositoryPathSchema.safeParse(value).success || !allowEmpty && !value) return fail('repository_path_invalid', 'Unsupported repository path.', value)
    return value
}
export async function modules(cwd: string, commit: string, options: GitOptions) {
    const tree = (await git(cwd, ['ls-tree', '-r', '-z', commit], options)).stdout.split('\0').filter(line => line.startsWith('160000 '))
    if (!tree.length) return []
    const definitions = await git(cwd, ['config', '--blob', `${commit}:.gitmodules`, '--null', '--get-regexp', '^submodule\\..*\\.path$'], { ...options, allowFailure: true })
    if (definitions.exitCode !== 0) return fail('repository_submodule_invalid', 'Gitlinks require valid .gitmodules paths.')
    const paths = definitions.stdout.split('\0').filter(Boolean).map(line => {
        const split = line.indexOf('\n')
        if (split < 0) return fail('repository_submodule_invalid', 'Invalid submodule definition.')
        return { name: logical(line.slice('submodule.'.length, split - '.path'.length)), path: logical(line.slice(split + 1)) }
    })
    return tree.map(line => {
        const split = line.indexOf('\t'), path = logical(line.slice(split + 1)), matches = paths.filter(item => item.path === path)
        if (matches.length !== 1) return fail('repository_submodule_invalid', 'A gitlink requires one matching submodule definition.', path)
        return { ...matches[0]!, commit: line.slice(0, split).split(' ')[2]! }
    })
}
export type LfsEntry = { name: string; oid: string; oid_type: string; size: number; checkout?: boolean; downloaded?: boolean }
export async function lfsFiles(cwd: string, commit: string | undefined, options: GitOptions): Promise<LfsEntry[]> {
    const result = await git(cwd, ['lfs', 'ls-files', '--json', ...(commit ? [commit] : [])], { ...options, allowFailure: true })
    if (result.exitCode !== 0) {
        const pointers = await git(cwd, ['grep', '-I', '-l', '-z', '-e', '^version https://git-lfs.github.com/spec/v1$', commit ?? 'HEAD', '--'], { ...options, allowFailure: true })
        if (pointers.exitCode === 1) return []
        return fail('repository_lfs_unavailable', 'Cannot enumerate LFS objects; install or repair git-lfs.', cwd)
    }
    const entries = JSON.parse(result.stdout).files ?? []
    if (!Array.isArray(entries)) return fail('repository_lfs_invalid', 'git-lfs returned an invalid file list.')
    for (const file of entries) {
        logical(file.name)
        if (file.oid_type !== 'sha256' || !/^[a-f0-9]{64}$/.test(file.oid) || !Number.isSafeInteger(file.size) || file.size < 0) return fail('repository_lfs_invalid', 'Unsupported LFS object descriptor.', file.name)
    }
    return entries
}
