import pg from 'pg'
import Cursor from 'pg-cursor'
import { parse as parseConnectionString } from 'pg-connection-string'
import { describeConnectionError } from './errors.js'

/**
 * The single place user-supplied SQL reaches the database, and the home of safety layers
 * 1 and 2.
 *
 * ## Layer 1 — extended query protocol
 *
 * The archived `@modelcontextprotocol/server-postgres` ran `client.query(sql)` with a
 * bare string. node-postgres only prepares a statement when
 * `Query.requiresPreparation()` is true, and with no values that is false — so the driver
 * sends a *simple* Query message, which permits multiple statements. That is what let
 * `COMMIT; DROP TABLE x; BEGIN;` escape their read-only transaction.
 *
 * So: user SQL goes through `pg-cursor`, which always issues Parse/Bind/Describe/Execute,
 * and Postgres itself rejects multi-statement input at Parse time. Internal queries pass
 * `queryMode: 'extended'` explicitly.
 *
 * Note that `values: []` does NOT force the extended protocol — `requiresPreparation()`
 * checks `values.length > 0`. Anything added here must use a cursor or `queryMode`.
 *
 * ## Layer 2 — connection-level read-only
 *
 * `default_transaction_read_only=on` is set in the startup packet, and every statement
 * additionally runs inside an explicit `BEGIN READ ONLY`. The explicit transaction is
 * what makes this layer hold even when a pooler strips startup options. `SET`/`RESET`
 * are rejected by the parser layer, so a session cannot turn either back off.
 */

const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 60_000

// node-postgres turns date and timestamp values into JS Dates in the *MCP process's*
// timezone, and JSON renders those in UTC — so `2024-01-15` came out as
// `2024-01-14T18:30:00.000Z` for anyone east of Greenwich. Hand the model exactly what
// Postgres sent instead. Intervals too, which otherwise become `{ "days": 1 }` objects.
const DATE_LIKE_TYPES = [1082 /* date */, 1114 /* timestamp */, 1184 /* timestamptz */, 1186 /* interval */]
const DATE_LIKE_ARRAY_TYPES = [1182, 1115, 1185, 1187]
const TEXT_ARRAY_TYPE: number = 1009

for (const oid of DATE_LIKE_TYPES) pg.types.setTypeParser(oid, (value: string) => value)
for (const oid of DATE_LIKE_ARRAY_TYPES) pg.types.setTypeParser(oid, pg.types.getTypeParser(TEXT_ARRAY_TYPE))

export interface DatabaseOptions {
  connectionString: string
  statementTimeoutMs: number
}

export interface ReadOnlyResult {
  rows: Record<string, unknown>[]
  /** True when the query produced more rows than the cap and the extras were dropped. */
  truncated: boolean
}

export class Database {
  private readonly pool: pg.Pool

  private constructor(pool: pg.Pool) {
    this.pool = pool
  }

  static async connect(options: DatabaseOptions): Promise<Database> {
    const pool = new pg.Pool(buildPoolConfig(options))

    // pg emits 'error' asynchronously when an idle connection is reaped server-side.
    // Without a listener node re-throws it as an uncaught exception and kills the server.
    pool.on('error', (error) => {
      console.error(`[postgres-mcp] pool error: ${describeConnectionError(error)}`)
    })

    try {
      const client = await pool.connect()
      client.release()
    } catch (error) {
      await pool.end().catch(() => {})
      throw new Error(describeConnectionError(error))
    }

    return new Database(pool)
  }

  /**
   * Runs a single already-validated read-only statement, reading at most `maxRows`.
   *
   * Reads `maxRows + 1` so truncation is detectable rather than silent.
   */
  async runReadOnly(sql: string, maxRows: number): Promise<ReadOnlyResult> {
    const client = await this.pool.connect()

    try {
      await client.query({ text: 'BEGIN READ ONLY', queryMode: 'extended' })

      const cursor = client.query(new Cursor(sql))
      try {
        const rows = (await cursor.read(maxRows + 1)) as Record<string, unknown>[]
        const truncated = rows.length > maxRows

        return { rows: truncated ? rows.slice(0, maxRows) : rows, truncated }
      } finally {
        await cursor.close().catch(() => {})
      }
    } finally {
      // Always ROLLBACK, never COMMIT. Beyond discarding the transaction, this undoes any
      // GUC change made inside it (SET is transactional), so a statement cannot leave a
      // pooled connection in a weakened state for whoever gets it next.
      await client.query({ text: 'ROLLBACK', queryMode: 'extended' }).catch((error: unknown) => {
        console.error(`[postgres-mcp] could not roll back: ${describeConnectionError(error)}`)
      })
      client.release()
    }
  }

  /**
   * For this server's own introspection queries — never for user input. `queryMode` is
   * mandatory here for the reason described at the top of this file.
   */
  async internalQuery<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>({ text, values, queryMode: 'extended' })
    return result.rows
  }

  /**
   * Layer 4 is a database role, not code — but connecting as a superuser silently
   * defeats it, so say so. Also confirms the startup options actually landed, which a
   * connection pooler in front of Postgres may prevent.
   */
  async warnOnWeakSetup(): Promise<void> {
    try {
      const rows = await this.internalQuery<{
        role: string
        is_superuser: boolean
        bypasses_rls: boolean
        default_read_only: string
      }>(
        `SELECT rolname AS role,
                rolsuper AS is_superuser,
                rolbypassrls AS bypasses_rls,
                current_setting('default_transaction_read_only') AS default_read_only
           FROM pg_roles
          WHERE rolname = current_user`
      )

      const info = rows[0]
      if (!info) return

      if (info.is_superuser || info.bypasses_rls) {
        console.error(
          `[postgres-mcp] connected as "${info.role}", which is a superuser or bypasses RLS. ` +
            'Queries are still read-only, but the recommended setup is a dedicated read-only role ' +
            'so the database enforces it independently of this server. See the README.'
        )
      }

      if (info.default_read_only !== 'on') {
        console.error(
          '[postgres-mcp] default_transaction_read_only did not take effect on this connection ' +
            '(a connection pooler may be stripping startup options). Statements still run inside an ' +
            'explicit READ ONLY transaction, so writes remain blocked.'
        )
      }
    } catch (error) {
      // A restricted role may not be able to read pg_roles. That is fine — it is a
      // diagnostic, not a safety layer.
      console.error(`[postgres-mcp] skipped setup check: ${describeConnectionError(error)}`)
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

function buildPoolConfig(options: DatabaseOptions): pg.PoolConfig {
  // Parse here rather than handing `connectionString` to pg: pg re-parses it and
  // Object.assigns the result over the rest of the config, which would drop our options.
  const parsed = parseConnectionString(options.connectionString)

  const hardening = [
    '-c default_transaction_read_only=on',
    `-c statement_timeout=${options.statementTimeoutMs}`,
    `-c idle_in_transaction_session_timeout=${DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS}`,
  ].join(' ')

  const config: pg.PoolConfig = {
    // Keep anything the user set (including their own `options`) and append ours last so
    // the read-only settings win.
    options: parsed.options ? `${parsed.options} ${hardening}` : hardening,
    max: 5,
    idleTimeoutMillis: 30_000,
    statement_timeout: options.statementTimeoutMs,
  }

  if (parsed.host) config.host = parsed.host
  if (parsed.port) config.port = Number(parsed.port)
  if (parsed.database) config.database = parsed.database
  if (parsed.user) config.user = parsed.user
  if (parsed.password) config.password = parsed.password
  if (parsed.ssl !== undefined) config.ssl = parsed.ssl as pg.PoolConfig['ssl']

  return config
}
