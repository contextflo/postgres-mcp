import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Database } from '../../src/db/pool.js'

/**
 * The receipts.
 *
 * test/safety/adversarial.test.ts proves the parser rejects these payloads. This file
 * proves the layers *underneath* the parser stop them too — it deliberately bypasses
 * `validateReadOnlySql` and calls the database path directly, so a hole in the parser
 * would not make these pass.
 *
 * Point TEST_DATABASE_URL at a throwaway database whose role CAN write: the point is that
 * this server stays read-only even when the credentials it is given are not.
 * `npm run db:up` starts one.
 */

const connectionString = process.env.TEST_DATABASE_URL

if (!connectionString && process.env.CI) {
  // This suite is the security evidence. Skipping it locally is fine; skipping it in CI
  // would let the pipeline go green without ever proving the read-only claim.
  throw new Error(
    'TEST_DATABASE_URL is required in CI so the read-only integration suite cannot silently skip.'
  )
}

if (!connectionString) {
  console.warn(
    '[skipped] Integration suite needs TEST_DATABASE_URL. Run `npm run db:up` (requires Docker), then\n' +
      '          TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres npm test'
  )
}

const CANARY_SCHEMA = 'postgres_mcp_canary'

describe.skipIf(!connectionString)('read-only enforcement against a live database', () => {
  let database: Database
  let setupClient: pg.Client

  beforeAll(async () => {
    // A separate, unrestricted client for fixtures. Never used by the code under test.
    setupClient = new pg.Client({ connectionString })
    await setupClient.connect()
    await setupClient.query(`DROP SCHEMA IF EXISTS ${CANARY_SCHEMA} CASCADE`)
    await setupClient.query(`CREATE SCHEMA ${CANARY_SCHEMA}`)
    await setupClient.query(`CREATE TABLE ${CANARY_SCHEMA}.rows (id int primary key)`)
    await setupClient.query(
      `INSERT INTO ${CANARY_SCHEMA}.rows SELECT generate_series(1, 100)`
    )

    database = await Database.connect({ connectionString: connectionString!, statementTimeoutMs: 10_000 })
  })

  afterAll(async () => {
    await database?.close()
    await setupClient?.query(`DROP SCHEMA IF EXISTS ${CANARY_SCHEMA} CASCADE`)
    await setupClient?.end()
  })

  async function canaryTableExists(): Promise<boolean> {
    const result = await setupClient.query(
      'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
      [CANARY_SCHEMA, 'rows']
    )
    return result.rowCount === 1
  }

  it('runs an ordinary read', async () => {
    const result = await database.runReadOnly(`SELECT id FROM ${CANARY_SCHEMA}.rows ORDER BY id LIMIT 3`, 10)

    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(result.truncated).toBe(false)
  })

  it('caps rows and reports truncation', async () => {
    const result = await database.runReadOnly(`SELECT id FROM ${CANARY_SCHEMA}.rows ORDER BY id`, 10)

    expect(result.rows).toHaveLength(10)
    expect(result.truncated).toBe(true)
  })

  it('has default_transaction_read_only on (layer 2)', async () => {
    const [row] = await database.internalQuery<{ setting: string }>(
      "SELECT current_setting('default_transaction_read_only') AS setting"
    )

    expect(row?.setting).toBe('on')
  })

  it('rejects the Datadog payload at the wire protocol, with the parser bypassed (layer 1)', async () => {
    await expect(
      database.runReadOnly(`COMMIT; DROP SCHEMA ${CANARY_SCHEMA} CASCADE`, 10)
    ).rejects.toThrow(/cannot insert multiple commands into a prepared statement/i)

    expect(await canaryTableExists()).toBe(true)
  })

  it('rejects any stacked statement at the wire protocol (layer 1)', async () => {
    await expect(
      database.runReadOnly(`SELECT 1; DROP TABLE ${CANARY_SCHEMA}.rows`, 10)
    ).rejects.toThrow(/cannot insert multiple commands into a prepared statement/i)

    expect(await canaryTableExists()).toBe(true)
  })

  it('rejects a single-statement write, with the parser bypassed (layer 2)', async () => {
    // SQLSTATE 25006 — the transaction itself refuses this, not our code.
    await expect(
      database.runReadOnly(`INSERT INTO ${CANARY_SCHEMA}.rows VALUES (101)`, 10)
    ).rejects.toMatchObject({ code: '25006' })

    const result = await setupClient.query(`SELECT count(*)::int AS n FROM ${CANARY_SCHEMA}.rows`)
    expect(result.rows[0].n).toBe(100)
  })

  it('rejects DDL, with the parser bypassed (layer 2)', async () => {
    await expect(
      database.runReadOnly(`DROP TABLE ${CANARY_SCHEMA}.rows`, 10)
    ).rejects.toMatchObject({ code: '25006' })

    expect(await canaryTableExists()).toBe(true)
  })

  it('cannot be left writable by a SET, with the parser bypassed (layer 2)', async () => {
    // SET is legal inside a read-only transaction — but it is also transactional, so the
    // ROLLBACK every statement ends with undoes it. That is what stops a pooled
    // connection from being handed to the next caller in a writable state.
    await database.runReadOnly('SET default_transaction_read_only = off', 10).catch(() => {})

    const [row] = await database.internalQuery<{ setting: string }>(
      "SELECT current_setting('default_transaction_read_only') AS setting"
    )
    expect(row?.setting).toBe('on')

    await expect(
      database.runReadOnly(`INSERT INTO ${CANARY_SCHEMA}.rows VALUES (102)`, 10)
    ).rejects.toMatchObject({ code: '25006' })
  })
})
