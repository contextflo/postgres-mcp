import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Database } from '../../src/db/pool.js'

/**
 * Through PgBouncer in transaction mode — the setup behind Supabase's and Neon's pooled
 * connection strings. PgBouncer refuses the startup parameters this server normally sends
 * (`options`), so this proves the fallback connects and that every guarantee which does
 * not depend on those parameters still holds.
 *
 * CI runs PgBouncer as a service and sets TEST_POOLER_URL; without it this skips.
 */

const poolerUrl = process.env.TEST_POOLER_URL

describe.skipIf(!poolerUrl)('behind PgBouncer (transaction pooling)', () => {
  let database: Database

  beforeAll(async () => {
    database = await Database.connect({ connectionString: poolerUrl!, statementTimeoutMs: 1_000 })
  })

  afterAll(async () => {
    await database?.close()
  })

  it('connects', async () => {
    const { rows } = await database.runReadOnly('SELECT 1 AS one', 10)

    expect(rows).toEqual([{ one: 1 }])
  })

  it('still refuses writes, with the parser bypassed', async () => {
    await expect(
      database.runReadOnly('CREATE TABLE postgres_mcp_pooler_canary (id int)', 10)
    ).rejects.toMatchObject({ code: '25006' })
  })

  it('still rejects stacked statements at the wire protocol', async () => {
    await expect(database.runReadOnly('SELECT 1; SELECT 2', 10)).rejects.toThrow(
      /cannot insert multiple commands into a prepared statement/i
    )
  })

  it('still enforces the statement timeout', async () => {
    await expect(database.runReadOnly('SELECT pg_sleep(3)', 10)).rejects.toThrow(/statement timeout/)
  })
})
