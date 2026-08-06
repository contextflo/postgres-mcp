import { loadModule, parseSync } from 'libpg-query'
import { SafetyError, describeStatement } from './errors.js'
import { findStatementNodes } from './walk.js'

/**
 * Layer 3 of four: the statement allowlist, enforced with the real Postgres C parser
 * (libpg-query, compiled to WASM) rather than a JavaScript SQL dialect approximation.
 *
 * The other three layers live outside this file and each stop the archived server's CVE
 * on their own: the extended query protocol (src/db/pool.ts), the connection's
 * `default_transaction_read_only` (src/db/pool.ts), and a read-only database role (the
 * documented setup). This layer exists to turn "the database refused it" into a clear,
 * early, actionable error — and to catch the cases the transaction alone would not,
 * like `SELECT ... INTO`.
 */

/** Anything not in this set is rejected. Allowlist, so new node types fail closed. */
const ALLOWED_STATEMENTS = new Set(['SelectStmt', 'ExplainStmt', 'VariableShowStmt'])

let parserReady: Promise<void> | undefined

/**
 * Loads the WASM parser. Must be awaited once before {@link validateReadOnlySql}, which
 * is synchronous so it can be used freely from anywhere.
 */
export function ensureParserReady(): Promise<void> {
  parserReady ??= loadModule()
  return parserReady
}

interface RawStatement {
  stmt?: Record<string, unknown>
}

/**
 * Throws {@link SafetyError} unless `sql` is a single read-only statement.
 *
 * Accepts: SELECT (including `WITH ... SELECT`, set operations, and subqueries), EXPLAIN
 * over an otherwise-accepted statement, and SHOW.
 */
export function validateReadOnlySql(sql: string): void {
  if (sql.trim() === '') {
    // libpg-query reports this as a parse error; EMPTY_STATEMENT is the clearer contract.
    throw new SafetyError('EMPTY_STATEMENT', 'No SQL statement found. Provide a single SELECT, EXPLAIN, or SHOW.')
  }

  let parsed: { stmts?: RawStatement[] }

  try {
    parsed = parseSync(sql)
  } catch (error) {
    throw new SafetyError('PARSE_ERROR', formatParseError(error))
  }

  const statements = parsed.stmts ?? []

  if (statements.length === 0 || !statements[0]?.stmt) {
    throw new SafetyError('EMPTY_STATEMENT', 'No SQL statement found. Provide a single SELECT, EXPLAIN, or SHOW.')
  }

  if (statements.length > 1) {
    // The wire protocol rejects this too (see src/db/pool.ts) — this is the friendly version.
    throw new SafetyError(
      'MULTIPLE_STATEMENTS',
      `Only one statement per call is allowed; received ${statements.length}. ` +
        'Send each statement as a separate query call.'
    )
  }

  for (const node of findStatementNodes(statements[0].stmt)) {
    if (!ALLOWED_STATEMENTS.has(node.name)) {
      throw new SafetyError(
        'STATEMENT_NOT_ALLOWED',
        `This server is read-only; ${describeStatement(node.name)} is not allowed. ` +
          'Only SELECT, EXPLAIN, and SHOW statements can run.'
      )
    }

    if (node.name === 'SelectStmt') {
      checkSelect(node.fields)
    }
  }
}

function checkSelect(fields: Record<string, unknown>): void {
  if (fields.intoClause) {
    // `SELECT ... INTO new_table` is a SelectStmt but creates a table.
    throw new SafetyError(
      'SELECT_INTO',
      'SELECT ... INTO creates a table, which this read-only server does not allow. ' +
        'Drop the INTO clause to return the rows instead.'
    )
  }

  if (fields.lockingClause) {
    // FOR UPDATE/SHARE takes row locks; the read-only transaction would reject it with a
    // less obvious error, so name it here.
    throw new SafetyError(
      'LOCKING_CLAUSE',
      'Row locking (FOR UPDATE / FOR SHARE) is not available on a read-only connection. ' +
        'Remove the locking clause.'
    )
  }
}

interface SqlErrorLike {
  message?: string
  sqlDetails?: { cursorPosition?: number }
}

function formatParseError(error: unknown): string {
  const details = error as SqlErrorLike
  const message = details?.message ?? 'Could not parse SQL'
  const position = details?.sqlDetails?.cursorPosition

  return position && position > 0 ? `${message} (at position ${position})` : message
}
