import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getTableContext, listTables, roleCanWrite } from '../../src/db/introspection.js'
import { Database } from '../../src/db/pool.js'
import { FunctionPolicy } from '../../src/safety/functions.js'
import { ensureParserReady, validateReadOnlySql } from '../../src/safety/validate.js'
import { findFunctionCalls } from '../../src/safety/walk.js'

/**
 * What the model actually sees from a live database: values rendered faithfully, and a
 * catalog picture that is useful rather than merely complete. Gated like readonly.test.ts
 * — required in CI, skipped locally without TEST_DATABASE_URL.
 */

const connectionString = process.env.TEST_DATABASE_URL

if (!connectionString && process.env.CI) {
  throw new Error('TEST_DATABASE_URL is required in CI so the integration suite cannot silently skip.')
}

const SCHEMA = 'postgres_mcp_data'

describe.skipIf(!connectionString)('data fidelity and catalog shape against a live database', () => {
  let database: Database
  let setupClient: pg.Client

  beforeAll(async () => {
    setupClient = new pg.Client({ connectionString })
    await setupClient.connect()
    await setupClient.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await setupClient.query(`
      CREATE SCHEMA ${SCHEMA};
      CREATE TYPE ${SCHEMA}.order_status AS ENUM ('pending', 'paid', 'refunded');
      CREATE TABLE ${SCHEMA}.orders (
        id int PRIMARY KEY,
        status ${SCHEMA}.order_status,
        placed_on date,
        placed_at timestamp,
        took interval,
        days date[]
      );
      INSERT INTO ${SCHEMA}.orders
        VALUES (1, 'paid', '2024-01-15', '2024-01-15 00:00:00', '1 day 02:00', ARRAY['2024-01-15'::date]);
      CREATE TABLE ${SCHEMA}.events (id int, day date) PARTITION BY RANGE (day);
      CREATE TABLE ${SCHEMA}.events_2024 PARTITION OF ${SCHEMA}.events
        FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
      CREATE TABLE ${SCHEMA}.order_items (id int);
      CREATE TABLE ${SCHEMA}.orderxitems (id int);
    `)

    database = await Database.connect({ connectionString: connectionString!, statementTimeoutMs: 1_000 })
  })

  afterAll(async () => {
    await database?.close()
    await setupClient?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await setupClient?.end()
  })

  it('returns dates, timestamps, and intervals exactly as Postgres sent them', async () => {
    // Before: node-postgres made JS Dates in the server process's timezone, so a date
    // came back a day early for anyone east of UTC.
    const { rows } = await database.runReadOnly(`SELECT placed_on, placed_at, took, days FROM ${SCHEMA}.orders`, 10)

    expect(rows[0]).toEqual({
      placed_on: '2024-01-15',
      placed_at: '2024-01-15 00:00:00',
      took: '1 day 02:00:00',
      days: ['2024-01-15'],
    })
  })

  it('applies the statement timeout inside the transaction', async () => {
    await expect(database.runReadOnly('SELECT pg_sleep(3)', 10)).rejects.toThrow(/statement timeout/)
  })

  it('lists a partitioned table once, not once per partition', async () => {
    const { tables } = await listTables(database, { schema: SCHEMA, limit: 100 })

    const names = tables.map((table) => table.name)
    expect(names).toContain('events')
    expect(names).not.toContain('events_2024')
  })

  it('treats _ and % in a search pattern literally', async () => {
    const { tables } = await listTables(database, { schema: SCHEMA, pattern: 'order_items', limit: 100 })

    expect(tables.map((table) => table.name)).toEqual(['order_items'])
  })

  it('knows whether the connected role could write, so init only recommends a read-only role when needed', async () => {
    expect(await roleCanWrite(database)).toBe(true)

    const role = `postgres_mcp_probe_${process.pid}`
    await setupClient.query(`CREATE ROLE ${role} LOGIN PASSWORD 'probe'`)
    await setupClient.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${role}`)
    await setupClient.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${role}`)

    const url = new URL(connectionString!)
    url.username = role
    url.password = 'probe'
    const readOnly = await Database.connect({ connectionString: url.toString(), statementTimeoutMs: 1_000 })
    try {
      expect(await roleCanWrite(readOnly)).toBe(false)
    } finally {
      await readOnly.close()
      await setupClient.query(`DROP OWNED BY ${role}`)
      await setupClient.query(`DROP ROLE ${role}`)
    }
  })

  describe('function policy from the real catalog', () => {
    let policy: FunctionPolicy

    async function check(sql: string): Promise<void> {
      await policy.check([...findFunctionCalls(validateReadOnlySql(sql))])
    }

    beforeAll(async () => {
      await ensureParserReady()
      await setupClient.query(`
        CREATE FUNCTION ${SCHEMA}.stable_calc(x int) RETURNS int STABLE LANGUAGE sql AS 'SELECT x * 2';
        CREATE FUNCTION ${SCHEMA}.volatile_calc(x int) RETURNS int VOLATILE LANGUAGE sql AS 'SELECT x * 2';
        CREATE FUNCTION ${SCHEMA}.definer_calc(x int) RETURNS int STABLE SECURITY DEFINER LANGUAGE sql AS 'SELECT x * 2';
      `)
      policy = await FunctionPolicy.fromDatabase(database)
    })

    // Postgres versions label functions, so an analysis function newly marked volatile
    // in some release shows up here rather than as a mysterious refusal.
    it.each([
      `SELECT date_trunc('month', created_at), count(*), sum(total_amount), avg(total_amount), round(avg(total_amount), 2) FROM x GROUP BY 1`,
      'SELECT row_number() OVER (PARTITION BY a ORDER BY b), lag(c) OVER (ORDER BY b) FROM x',
      "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY a), string_agg(b, ',') FROM x",
      "SELECT extract(epoch FROM b - a) / 86400, to_char(a, 'YYYY-MM') FROM x",
      "SELECT generate_series(date '2026-01-01', date '2026-02-01', interval '1 day')",
      `SELECT jsonb_build_object('a', 1), jsonb_extract_path_text('{"a":1}'::jsonb, 'a')`,
      "SELECT lower(a), split_part(a, '@', 2), regexp_replace(a, '@.*', ''), length(a), now(), age(now(), b) FROM x",
      "SELECT pg_size_pretty(pg_total_relation_size('orders')), random()",
      "SELECT obj_description(1, 'pg_class'), format_type(23, -1), current_setting('TimeZone')",
      `SELECT ${SCHEMA}.stable_calc(1)`,
    ])('allows %s', async (sql) => {
      await expect(check(sql)).resolves.toBeUndefined()
    })

    it.each([
      ['SELECT pg_sleep(1)', /volatile/],
      ['SELECT pg_current_wal_lsn()', /volatile/],
      ['SELECT pg_advisory_unlock_all()', /volatile/],
      [`SELECT ${SCHEMA}.volatile_calc(1)`, /volatile/],
      [`SELECT ${SCHEMA}.definer_calc(1)`, /SECURITY DEFINER/],
      ['SELECT datediff(1, 2)', /does not exist/],
    ])('refuses %s', async (sql, message) => {
      await expect(check(sql)).rejects.toThrowError(message)
    })
  })

  it('reports enum values, in order', async () => {
    const [orders] = await getTableContext(database, [`${SCHEMA}.orders`])

    expect(orders?.columns.find((column) => column.name === 'status')?.enumValues).toEqual([
      'pending',
      'paid',
      'refunded',
    ])
  })
})
