import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { listTables } from '../db/introspection.js'
import { notesForTable, preferCuratedDescription } from '../context/context-file.js'
import type { ToolContext } from './context.js'

export const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500

export const LIST_TABLES_TOOL = {
  name: 'list_tables',
  description:
    'List the tables, views, and materialized views this connection can read, with their ' +
    'descriptions. Call this first when you need to know what data exists — do not guess ' +
    'table names. Pass `pattern` to narrow by a word appearing anywhere in the table name ' +
    'or its description; call it again with a different word to try a synonym. For anything ' +
    'more specific — searching column names, types, or comments — query information_schema ' +
    'and pg_catalog directly with the query tool, they are ordinary tables.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      pattern: {
        type: 'string',
        description:
          'Optional. Case-insensitive substring matched anywhere in the table name, the ' +
          'qualified schema.table name, or the table description. Omit to list everything.',
      },
      schema: {
        type: 'string',
        description: 'Optional. Restrict to one schema, e.g. "analytics".',
      },
      limit: {
        type: 'integer',
        description: `Optional. Maximum tables to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).`,
      },
    },
  },
}

export async function runListTablesTool(
  context: ToolContext,
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const pattern = optionalString(args?.pattern)
  const schema = optionalString(args?.schema)
  const limit = Math.min(Math.max(Number(args?.limit) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT)

  const [result, document] = await Promise.all([
    listTables(context.database, { pattern, schema, limit }),
    context.contextFile.refresh(),
  ])
  // Several clients never show the model the server's instructions, so the team's
  // business definitions also ride along with the tool the model is told to call first.
  const preamble = document.preamble ? `Business context from the team:\n\n${document.preamble}\n\n---\n\n` : ''

  if (result.tables.length === 0) {
    return {
      content: [{ type: 'text', text: preamble + describeEmptyResult(pattern, schema) }],
      isError: false,
    }
  }

  const lines = result.tables.map((table) => {
    const curated = notesForTable(document, table.fullyQualifiedName)?.description
    const description = preferCuratedDescription(curated, table.description)

    return `${table.fullyQualifiedName} — ${table.kind}${description ? ` — ${description}` : ''}`
  })

  const header =
    result.totalMatches > result.tables.length
      ? `Showing ${result.tables.length} of ${result.totalMatches} matching tables. ` +
        'Narrow with `pattern` or `schema`, or raise `limit`.'
      : `${result.tables.length} table${result.tables.length === 1 ? '' : 's'}.`

  return {
    content: [{ type: 'text', text: `${preamble}${header}\n\n${lines.join('\n')}` }],
    isError: false,
  }
}

function describeEmptyResult(pattern: string | undefined, schema: string | undefined): string {
  if (!pattern && !schema) {
    return (
      'No readable tables found. The connected role may not have SELECT on anything, or the ' +
      'database may be empty.'
    )
  }

  const filters = [pattern && `pattern "${pattern}"`, schema && `schema "${schema}"`]
    .filter(Boolean)
    .join(' and ')

  return (
    `No tables matched ${filters}. Try a synonym, drop the filters to see everything, or search ` +
    'column names directly, e.g. ' +
    "SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE column_name ILIKE '%term%'"
  )
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
