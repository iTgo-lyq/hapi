import { expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Store } from './index'

it('adds persistent artifact tables to a v27 database without replacing existing state', async () => {
    const base = resolve(import.meta.dir, '../../../../.dev-smoke/tests')
    await mkdir(base, { recursive: true })
    const root = await mkdtemp(join(base, 'artifact-migration-')), path = join(root, 'hapi.db')
    try {
        const initial = new Store(path); initial.close()
        const old = new Database(path)
        old.exec('DROP TABLE artifact_references; DROP TABLE artifacts; CREATE TABLE retained_fixture(value TEXT); INSERT INTO retained_fixture VALUES (\'old-data\'); PRAGMA user_version=27;')
        old.close()
        const migrated = new Store(path)
        expect(migrated.artifacts.list('default')).toEqual([])
        migrated.close()
        const check = new Database(path)
        expect(check.query('PRAGMA user_version').get()).toEqual({ user_version: 28 })
        expect(check.query('SELECT value FROM retained_fixture').get()).toEqual({ value: 'old-data' })
        check.close()
    } finally { await rm(root, { recursive: true, force: true }) }
})
