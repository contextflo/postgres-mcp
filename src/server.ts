import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { parse as parseConnectionString } from 'pg-connection-string'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { getTableContext, listTables } from './db/introspection.js'
import { ADD_TABLE_CONTEXT_TOOL, runAddTableContextTool } from './tools/add-table-context.js'
import { GET_TABLE_CONTEXT_TOOL, runGetTableContextTool } from './tools/get-table-context.js'
import { LIST_TABLES_TOOL, runListTablesTool } from './tools/list-tables.js'
import { QUERY_TOOL, runQueryTool } from './tools/query.js'
import type { ToolContext } from './tools/context.js'

export interface ServerDeps {
  context: ToolContext
  version: string
  /** Connection string, used only to build resource URIs. The password is stripped. */
  connectionString: string
}

const SCHEMA_PATH = 'schema'
const RESOURCE_LIST_LIMIT = 500

export function createServer({ context, version, connectionString }: ServerDeps): Server {
  const server = new Server(
    { name: 'contextflo/postgres-mcp', version },
    {
      capabilities: { tools: {}, resources: {} },
      // The curated preamble from .contextflo/context.md — business definitions, caveats,
      // which tables to prefer — handed to the model once per session.
      ...(context.contextFile.current.preamble ? { instructions: context.contextFile.current.preamble } : {}),
    }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      QUERY_TOOL,
      LIST_TABLES_TOOL,
      GET_TABLE_CONTEXT_TOOL,
      ...(context.contextFile.writable ? [ADD_TABLE_CONTEXT_TOOL] : []),
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments

    switch (request.params.name) {
      case QUERY_TOOL.name:
        return runQueryTool(context, args)
      case LIST_TABLES_TOOL.name:
        return runListTablesTool(context, args)
      case GET_TABLE_CONTEXT_TOOL.name:
        return runGetTableContextTool(context, args)
      case ADD_TABLE_CONTEXT_TOOL.name:
        if (!context.contextFile.writable) throw new Error(`Unknown tool: ${request.params.name}`)
        return runAddTableContextTool(context, args)
      default:
        throw new Error(`Unknown tool: ${request.params.name}`)
    }
  })

  registerResources(server, context, connectionString)

  return server
}

/**
 * The archived server exposed table schemas as `postgres://<host>/<table>/schema`
 * resources and nothing else. Keeping those URIs means anything pinned to them still
 * resolves after swapping the package.
 *
 * They only ever listed the public schema; tables elsewhere get a schema-qualified URI
 * rather than being invisible. Note that most clients never fetch resources on their own,
 * which is why schema discovery lives in the tools — this is compatibility, not the path
 * we expect models to take.
 */
function registerResources(server: Server, context: ToolContext, connectionString: string): void {
  const baseUrl = buildResourceBaseUrl(connectionString)

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const { tables } = await listTables(context.database, { limit: RESOURCE_LIST_LIMIT })

    return {
      resources: tables.map((table) => ({
        uri: resourceUri(baseUrl, table.schema, table.name),
        mimeType: 'application/json',
        name: `"${table.fullyQualifiedName}" database schema`,
      })),
    }
  })

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { schema, table } = parseResourceUri(request.params.uri)
    const [described] = await getTableContext(context.database, [`${schema}.${table}`])

    if (!described) {
      throw new Error(`Unknown resource: ${request.params.uri}`)
    }

    // Their payload was `[{ column_name, data_type }]`; keep those keys and append ours.
    const columns = described.columns.map((column) => ({
      column_name: column.name,
      data_type: column.dataType,
      is_nullable: column.isNullable,
      description: column.description,
    }))

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: 'application/json',
          text: JSON.stringify(columns, null, 2),
        },
      ],
    }
  })
}

/**
 * `postgres://user@host:port/database/`, built from the parsed pieces rather than
 * `new URL(connectionString)`, which throws on `host=... dbname=...` strings and socket
 * paths. The password is never included.
 */
function buildResourceBaseUrl(connectionString: string): URL {
  const { host, port, database, user } = parseConnectionString(connectionString)

  let url: URL
  try {
    // A socket directory is not a hostname; the URI only needs to be stable, not dialable.
    url = new URL(`postgres://${host && !host.startsWith('/') ? host : 'localhost'}${port ? `:${port}` : ''}/`)
  } catch {
    url = new URL('postgres://localhost/')
  }

  if (user) url.username = encodeURIComponent(user)
  // Always a database segment, so parseResourceUri can tell it from a schema. The
  // trailing slash keeps `new URL(path, base)` from eating the last path segment.
  url.pathname = `/${encodeURIComponent(database || 'postgres')}/`
  return url
}

function resourceUri(baseUrl: URL, schema: string, table: string): string {
  const path = schema === 'public' ? `${table}/${SCHEMA_PATH}` : `${schema}/${table}/${SCHEMA_PATH}`
  return new URL(path, baseUrl).href
}

function parseResourceUri(uri: string): { schema: string; table: string } {
  const parts = new URL(uri).pathname.split('/').filter(Boolean)

  if (parts.pop() !== SCHEMA_PATH) {
    throw new Error(`Invalid resource URI: ${uri}`)
  }

  const table = parts.pop()
  if (!table) {
    throw new Error(`Invalid resource URI: ${uri}`)
  }

  // Anything left is the schema; the database name at the front is dropped, matching the
  // archived server's parsing, which only ever looked at the last two segments.
  const schema = parts.length > 1 ? parts[parts.length - 1]! : 'public'

  return { schema: decodeURIComponent(schema), table: decodeURIComponent(table) }
}
