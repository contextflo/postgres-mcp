import { FunctionPolicy } from '../src/safety/functions.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseContextFile } from '../src/context/context-file.js'
import { ContextStore } from '../src/context/store.js'
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
      contextFile: ContextStore.inMemory(),
      log: QueryLog.disabled(),
      maxRows: 10,
      maxOutputChars: 50_000,
      functions: FunctionPolicy.fromEntries([]),
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
      contextFile: ContextStore.inMemory(parseContextFile(
        '# Context\n\nRevenue means gross, before refunds.\n\n## Tables\n\n### public.orders\nOne row per order.\n'
      )),
    })

    expect(client.getInstructions()).toContain('Revenue means gross')
  })

  it('prefers curated descriptions over the catalog comment', async () => {
    await connect({
      contextFile: ContextStore.inMemory(parseContextFile(
        '## Tables\n\n### public.orders\nThe table finance actually uses.\n\n- revenue_usd — Gross, before refunds.\n'
      )),
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

describe('list_tables and the preamble', () => {
  it('carries the business definitions, for clients that drop server instructions', async () => {
    await connect({
      contextFile: ContextStore.inMemory(parseContextFile('Revenue means gross.\n\n## Tables\n')),
    })

    const result = await client.callTool({ name: 'list_tables', arguments: {} })

    expect(JSON.stringify(result.content)).toContain('Revenue means gross.')
  })
})

describe('add_table_context', () => {
  let directory: string
  let contextPath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'postgres-mcp-server-'))
    contextPath = join(directory, 'context.md')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  async function connectWritable(catalogRows = CATALOG_ROWS): Promise<void> {
    await connect({
      database: { ...fakeDatabase(), internalQuery: async () => catalogRows } as unknown as Database,
      contextFile: await ContextStore.open(contextPath, { writable: true }),
    })
  }

  function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
    return JSON.stringify(result.content)
  }

  it('is offered only when context writes are on', async () => {
    await connectWritable()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain('add_table_context')

    await client.close()
    await connect()
    await expect(
      client.callTool({ name: 'add_table_context', arguments: { table: 'orders', note: 'x' } })
    ).rejects.toThrow(/Unknown tool/)
  })

  it('writes a note that get_table_context serves from then on', async () => {
    await connectWritable()

    const added = await client.callTool({
      name: 'add_table_context',
      arguments: { table: 'orders', note: 'Excludes test orders.', columns: { REVENUE_USD: 'In cents.' } },
    })

    expect(added.isError).toBe(false)
    // Resolved to the qualified name and the column's real spelling.
    const file = await readFile(contextPath, 'utf8')
    expect(file).toContain('### public.orders')
    expect(file).toContain('- revenue_usd — In cents.')

    const described = await client.callTool({ name: 'get_table_context', arguments: { tables: ['public.orders'] } })
    expect(textOf(described)).toContain('Excludes test orders.')
    expect(textOf(described)).toContain('In cents.')
  })

  it('refuses a table that does not exist, so a guess cannot become a heading', async () => {
    await connectWritable([])

    const result = await client.callTool({ name: 'add_table_context', arguments: { table: 'ordrs', note: 'x' } })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('list_tables')
  })

  it('refuses a column the table does not have', async () => {
    await connectWritable()

    const result = await client.callTool({
      name: 'add_table_context',
      arguments: { table: 'public.orders', columns: { revenue: 'x' } },
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no column revenue')
  })

  it('asks for a qualified name when the bare one is ambiguous', async () => {
    await connectWritable([...CATALOG_ROWS, { ...CATALOG_ROWS[0]!, schema: 'archive' }])

    const result = await client.callTool({ name: 'add_table_context', arguments: { table: 'orders', note: 'x' } })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('archive.orders')
  })

  it('requires something to add', async () => {
    await connectWritable()

    const result = await client.callTool({ name: 'add_table_context', arguments: { table: 'public.orders' } })

    expect(result.isError).toBe(true)
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
