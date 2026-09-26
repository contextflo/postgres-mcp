import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Database } from '../../src/db/pool.js'

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
})
