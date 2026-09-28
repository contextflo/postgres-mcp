import { beforeAll, describe, expect, it } from 'vitest'
import { FunctionPolicy, type FunctionEntry } from '../../src/safety/functions.js'
import { ensureParserReady, validateReadOnlySql } from '../../src/safety/validate.js'
import { findFunctionCalls } from '../../src/safety/walk.js'

beforeAll(async () => {
  await ensureParserReady()
})

// A slice of a real pg_proc: labels as Postgres ships them.
const CATALOG: FunctionEntry[] = [
  { schema: 'pg_catalog', name: 'count', volatility: 'i', securityDefiner: false },
  { schema: 'pg_catalog', name: 'date_trunc', volatility: 'i', securityDefiner: false },
  { schema: 'pg_catalog', name: 'date_trunc', volatility: 's', securityDefiner: false },
  { schema: 'pg_catalog', name: 'now', volatility: 's', securityDefiner: false },
  { schema: 'pg_catalog', name: 'random', volatility: 'v', securityDefiner: false },
  { schema: 'pg_catalog', name: 'pg_total_relation_size', volatility: 'v', securityDefiner: false },
  { schema: 'pg_catalog', name: 'pg_logical_emit_message', volatility: 'v', securityDefiner: false },
  { schema: 'pg_catalog', name: 'pg_sleep', volatility: 'v', securityDefiner: false },
  { schema: 'pg_catalog', name: 'ts_rewrite', volatility: 'i', securityDefiner: false },
  { schema: 'pg_catalog', name: 'ts_rewrite', volatility: 'v', securityDefiner: false },
  { schema: 'analytics', name: 'net_revenue', volatility: 's', securityDefiner: false },
  { schema: 'analytics', name: 'refresh_rollups', volatility: 'v', securityDefiner: false },
  { schema: 'analytics', name: 'admin_lookup', volatility: 's', securityDefiner: true },
]

const policy = FunctionPolicy.fromEntries(CATALOG)

async function check(sql: string): Promise<void> {
  await policy.check([...findFunctionCalls(validateReadOnlySql(sql))])
}

describe('function policy', () => {
  it.each([
    'SELECT count(*), date_trunc(\'month\', now()) FROM orders',
    'SELECT pg_catalog.now()',
    'SELECT random() FROM orders',
    'SELECT pg_total_relation_size(\'orders\')',
    'SELECT analytics.net_revenue(1)',
  ])('allows %s', async (sql) => {
    await expect(check(sql)).resolves.toBeUndefined()
  })

  it.each([
    ["SELECT pg_logical_emit_message(false, 'p', 'x')", /not allowed/], // the name list refuses it first
    ['SELECT pg_sleep(10)', /volatile/],
    ['SELECT id FROM orders WHERE id IN (SELECT analytics.refresh_rollups())', /volatile/],
    ["SELECT analytics.admin_lookup('x')", /SECURITY DEFINER/],
    // One overload is volatile, and an unqualified call could resolve to it.
    ["SELECT ts_rewrite('a'::tsquery, 'SELECT 1')", /volatile/],
    ['SELECT datediff(now(), now())', /does not exist/],
    ['SELECT public.count(*)', /does not exist/],
  ])('refuses %s', async (sql, message) => {
    await expect(check(sql)).rejects.toThrowError(message)
  })
})
