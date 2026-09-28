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
 * what makes this layer hold behind a pooler: PgBouncer refuses unknown startup
 * parameters outright, so on that error we reconnect without them rather than fail. The
 * statement timeout is set with `SET LOCAL` inside each transaction for the same reason.
 * `SET`/`RESET` are rejected by the parser layer, so a session cannot turn either back off.
 */

const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 60_000
/** Client-side backstop in case the server never answers; the server-side timeout fires first. */
const CLIENT_TIMEOUT_GRACE_MS = 5_000

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

/** What the tools need from a database. Both {@link Database} and {@link LazyDatabase} provide it. */
export interface Queryable {
  runReadOnly(sql: string, maxRows: number): Promise<ReadOnlyResult>
  internalQuery<T extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<T[]>
}

export class Database implements Queryable {
  private readonly pool: pg.Pool
  private readonly statementTimeoutMs: number
  /** True when startup options were refused and we connected without them. */
  readonly behindPooler: boolean

  private constructor(pool: pg.Pool, statementTimeoutMs: number, behindPooler: boolean) {
    this.pool = pool
    this.statementTimeoutMs = statementTimeoutMs
    this.behindPooler = behindPooler
  }

  static async connect(options: DatabaseOptions): Promise<Database> {
    try {
      return await Database.open(options, true)
    } catch (error) {
      if (!isUnsupportedStartupParameter(error)) throw new Error(describeConnectionError(error))
    }

    console.error(
      '[postgres-mcp] the server refused startup parameters, which usually means PgBouncer or another ' +
        'pooler. Reconnecting without them: every statement still runs in BEGIN READ ONLY with its ' +
        'own statement timeout.'
    )

    try {
      return await Database.open(options, false)
    } catch (error) {
      throw new Error(describeConnectionError(error))
    }
  }

  private static async open(options: DatabaseOptions, withStartupOptions: boolean): Promise<Database> {
    const pool = new pg.Pool(buildPoolConfig(options, withStartupOptions))

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
      throw error
    }

    return new Database(pool, options.statementTimeoutMs, !withStartupOptions)
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
      // SET LOCAL rather than a startup option, so the timeout holds behind a pooler too.
      await client.query({
        text: "SELECT set_config('statement_timeout', $1, true)",
        values: [String(this.statementTimeoutMs)],
        queryMode: 'extended',
      })

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

      if (info.default_read_only !== 'on' && !this.behindPooler) {
        console.error(
          '[postgres-mcp] default_transaction_read_only did not take effect on this connection ' +
            '(a connection pooler may be dropping startup options). Statements still run inside an ' +
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

/** PgBouncer: `unsupported startup parameter: options` (or `...in options: ...`). */
function isUnsupportedStartupParameter(error: unknown): boolean {
  return /unsupported startup parameter/i.test((error as { message?: string })?.message ?? '')
}

function buildPoolConfig(options: DatabaseOptions, withStartupOptions: boolean): pg.PoolConfig {
  // Parse here rather than handing `connectionString` to pg: pg re-parses it and
  // Object.assigns the result over the rest of the config, which would drop our options.
  const parsed = parseConnectionString(options.connectionString)

  const hardening = [
    '-c default_transaction_read_only=on',
    `-c statement_timeout=${options.statementTimeoutMs}`,
    `-c idle_in_transaction_session_timeout=${DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS}`,
  ].join(' ')

  const config: pg.PoolConfig = {
    max: 5,
    idleTimeoutMillis: 30_000,
    // Client-side only — never sent as a startup parameter, so safe behind a pooler.
    query_timeout: options.statementTimeoutMs + CLIENT_TIMEOUT_GRACE_MS,
  }

  if (withStartupOptions) {
    // Keep anything the user set (including their own `options`) and append ours last so
    // the read-only settings win.
    config.options = parsed.options ? `${parsed.options} ${hardening}` : hardening
  } else if (parsed.options) {
    config.options = parsed.options
  }

  if (parsed.host) config.host = parsed.host
  if (parsed.port) config.port = Number(parsed.port)
  if (parsed.database) config.database = parsed.database
  if (parsed.user) config.user = parsed.user
  if (parsed.password) config.password = parsed.password
  if (parsed.ssl !== undefined) config.ssl = parsed.ssl as pg.PoolConfig['ssl']

  return config
}

/**
 * A database the server connects to on first use, not at startup. The server can then
 * start, and list its tools, before a database is reachable or even configured; a
 * directory like Glama or the Docker catalog introspects it that way. A failed connection
 * is reported on the tool call that needed it and retried on the next one.
 */
export class LazyDatabase implements Queryable {
  private readonly options: DatabaseOptions | null
  private connecting: Promise<Database> | null = null

  /** `options` is null when no connection string was given; every call then says so. */
  constructor(options: DatabaseOptions | null) {
    this.options = options
  }

  async runReadOnly(sql: string, maxRows: number): Promise<ReadOnlyResult> {
    return (await this.connected()).runReadOnly(sql, maxRows)
  }

  async internalQuery<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    return (await this.connected()).internalQuery<T>(text, values)
  }

  async close(): Promise<void> {
    const connecting = this.connecting
    if (connecting === null) return
    await (await connecting.catch(() => null))?.close()
  }

  private connected(): Promise<Database> {
    if (this.options === null) {
      return Promise.reject(
        new Error(
          'No database is configured. Set DATABASE_URL in the environment or in .env, or pass a ' +
            'connection string, then restart the server.'
        )
      )
    }

    this.connecting ??= Database.connect(this.options).then(
      (database) => {
        void database.warnOnWeakSetup()
        return database
      },
      (error: unknown) => {
        // Let the next call try again: the database may just have been down.
        this.connecting = null
        throw new Error(`Could not connect to Postgres: ${error instanceof Error ? error.message : String(error)}`)
      }
    )
    return this.connecting
  }
}
