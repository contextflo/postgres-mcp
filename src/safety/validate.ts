import { loadModule, parseSync } from 'libpg-query'
import { SafetyError, describeStatement } from './errors.js'
import { findFunctionNames, findStatementNodes } from './walk.js'

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
 * Throws {@link SafetyError} unless `sql` is a single read-only statement. Returns the
 * statement's parse tree, for checks that need the database (see ./functions.ts).
 *
 * Accepts: SELECT (including `WITH ... SELECT`, set operations, and subqueries), EXPLAIN
 * over an otherwise-accepted statement, and SHOW.
 */
export function validateReadOnlySql(sql: string): Record<string, unknown> {
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

  const statement = statements[0].stmt

  for (const name of findFunctionNames(statement)) {
    if (isDeniedFunction(name)) {
      throw new SafetyError(
        'FUNCTION_NOT_ALLOWED',
        `This server is read-only; ${name}() is not allowed because it can act outside the ` +
          'read-only transaction (another connection, the filesystem, other sessions, or a lock ' +
          'that outlives the query).'
      )
    }
  }

  return statement
}

/**
 * Functions a read-only SELECT can call that escape the read-only transaction. This is
 * defence in depth, not a boundary: user-defined and SECURITY DEFINER functions can do
 * the same things, and only a read-only role stops those. What it does is make the common
 * built-in escapes fail with a clear message instead of depending on the role.
 */
const DENIED_FUNCTIONS = new Set([
  // Run a SQL string the parser never sees.
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'cursor_to_xml',
  'cursor_to_xmlschema',
  'ts_stat',
  // Change settings; SET is rejected, so its function form is too.
  'set_config',
  // Act on other sessions or the server.
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_switch_wal',
  'pg_promote',
  'pg_create_restore_point',
  'pg_notify',
  'pg_log_backend_memory_contexts',
  // Write to the WAL even inside a read-only transaction.
  'pg_log_standby_snapshot',
  // Sequences. The read-only transaction refuses these too; this names them up front.
  'nextval',
  'setval',
  // Session-level advisory locks survive the ROLLBACK and stay on the pooled connection.
  'pg_advisory_lock',
  'pg_advisory_lock_shared',
  'pg_try_advisory_lock',
  'pg_try_advisory_lock_shared',
  // Server filesystem.
  'pg_read_file',
  'pg_read_binary_file',
  'pg_stat_file',
  'pg_file_write',
  'pg_file_unlink',
  'pg_file_rename',
  'lo_import',
  'lo_export',
])

/** Families matched by prefix. */
const DENIED_FUNCTION_PREFIXES = [
  // dblink opens a new connection, which is not read-only, and runs SQL the parser never sees.
  'dblink',
  // Directory listings of the server's filesystem.
  'pg_ls_',
  // Logical decoding. pg_logical_emit_message writes a message into the WAL, and so into
  // every change-data-capture stream, and Postgres allows it in a read-only transaction.
  // The slot functions consume or peek at changes.
  'pg_logical_',
  // Replication slots and origins: creating, copying, advancing, or dropping them changes
  // server state.
  'pg_create_logical_replication_slot',
  'pg_create_physical_replication_slot',
  'pg_copy_logical_replication_slot',
  'pg_copy_physical_replication_slot',
  'pg_replication_slot_advance',
  'pg_drop_replication_slot',
  'pg_replication_origin_',
  // Server-wide state: statistics resets, backups, and WAL replay on a standby.
  'pg_stat_reset',
  'pg_backup_',
  'pg_start_backup',
  'pg_stop_backup',
  'pg_wal_replay_',
]

function isDeniedFunction(name: string): boolean {
  return DENIED_FUNCTIONS.has(name) || DENIED_FUNCTION_PREFIXES.some((prefix) => name.startsWith(prefix))
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
