import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { getTableContext, type ColumnContext, type TableContext } from '../db/introspection.js'
import { notesForTable, preferCuratedDescription, type ContextDocument } from '../context/context-file.js'
import type { ToolContext } from './context.js'

export const GET_TABLE_CONTEXT_TOOL = {
  name: 'get_table_context',
  description:
    'Describe one or more tables: columns, types, nullability, primary keys, foreign key ' +
    'targets, and any curated descriptions. Pass every candidate table at once rather than ' +
    'calling repeatedly. Read this before writing SQL against a table you have not used yet.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tables: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Table names, ideally qualified as "schema.table". An unqualified name resolves ' +
          'against any readable schema.',
      },
    },
    required: ['tables'],
  },
}

export async function runGetTableContextTool(
  context: ToolContext,
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const requested = Array.isArray(args?.tables)
    ? args.tables.filter((name): name is string => typeof name === 'string' && name.trim() !== '')
    : []

  if (requested.length === 0) {
    return {
      content: [{ type: 'text', text: 'The "tables" argument is required: an array of table names.' }],
      isError: true,
    }
  }

  const [tables, document] = await Promise.all([
    getTableContext(context.database, requested),
    context.contextFile.refresh(),
  ])

  if (tables.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text:
            `None of these are readable tables: ${requested.join(', ')}. ` +
            'Use list_tables to see what exists — the name may be in a different schema, or the ' +
            'connected role may not have SELECT on it.',
        },
      ],
      isError: true,
    }
  }

  const rendered = tables.map((table) => renderTable(document, table)).join('\n\n')
  const missing = findMissing(requested, tables)

  const notice = missing.length > 0 ? `\n\nNot found: ${missing.join(', ')}.` : ''

  return { content: [{ type: 'text', text: rendered + notice }], isError: false }
}

function renderTable(document: ContextDocument, table: TableContext): string {
  const notes = notesForTable(document, table.fullyQualifiedName)
  const description = preferCuratedDescription(notes?.description, table.description)

  const heading = `## ${table.fullyQualifiedName} — ${table.kind}${formatRowCount(table.approximateRows)}`
  const lines = [heading]

  if (description) lines.push(description)

  lines.push('')
  for (const column of table.columns) {
    lines.push(renderColumn(column, notes?.columns.get(column.name.toLowerCase())))
  }

  return lines.join('\n')
}

function renderColumn(column: ColumnContext, curated: string | undefined): string {
  const facts = [column.dataType]

  if (column.isPrimaryKey) facts.push('primary key')
  else if (!column.isNullable) facts.push('not null')

  if (column.references) facts.push(`→ ${column.references}`)
  if (column.defaultValue) facts.push(`default ${column.defaultValue}`)

  const description = preferCuratedDescription(curated, column.description)

  return `- ${column.name} — ${facts.join(', ')}${description ? ` — ${description}` : ''}`
}

/** `reltuples` is a planner estimate, so say so rather than implying an exact count. */
function formatRowCount(approximateRows: number | null): string {
  if (approximateRows === null || approximateRows <= 0) return ''
  return `, ~${approximateRows.toLocaleString('en-US')} rows`
}

function findMissing(requested: string[], found: TableContext[]): string[] {
  const resolved = new Set<string>()
  for (const table of found) {
    resolved.add(table.fullyQualifiedName.toLowerCase())
    resolved.add(table.fullyQualifiedName.split('.').pop()!.toLowerCase())
  }

  return requested.filter((name) => !resolved.has(name.toLowerCase()))
}
