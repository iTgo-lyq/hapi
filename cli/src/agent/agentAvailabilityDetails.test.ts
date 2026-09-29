import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as codexExecutable from '@/codex/utils/codexExecutable'
import { getAgentAvailabilityResponse, getAgentAvailabilityDetailsResponse } from './agentAvailability'

const directories: string[] = []
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-agent-details-'))
    directories.push(directory)
    const executable = async (name: string, body: string) => {
        const path = join(directory, name)
        await writeFile(path, `#!/bin/sh\n${body}\n`)
        await chmod(path, 0o755)
        return path
    }
    return { directory, executable }
}
afterEach(async () => {
    vi.restoreAllMocks()
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

// These fixtures execute POSIX scripts; the production resolver retains Windows shim support.
describe.skipIf(process.platform === 'win32')('native availability details', () => {
    it('keeps discovery side-effect free and probes the actual launcher instead of the legacy override', async () => {
        const { directory, executable } = await fixture()
        const marker = join(directory, 'invoked')
        const codex = await executable('codex', `printf called > '${marker}'\nprintf 'codex-cli 0.160.2\\n'`)
        const legacy = await executable('legacy', "printf 'codex-cli 0.100.0\\n'")
        const claude = await executable('custom-claude', "printf '2.1.283 (Claude Code)\\n'")
        const env = { PATH: directory, HAPI_CODEX_APP_SERVER_BIN: legacy, HAPI_CLAUDE_PATH: claude }
        expect(getAgentAvailabilityResponse(env).agents.find(row => row.agent === 'codex')).toEqual({ agent: 'codex', available: true })
        expect(existsSync(marker)).toBe(false)
        const response = await getAgentAvailabilityDetailsResponse(env)
        expect(response.agents.find(row => row.agent === 'codex')).toMatchObject({ available: true,
            details: { executable: codex, version: '0.160.2', versionStatus: 'detected' } })
        expect(response.agents.find(row => row.agent === 'claude')).toMatchObject({ available: true,
            details: { executable: claude, version: '2.1.283', versionStatus: 'detected' } })
        expect(response.agents.filter(row => !['codex', 'claude'].includes(row.agent)).every(row => row.details === undefined)).toBe(true)
        expect(existsSync(marker)).toBe(true)
    })

    it('does not confuse a passing legacy preflight with an installed native Codex', async () => {
        const { directory, executable } = await fixture()
        const legacy = await executable('legacy', "printf 'codex-cli 0.160.0\\n'")
        vi.spyOn(codexExecutable, 'resolveCodexCommand').mockReturnValue({ command: join(directory, 'missing-codex'), args: [] })
        const response = await getAgentAvailabilityDetailsResponse({ PATH: directory, HAPI_CODEX_APP_SERVER_BIN: legacy, HAPI_CLAUDE_PATH: '/missing/claude' })
        expect(response.agents.find(row => row.agent === 'codex')).toMatchObject({ available: true,
            details: { executable: null, version: null, versionStatus: 'not_found' } })
        expect(response.agents.find(row => row.agent === 'claude')).toMatchObject({ available: false, reason: 'not_found',
            details: { executable: null, versionStatus: 'not_found' } })
    })

    it('retains the original invalid-configuration preflight while identifying the actual command', async () => {
        const { directory, executable } = await fixture()
        const codex = await executable('codex', "printf 'codex-cli 0.160.0\\n'")
        const response = await getAgentAvailabilityDetailsResponse({ PATH: directory, HAPI_CODEX_APP_SERVER_BIN: '/missing/legacy' })
        expect(response.agents.find(row => row.agent === 'codex')).toMatchObject({ available: false, reason: 'invalid_configuration',
            details: { executable: codex, version: '0.160.0', versionStatus: 'detected' } })
    })

    it('reports version failures separately and bounds a slow probe without blocking the event loop', async () => {
        const { directory, executable } = await fixture()
        for (const [body, status] of [["printf 'PRIVATE_DIAGNOSTIC' >&2; exit 7", 'failed'], ["printf unexpected", 'unrecognized'], ['exec /bin/sleep 30', 'timeout']]) {
            await executable('codex', body)
            let ticked = false
            const timer = setTimeout(() => { ticked = true }, 50)
            const response = await getAgentAvailabilityDetailsResponse({ PATH: directory })
            clearTimeout(timer)
            const row = response.agents.find(row => row.agent === 'codex')!
            expect(row).toMatchObject({ available: true, details: { version: null, versionStatus: status } })
            expect(row.details!.checkedAt).toBeGreaterThan(0)
            expect(JSON.stringify(response)).not.toContain('PRIVATE_DIAGNOSTIC')
            if (status === 'timeout') expect(ticked).toBe(true)
        }
    })
})
