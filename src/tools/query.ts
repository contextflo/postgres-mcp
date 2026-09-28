import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describeQueryError } from '../db/errors.js'
import { SafetyError } from '../safety/errors.js'
import { validateReadOnlySql } from '../safety/validate.js'
import { findFunctionCalls } from '../safety/walk.js'
import type { ToolContext } from './context.js'

/**
 * Name, argument, and result shape match the archived
 * `@modelcontextprotocol/server-postgres` so existing prompts and configs keep working
 * when someone swaps the package name.
 */
export const QUERY_TOOL = {
  name: 'query',
  description:
    'Run a read-only SQL query against the Postgres database. Accepts a single SELECT ' +
    '(including WITH ... SELECT), EXPLAIN, or SHOW statement. Writes, DDL, multiple ' +
    'statements, and SET are rejected. information_schema and pg_catalog are readable, so ' +
    'schema questions this server has no tool for can be answered with plain SQL.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      sql: {
        type: 'string',
        description: 'A single read-only SQL statement.',
      },
    },
    required: ['sql'],
  },
}

export async function runQueryTool(
  context: ToolContext,
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sql = args?.sql

  if (typeof sql !== 'string' || sql.trim() === '') {
    return toolError('The "sql" argument is required and must be a non-empty string.')
  }

  try {
    const statement = validateReadOnlySql(sql)
    // Reads the function catalog on first use, so this can fail on connecting too.
    await context.functions.check([...findFunctionCalls(statement)])
  } catch (error) {
    const rejected = error instanceof SafetyError
    const message = error instanceof Error ? error.message : String(error)
    context.log.record({ sql, outcome: rejected ? 'rejected' : 'error', message })
    return toolError(message)
  }

  const startedAt = Date.now()

  let result
  try {
    result = await context.database.runReadOnly(sql, context.maxRows)
  } catch (error) {
    const message = describeQueryError(error)
    context.log.record({ sql, outcome: 'error', durationMs: Date.now() - startedAt, message })
    return toolError(message)
  }

  context.log.record({
    sql,
    outcome: 'ok',
    rowCount: result.rows.length,
    durationMs: Date.now() - startedAt,
  })

  const rendered = renderRows(result.rows, context.maxOutputChars)
  const content: CallToolResult['content'] = [{ type: 'text', text: rendered.text }]

  const notes: string[] = []
  if (rendered.shown < result.rows.length) {
    notes.push(
      `Output truncated to ${rendered.shown} of ${result.rows.length} rows to stay under ` +
        `${context.maxOutputChars.toLocaleString('en-US')} characters. Select fewer columns, add LIMIT, ` +
        'or aggregate. --max-output-chars raises the budget.'
    )
  }
  if (result.truncated) {
    notes.push(
      `Results truncated to ${context.maxRows} rows. Add LIMIT/aggregation to narrow the query, ` +
        'or start the server with --max-rows to raise the cap.'
    )
  }
  if (rendered.cellsShortened) {
    notes.push(`Values longer than ${MAX_CELL_CHARS.toLocaleString('en-US')} characters were shortened.`)
  }
  if (notes.length > 0) content.push({ type: 'text', text: notes.join('\n') })

  return { content, isError: false }
}

/**
 * A JSON array with one row per line: still valid JSON for anything that parses it, but
 * without the indentation that roughly doubled the token cost of every result.
 *
 * Rows are added until the character budget is spent — a `SELECT *` over a table with a
 * wide jsonb column should not blow the model's context window on its first try.
 */
function renderRows(
  rows: Record<string, unknown>[],
  maxChars: number
): { text: string; shown: number; cellsShortened: boolean } {
  const state = { cellsShortened: false }
  const lines: string[] = []
  let used = 2

  for (const row of rows) {
    const line = JSON.stringify(toJsonSafe(row, state))
    // Always show at least one row, even if it alone is over budget.
    if (lines.length > 0 && used + line.length + 2 > maxChars) break
    lines.push(line)
    used += line.length + 2
  }

  const text = lines.length === 0 ? '[]' : `[\n${lines.join(',\n')}\n]`
  return { text, shown: lines.length, cellsShortened: state.cellsShortened }
}

function toolError(message: string): CallToolResult {
  // Returned as a tool error rather than thrown so the model sees it and can correct the
  // query itself, instead of the client surfacing a protocol-level failure.
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Bytes rendered as `{"type":"Buffer","data":[…]}` are unreadable and expensive in tokens. */
const MAX_RENDERED_BYTES = 32
/** One long text or jsonb value should not crowd every other row out of the budget. */
const MAX_CELL_CHARS = 2_000

function toJsonSafe(value: unknown, state: { cellsShortened: boolean }, isRow = true): unknown {
  if (Buffer.isBuffer(value)) {
    return renderBytes(value)
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'string') {
    return shorten(value, value, state)
  }

  if (isRow && value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonSafe(item, state, false)]))
  }

  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    // An array or jsonb value is one cell: keep it structured when it fits, shorten its
    // serialised form when it does not.
    const serialised = JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item
    )
    return shorten(serialised, value, state)
  }

  return value
}

function shorten(serialised: string, original: unknown, state: { cellsShortened: boolean }): unknown {
  if (serialised.length <= MAX_CELL_CHARS) return original
  state.cellsShortened = true
  return `${serialised.slice(0, MAX_CELL_CHARS)}… (${serialised.length.toLocaleString('en-US')} chars)`
}

function renderBytes(value: Buffer): string {
  const hex = value.subarray(0, MAX_RENDERED_BYTES).toString('hex')
  return value.length > MAX_RENDERED_BYTES ? `\\x${hex}… (${value.length} bytes)` : `\\x${hex}`
}
