import type { Queryable } from '../db/pool.js'
import { SafetyError } from './errors.js'
import type { FunctionCall } from './walk.js'

/**
 * Functions are allowed by what Postgres says they do, not by a list of names to refuse.
 *
 * This is an analysis tool. Postgres labels every function immutable, stable, or
 * volatile, and only volatile ones can have side effects: every escape found so far
 * (pg_logical_emit_message writing the WAL, pg_stat_reset, dblink, nextval) is volatile.
 * So a volatile function is refused unless it is on the short list below, and anything
 * Postgres adds in a future release is refused until someone decides otherwise.
 *
 * SECURITY DEFINER functions run with their owner's privileges, so they are refused
 * whatever their label. What this cannot catch is a user-defined function declared
 * STABLE that writes anyway; a read-only role is what stops that.
 */

/**
 * Volatile, but read-only and useful for analysis. These name pg_catalog's own functions:
 * a user-defined `public.random()` shares the name, not the behaviour, so it is not covered.
 */
const VOLATILE_ALLOWLIST = new Set([
  'random',
  'random_normal',
  'array_sample',
  'array_shuffle',
  'gen_random_uuid',
  'uuidv4',
  'uuidv7',
  'clock_timestamp',
  'timeofday',
  'pg_relation_size',
  'pg_total_relation_size',
  'pg_table_size',
  'pg_indexes_size',
  'pg_database_size',
  'pg_tablespace_size',
  'pg_partition_tree',
  'pg_partition_ancestors',
])

/** How often an unknown name may trigger a reload, for functions created after startup. */
const RELOAD_INTERVAL_MS = 30_000

export interface FunctionEntry {
  schema: string
  name: string
  /** pg_proc.provolatile: i(mmutable), s(table), v(olatile). */
  volatility: 'i' | 's' | 'v'
  securityDefiner: boolean
}

export class FunctionPolicy {
  private byName = new Map<string, FunctionEntry[]>()
  private loadedAt = 0
  private readonly load: (() => Promise<FunctionEntry[]>) | null

  private constructor(load: (() => Promise<FunctionEntry[]>) | null) {
    this.load = load
  }

  /**
   * Reads every function the connected role can see from pg_proc, on the first check
   * rather than now, so the server can start before the database is reachable.
   */
  static fromDatabase(database: Queryable): FunctionPolicy {
    const policy = new FunctionPolicy(async () =>
      (
        await database.internalQuery<{ schema: string; name: string; volatility: 'i' | 's' | 'v'; security_definer: boolean }>(
          `SELECT n.nspname AS schema, p.proname AS name, p.provolatile AS volatility, p.prosecdef AS security_definer
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE has_schema_privilege(n.oid, 'USAGE')`
        )
      ).map((row) => ({ schema: row.schema, name: row.name, volatility: row.volatility, securityDefiner: row.security_definer }))
    )
    return policy
  }

  /** A fixed catalog, for tests. */
  static fromEntries(entries: FunctionEntry[]): FunctionPolicy {
    const policy = new FunctionPolicy(null)
    policy.index(entries)
    return policy
  }

  /**
   * Throws {@link SafetyError} for the first call that is not allowed. A name the
   * catalog does not know triggers one reload, in case the function was created after
   * the server started.
   */
  async check(calls: FunctionCall[]): Promise<void> {
    if (calls.length === 0) return
    if (this.loadedAt === 0) {
      await this.reload()
    } else if (calls.some((call) => this.candidates(call).length === 0) && this.canReload()) {
      await this.reload()
    }

    for (const call of calls) {
      const label = call.schema ? `${call.schema}.${call.name}` : call.name
      const candidates = this.candidates(call)

      if (candidates.length === 0) {
        throw new SafetyError(
          'FUNCTION_NOT_ALLOWED',
          `${label}() does not exist in this database. Check the name, or query pg_proc to find the function you want.`
        )
      }

      // An unqualified name could resolve to any of these, so every one of them must be safe.
      if (candidates.some((entry) => entry.securityDefiner)) {
        throw new SafetyError(
          'FUNCTION_NOT_ALLOWED',
          `This server is read-only; ${label}() is not allowed because it runs with its owner's privileges (SECURITY DEFINER).`
        )
      }

      const unsafe = candidates.some(
        (entry) =>
          entry.volatility === 'v' && !(entry.schema === 'pg_catalog' && VOLATILE_ALLOWLIST.has(entry.name))
      )
      if (unsafe) {
        throw new SafetyError(
          'FUNCTION_NOT_ALLOWED',
          `This server is for read-only analysis; ${label}() is not allowed because Postgres marks it volatile, ` +
            'meaning it can have side effects. Immutable and stable functions (aggregates, date, text, math, JSON) are all available.'
        )
      }
    }
  }

  private candidates(call: FunctionCall): FunctionEntry[] {
    const entries = this.byName.get(call.name) ?? []
    return call.schema ? entries.filter((entry) => entry.schema === call.schema) : entries
  }

  private canReload(): boolean {
    return this.load !== null && Date.now() - this.loadedAt >= RELOAD_INTERVAL_MS
  }

  private async reload(): Promise<void> {
    if (this.load === null) return
    this.index(await this.load())
    this.loadedAt = Date.now()
  }

  private index(entries: FunctionEntry[]): void {
    const byName = new Map<string, FunctionEntry[]>()
    for (const entry of entries) {
      const list = byName.get(entry.name)
      if (list) list.push(entry)
      else byName.set(entry.name, [entry])
    }
    this.byName = byName
  }
}
