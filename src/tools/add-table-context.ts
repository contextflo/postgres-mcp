import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { getTableContext } from '../db/introspection.js'
import type { ToolContext } from './context.js'

/**
 * Lets the agent write down what it learned the hard way — `amount` is in cents, `status`
 * also holds 'void' on pre-2022 rows, `deleted_at IS NULL` is required everywhere — so the
 * next session starts knowing it instead of rediscovering it.
 *
 * The database stays read-only; this writes only the local context file. Notes are
 * appended, never substituted for what a person wrote, and land in a file that lives in
 * the repo, so a human reviews them in a diff like any other change.
 */

const MAX_NOTE_CHARS = 1_000
const MAX_COLUMNS_PER_CALL = 50

export const ADD_TABLE_CONTEXT_TOOL = {
  name: 'add_table_context',
  description:
    'Record a durable fact about a table or its columns that you learned from working with the ' +
    'data and that someone writing SQL against it later would otherwise get wrong: units ' +
    '("amount is in cents"), undocumented values ("status also contains \'void\' for rows before ' +
    '2022"), required filters ("exclude rows where deleted_at is set"), or which table is the ' +
    'source of truth. The note is appended to the team\'s context file and shown by ' +
    'get_table_context from then on. Do not record what the schema already says (types, ' +
    'nullability, keys), one-off query results, or anything you have not verified against the data.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      table: {
        type: 'string',
        description: 'The table, ideally qualified as "schema.table".',
      },
      note: {
        type: 'string',
        description: 'Optional. One or two sentences about the table as a whole.',
      },
      columns: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Optional. Column name → one or two sentences about that column.',
      },
    },
    required: ['table'],
  },
}

export async function runAddTableContextTool(
  context: ToolContext,
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const table = typeof args?.table === 'string' ? args.table.trim() : ''
  const note = typeof args?.note === 'string' && args.note.trim() !== '' ? args.note.trim() : undefined
  const rawColumns = isStringRecord(args?.columns) ? args.columns : {}
  const columnEntries = Object.entries(rawColumns).filter(([, value]) => value.trim() !== '')

  if (table === '') return toolError('The "table" argument is required.')
  if (args?.columns !== undefined && !isStringRecord(args.columns)) {
    return toolError('"columns" must be an object mapping column names to notes, e.g. {"amount": "In cents."}.')
  }
  if (!note && columnEntries.length === 0) {
    return toolError('Nothing to add: pass a "note" for the table, "columns" notes, or both.')
  }
  if (columnEntries.length > MAX_COLUMNS_PER_CALL) {
    return toolError(`At most ${MAX_COLUMNS_PER_CALL} column notes per call.`)
  }
  const tooLong = [note, ...columnEntries.map(([, value]) => value)].some(
    (text) => text !== undefined && text.length > MAX_NOTE_CHARS
  )
  if (tooLong) {
    return toolError(`Keep each note under ${MAX_NOTE_CHARS} characters — a sentence or two.`)
  }

  // Only tables that exist and are readable, so a guessed name cannot become a heading.
  const matches = await getTableContext(context.database, [table])
  if (matches.length === 0) {
    return toolError(`No readable table named ${table}. Use list_tables to find the exact name.`)
  }
  if (matches.length > 1) {
    return toolError(
      `"${table}" matches more than one table: ${matches.map((match) => match.fullyQualifiedName).join(', ')}. ` +
        'Pass the schema-qualified name.'
    )
  }

  const resolved = matches[0]!
  const actualColumns = new Map(resolved.columns.map((column) => [column.name.toLowerCase(), column.name]))
  const unknown = columnEntries.filter(([name]) => !actualColumns.has(name.toLowerCase())).map(([name]) => name)
  if (unknown.length > 0) {
    return toolError(
      `${resolved.fullyQualifiedName} has no column ${unknown.join(', ')}. ` +
        'Use get_table_context to see its columns.'
    )
  }

  if (!context.contextFile.writable || context.contextFile.path === null) {
    return toolError('Context writes are turned off on this server (--no-context-writes).')
  }

  const columns = Object.fromEntries(
    columnEntries.map(([name, value]) => [actualColumns.get(name.toLowerCase())!, value])
  )
  await context.contextFile.addNotes(resolved.fullyQualifiedName, { note, columns })

  const added = [note && 'the table note', columnEntries.length > 0 && `${columnEntries.length} column note(s)`]
    .filter(Boolean)
    .join(' and ')

  return {
    content: [
      {
        type: 'text',
        text: `Added ${added} for ${resolved.fullyQualifiedName} to ${context.contextFile.path}.`,
      },
    ],
    isError: false,
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  )
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}
