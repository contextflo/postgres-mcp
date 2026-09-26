import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { emptyContextDocument, parseContextFile } from '../src/context/context-file.js'
import type { Database } from '../src/db/pool.js'
import { QueryLog } from '../src/log.js'
import { ensureParserReady } from '../src/safety/validate.js'
import { createServer } from '../src/server.js'
import type { ToolContext } from '../src/tools/context.js'

/**
 * Exercises the tools over a real MCP session — the wiring between the protocol handlers,
 * the safety layer, and the context file — with a stand-in database so no server is required.
 */

let seenSql: string[] = []

const CATALOG_ROWS = [
  {
    schema: 'public',
    name: 'orders',
    table: 'orders',
    kind: 'table',
    description: null,
    table_description: null,
    approximate_rows: '1200',
    total_matches: '1',
    column_name: 'revenue_usd',
    data_type: 'numeric(12,2)',
    is_nullable: true,
    default_value: null,
    column_description: null,
    is_primary_key: false,
    references: null,
    ordinal: 1,
  },
]

function fakeDatabase(): Database {
  return {
    runReadOnly: async (sql: string) => {
      seenSql.push(sql)
      return { rows: [{ ok: true }], truncated: false }
    },
    internalQuery: async () => CATALOG_ROWS,
  } as unknown as Database
}

let client: Client

async function connect(context: Partial<ToolContext> = {}): Promise<void> {
  const server = createServer({
    context: {
      database: fakeDatabase(),
      contextDocument: emptyContextDocument(),
      log: QueryLog.disabled(),
      maxRows: 10,
      maxOutputChars: 50_000,
      ...context,
    },
    version: '0.0.0-test',
    connectionString: 'postgres://user:secret@db.example.com:5432/app',
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
}

beforeAll(async () => {
  await ensureParserReady()
})

beforeEach(() => {
  seenSql = []
})

afterEach(async () => {
  await client?.close()
})

describe('tools', () => {
  beforeEach(async () => {
    await connect()
  })

  it('advertises query, list_tables, and get_table_context', async () => {
    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual(['get_table_context', 'list_tables', 'query'])
  })

  it('keeps the archived server’s `query` signature', async () => {
    // Same name and argument, so a config swap is enough to migrate.
    const { tools } = await client.listTools()
    const query = tools.find((tool) => tool.name === 'query')

    expect(query?.inputSchema.properties).toHaveProperty('sql')
    expect(query?.inputSchema.required).toEqual(['sql'])
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

  it('lists tables', async () => {
    const result = await client.callTool({ name: 'list_tables', arguments: {} })

    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('public.orders')
  })

  it('describes tables', async () => {
    const result = await client.callTool({
      name: 'get_table_context',
      arguments: { tables: ['public.orders'] },
    })

    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('revenue_usd')
  })

  it('rejects an unknown tool', async () => {
    await expect(client.callTool({ name: 'exec', arguments: {} })).rejects.toThrow(/Unknown tool/)
  })
})

describe('context file', () => {
  it('serves the preamble as server instructions', async () => {
    await connect({
      contextDocument: parseContextFile(
        '# Context\n\nRevenue means gross, before refunds.\n\n## Tables\n\n### public.orders\nOne row per order.\n'
      ),
    })

    expect(client.getInstructions()).toContain('Revenue means gross')
  })

  it('prefers curated descriptions over the catalog comment', async () => {
    await connect({
      contextDocument: parseContextFile(
        '## Tables\n\n### public.orders\nThe table finance actually uses.\n\n- revenue_usd — Gross, before refunds.\n'
      ),
    })

    const result = await client.callTool({
      name: 'get_table_context',
      arguments: { tables: ['public.orders'] },
    })

    const text = JSON.stringify(result.content)
    expect(text).toContain('The table finance actually uses')
    expect(text).toContain('Gross, before refunds')
  })
})

describe('resources', () => {
  beforeEach(async () => {
    await connect()
  })

  it('keeps the archived server’s URI shape and hides the password', async () => {
    const { resources } = await client.listResources()

    expect(resources[0]?.uri).toBe('postgres://user@db.example.com:5432/app/orders/schema')
  })

  it('reads a table schema resource', async () => {
    const { contents } = await client.readResource({
      uri: 'postgres://user@db.example.com:5432/app/orders/schema',
    })

    const columns = JSON.parse(String(contents[0]?.text))
    expect(columns[0]).toMatchObject({ column_name: 'revenue_usd', data_type: 'numeric(12,2)' })
  })
})
