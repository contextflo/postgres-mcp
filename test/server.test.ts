import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../src/db/pool.js'
import { ensureParserReady } from '../src/safety/validate.js'
import { createServer } from '../src/server.js'

/**
 * Exercises the tool over a real MCP session — the wiring between the protocol handlers
 * and the safety layer — with a stand-in database so no server is required.
 */

let seenSql: string[] = []

function fakeDatabase(): Database {
  return {
    runReadOnly: async (sql: string) => {
      seenSql.push(sql)
      return { rows: [{ ok: true }], truncated: false }
    },
  } as unknown as Database
}

let client: Client

beforeAll(async () => {
  await ensureParserReady()
})

beforeEach(async () => {
  seenSql = []

  const server = createServer({ database: fakeDatabase(), maxRows: 10, version: '0.0.0-test' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterEach(async () => {
  await client.close()
})

describe('MCP session', () => {
  it('advertises a single `query` tool taking `sql`', async () => {
    // Same name and argument as the archived server, so a config swap is enough to migrate.
    const { tools } = await client.listTools()

    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('query')
    expect(tools[0]?.inputSchema.properties).toHaveProperty('sql')
    expect(tools[0]?.inputSchema.required).toEqual(['sql'])
  })

  it('runs an allowed query', async () => {
    const result = await client.callTool({ name: 'query', arguments: { sql: 'SELECT 1' } })

    expect(result.isError).toBe(false)
    expect(seenSql).toEqual(['SELECT 1'])
  })

  it('returns a tool error for a rejected query without touching the database', async () => {
    const result = await client.callTool({
      name: 'query',
      arguments: { sql: 'COMMIT; DROP SCHEMA public CASCADE' },
    })

    expect(result.isError).toBe(true)
    expect(seenSql).toEqual([])
  })

  it('rejects an unknown tool', async () => {
    await expect(client.callTool({ name: 'exec', arguments: {} })).rejects.toThrow(/Unknown tool/)
  })
})
