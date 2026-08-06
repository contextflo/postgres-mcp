import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Database } from './db/pool.js'
import { QUERY_TOOL, runQueryTool } from './tools/query.js'

export interface ServerDeps {
  database: Database
  maxRows: number
  version: string
}

export function createServer({ database, maxRows, version }: ServerDeps): Server {
  const server = new Server(
    { name: 'contextflo/postgres-mcp', version },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [QUERY_TOOL] }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== QUERY_TOOL.name) {
      throw new Error(`Unknown tool: ${request.params.name}`)
    }

    return runQueryTool(database, { maxRows }, request.params.arguments)
  })

  return server
}
