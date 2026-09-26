import { beforeAll, describe, expect, it } from 'vitest'
import { ContextStore } from '../../src/context/store.js'
import type { Database, ReadOnlyResult } from '../../src/db/pool.js'
import { QueryLog } from '../../src/log.js'
import { ensureParserReady } from '../../src/safety/validate.js'
import type { ToolContext } from '../../src/tools/context.js'
import { runQueryTool } from '../../src/tools/query.js'

beforeAll(async () => {
  await ensureParserReady()
})

/** Stands in for a live database so the tool's own behavior can be tested without one. */
function fakeDatabase(result: ReadOnlyResult | Error, maxRows = 10, maxOutputChars = 50_000): ToolContext {
  return toolContext(
    {
      runReadOnly: async () => {
        if (result instanceof Error) throw result
        return result
      },
    } as unknown as Database,
    maxRows,
    maxOutputChars
  )
}

function toolContext(database: Database, maxRows = 10, maxOutputChars = 50_000): ToolContext {
  return { database, contextFile: ContextStore.inMemory(), log: QueryLog.disabled(), maxRows, maxOutputChars }
}

function textOf(content: { type: string; text?: string }[], index = 0): string {
  return content[index]?.text ?? ''
}

describe('query tool', () => {
  it('returns rows as JSON, one row per line', async () => {
    const database = fakeDatabase({ rows: [{ id: 1, email: 'a@b.c' }], truncated: false })

    const result = await runQueryTool(database, { sql: 'SELECT id, email FROM users' })

    expect(result.isError).toBe(false)
    expect(JSON.parse(textOf(result.content))).toEqual([{ id: 1, email: 'a@b.c' }])
    expect(result.content).toHaveLength(1)
  })

  it('states truncation and names the flag that raises the cap', async () => {
    const database = fakeDatabase({ rows: [{ id: 1 }], truncated: true }, 1)

    const result = await runQueryTool(database, { sql: 'SELECT id FROM users' })

    expect(result.content).toHaveLength(2)
    expect(textOf(result.content, 1)).toContain('truncated to 1 rows')
    expect(textOf(result.content, 1)).toContain('--max-rows')
    // The JSON block stays clean so the caller can still parse it.
    expect(JSON.parse(textOf(result.content))).toEqual([{ id: 1 }])
  })

  it('renders bytea as hex instead of a Buffer dump', async () => {
    const database = fakeDatabase({
      rows: [{ payload: Buffer.from([0xde, 0xad, 0xbe, 0xef]) }],
      truncated: false,
    })

    const result = await runQueryTool(database, { sql: 'SELECT payload FROM blobs' })

    expect(JSON.parse(textOf(result.content))).toEqual([{ payload: '\\xdeadbeef' }])
  })

  it('summarises long byte values rather than printing every byte', async () => {
    const database = fakeDatabase({ rows: [{ payload: Buffer.alloc(4096, 0xab) }], truncated: false })

    const result = await runQueryTool(database, { sql: 'SELECT payload FROM blobs' })

    expect(textOf(result.content)).toContain('(4096 bytes)')
    expect(textOf(result.content).length).toBeLessThan(200)
  })

  it('reports a rejected statement as a tool error the model can act on', async () => {
    const database = fakeDatabase({ rows: [], truncated: false })

    const result = await runQueryTool(database, { sql: 'DELETE FROM users' })

    expect(result.isError).toBe(true)
    expect(textOf(result.content)).toContain('read-only')
    expect(textOf(result.content)).toContain('DELETE')
  })

  it('never reaches the database with a rejected statement', async () => {
    let reached = false
    const database = toolContext({
      runReadOnly: async () => {
        reached = true
        return { rows: [], truncated: false }
      },
    } as unknown as Database)

    await runQueryTool(database, { sql: 'COMMIT; DROP SCHEMA public CASCADE' })

    expect(reached).toBe(false)
  })

  it('requires a non-empty sql argument', async () => {
    const database = fakeDatabase({ rows: [], truncated: false })

    for (const args of [undefined, {}, { sql: '' }, { sql: '   ' }, { sql: 42 }]) {
      const result = await runQueryTool(database, args as Record<string, unknown>)
      expect(result.isError).toBe(true)
    }
  })

  it('surfaces database errors as tool errors', async () => {
    const database = fakeDatabase(Object.assign(new Error('relation "nope" does not exist'), { code: '42P01' }))

    const result = await runQueryTool(database, { sql: 'SELECT * FROM nope' })

    expect(result.isError).toBe(true)
    expect(textOf(result.content)).toContain('Object not found')
  })

  it('stops adding rows at the character budget and says so', async () => {
    const rows = Array.from({ length: 100 }, (_, id) => ({ id, body: 'x'.repeat(100) }))
    const database = fakeDatabase({ rows, truncated: false }, 1000, 1_000)

    const result = await runQueryTool(database, { sql: 'SELECT id, body FROM notes' })

    const shown = JSON.parse(textOf(result.content)) as unknown[]
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(100)
    expect(textOf(result.content).length).toBeLessThanOrEqual(1_000)
    expect(textOf(result.content, 1)).toContain(`${shown.length} of 100 rows`)
    expect(textOf(result.content, 1)).toContain('--max-output-chars')
  })

  it('always shows at least one row, even when it alone is over budget', async () => {
    const database = fakeDatabase({ rows: [{ body: 'x'.repeat(1_500) }], truncated: false }, 10, 100)

    const result = await runQueryTool(database, { sql: 'SELECT body FROM notes' })

    expect(JSON.parse(textOf(result.content))).toHaveLength(1)
  })

  it('shortens one huge value instead of letting it take the whole budget', async () => {
    const database = fakeDatabase({
      rows: [{ id: 1, doc: { items: Array.from({ length: 2_000 }, (_, index) => index) }, text: 'y'.repeat(5_000) }],
      truncated: false,
    })

    const result = await runQueryTool(database, { sql: 'SELECT * FROM docs' })

    const [row] = JSON.parse(textOf(result.content)) as { id: number; doc: string; text: string }[]
    expect(row?.id).toBe(1)
    expect(row?.doc).toMatch(/… \([\d,]+ chars\)$/)
    expect(row?.text).toContain('(5,000 chars)')
    expect(textOf(result.content, 1)).toContain('were shortened')
  })

  it('keeps small jsonb values structured', async () => {
    const database = fakeDatabase({ rows: [{ meta: { plan: 'pro', seats: 3 } }], truncated: false })

    const result = await runQueryTool(database, { sql: 'SELECT meta FROM accounts' })

    expect(JSON.parse(textOf(result.content))).toEqual([{ meta: { plan: 'pro', seats: 3 } }])
  })
})
