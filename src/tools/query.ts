import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describeQueryError } from '../db/errors.js'
import { SafetyError } from '../safety/errors.js'
import { validateReadOnlySql } from '../safety/validate.js'
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
    validateReadOnlySql(sql)
  } catch (error) {
    if (error instanceof SafetyError) {
      context.log.record({ sql, outcome: 'rejected', message: error.message })
      return toolError(error.message)
    }
    throw error
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

  const content: CallToolResult['content'] = [
    { type: 'text', text: JSON.stringify(result.rows.map(toJsonSafe), null, 2) },
  ]

  if (result.truncated) {
    content.push({
      type: 'text',
      text:
        `Results truncated to ${context.maxRows} rows. Add LIMIT/aggregation to narrow the query, ` +
        'or start the server with --max-rows to raise the cap.',
    })
  }

  return { content, isError: false }
}

function toolError(message: string): CallToolResult {
  // Returned as a tool error rather than thrown so the model sees it and can correct the
  // query itself, instead of the client surfacing a protocol-level failure.
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Bytes rendered as `{"type":"Buffer","data":[…]}` are unreadable and expensive in tokens. */
const MAX_RENDERED_BYTES = 32

function toJsonSafe(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    const hex = value.subarray(0, MAX_RENDERED_BYTES).toString('hex')
    return value.length > MAX_RENDERED_BYTES
      ? `\\x${hex}… (${value.length} bytes)`
      : `\\x${hex}`
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (Array.isArray(value)) {
    return value.map(toJsonSafe)
  }

  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonSafe(item)]))
  }

  return value
}
