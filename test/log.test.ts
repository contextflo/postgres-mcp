import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QueryLog } from '../src/log.js'

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'postgres-mcp-log-'))
}

describe('QueryLog', () => {
  it('writes a header and one entry per query', async () => {
    const directory = await scratch()
    const path = join(directory, 'log.md')

    const log = QueryLog.enabled(path)
    log.record({ sql: 'SELECT 1', outcome: 'ok', rowCount: 1, durationMs: 4 })
    log.record({ sql: 'DELETE FROM users', outcome: 'rejected', message: 'read-only' })
    await log.flush()

    const contents = await readFile(path, 'utf8')

    expect(contents).toContain('# postgres-mcp query log')
    expect(contents).toContain('SELECT 1')
    expect(contents).toContain('1 rows · 4ms')
    expect(contents).toContain('rejected')
    expect(contents).toContain('> read-only')
    // Header written once, not per entry.
    expect(contents.match(/# postgres-mcp query log/g)).toHaveLength(1)
  })

  it('keeps concurrent writes from interleaving', async () => {
    const directory = await scratch()
    const path = join(directory, 'log.md')

    const log = QueryLog.enabled(path)
    for (let index = 0; index < 25; index++) {
      log.record({ sql: `SELECT ${index}`, outcome: 'ok', rowCount: index })
    }
    await log.flush()

    const contents = await readFile(path, 'utf8')

    expect(contents.match(/```sql/g)).toHaveLength(25)
    expect(contents.indexOf('SELECT 0')).toBeLessThan(contents.indexOf('SELECT 24'))
  })

  it('does nothing when disabled', async () => {
    const log = QueryLog.disabled()

    expect(log.isEnabled).toBe(false)
    log.record({ sql: 'SELECT 1', outcome: 'ok' })
    await expect(log.flush()).resolves.toBeUndefined()
  })

  it('turns itself on once the context directory exists, and stays off otherwise', async () => {
    const directory = await scratch()
    const contextDirectory = join(directory, '.contextflo')

    const before = await QueryLog.resolve({ disabled: false, contextDirectory })
    expect(before.isEnabled).toBe(false)

    await mkdir(contextDirectory)

    const after = await QueryLog.resolve({ disabled: false, contextDirectory })
    expect(after.isEnabled).toBe(true)
    expect(after.filePath).toBe(join(contextDirectory, 'log.md'))
  })

  it('honours --no-log over an existing context directory', async () => {
    const directory = await scratch()
    const contextDirectory = join(directory, '.contextflo')
    await mkdir(contextDirectory)

    const log = await QueryLog.resolve({ disabled: true, contextDirectory })

    expect(log.isEnabled).toBe(false)
  })

  it('survives an unwritable path without failing the query', async () => {
    // A logging problem must never turn a successful query into a failed tool call.
    const log = QueryLog.enabled('/nonexistent-root-directory/log.md')

    log.record({ sql: 'SELECT 1', outcome: 'ok' })

    await expect(log.flush()).resolves.toBeUndefined()
  })
})
