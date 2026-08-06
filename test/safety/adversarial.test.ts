import { beforeAll, describe, expect, it } from 'vitest'
import type { SafetyCode } from '../../src/safety/errors.js'
import { ensureParserReady, validateReadOnlySql } from '../../src/safety/validate.js'

/**
 * The attack corpus.
 *
 * The headline case is the payload from Datadog Security Labs' writeup on
 * `@modelcontextprotocol/server-postgres` — the server this one replaces. Theirs
 * concatenated user SQL into a read-only transaction over the simple query protocol, so
 * `COMMIT` ended the transaction and everything after it ran with full privileges.
 *
 * This file covers the parser layer only. The wire-protocol and transaction layers are
 * proven separately in test/integration/readonly.test.ts, which needs a real database.
 */

beforeAll(async () => {
  await ensureParserReady()
})

function expectRejection(sql: string, code: SafetyCode): void {
  expect(() => validateReadOnlySql(sql)).toThrowError(expect.objectContaining({ code }))
}

describe('the archived server’s CVE', () => {
  it('rejects the Datadog proof-of-concept payload', () => {
    expectRejection('COMMIT; DROP SCHEMA public CASCADE', 'MULTIPLE_STATEMENTS')
  })

  it('rejects the payload shape that restores the transaction afterwards', () => {
    expectRejection(
      'SELECT 1; COMMIT; DROP TABLE users; BEGIN TRANSACTION READ ONLY;',
      'MULTIPLE_STATEMENTS'
    )
  })
})

describe('statement stacking', () => {
  const stacked: [string, SafetyCode][] = [
    ['SELECT 1; DROP TABLE users', 'MULTIPLE_STATEMENTS'],
    ['SELECT 1;SELECT 2', 'MULTIPLE_STATEMENTS'],
    ['SELECT 1 /* c */ ; UPDATE users SET admin = true', 'MULTIPLE_STATEMENTS'],
    ["SELECT 1; INSERT INTO audit VALUES ('x')", 'MULTIPLE_STATEMENTS'],
  ]

  it.each(stacked)('rejects %s', (sql, code) => expectRejection(sql, code))
})

describe('writes disguised as reads', () => {
  // Each of these parses to a SelectStmt at the top level. A validator that checked only
  // the top-level statement type would run every one of them.
  const disguised: [string, SafetyCode][] = [
    ['WITH x AS (INSERT INTO users VALUES (1) RETURNING *) SELECT * FROM x', 'STATEMENT_NOT_ALLOWED'],
    ['WITH x AS (UPDATE users SET admin = true RETURNING *) SELECT count(*) FROM x', 'STATEMENT_NOT_ALLOWED'],
    ['WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x', 'STATEMENT_NOT_ALLOWED'],
    [
      'SELECT * FROM (WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d) AS nested',
      'STATEMENT_NOT_ALLOWED',
    ],
    [
      'SELECT 1 UNION ALL (WITH d AS (DELETE FROM users RETURNING id) SELECT id FROM d)',
      'STATEMENT_NOT_ALLOWED',
    ],
    ['SELECT * INTO backup FROM users', 'SELECT_INTO'],
    ['SELECT id INTO TEMP TABLE t FROM users', 'SELECT_INTO'],
    ['SELECT * FROM users FOR UPDATE', 'LOCKING_CLAUSE'],
    ['SELECT * FROM users FOR SHARE', 'LOCKING_CLAUSE'],
  ]

  it.each(disguised)('rejects %s', (sql, code) => expectRejection(sql, code))
})

describe('turning off the safety settings', () => {
  const settings: [string, SafetyCode][] = [
    ['SET default_transaction_read_only = off', 'STATEMENT_NOT_ALLOWED'],
    ['SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE', 'STATEMENT_NOT_ALLOWED'],
    ['SET statement_timeout = 0', 'STATEMENT_NOT_ALLOWED'],
    ['RESET ALL', 'STATEMENT_NOT_ALLOWED'],
    ['BEGIN', 'STATEMENT_NOT_ALLOWED'],
    ['COMMIT', 'STATEMENT_NOT_ALLOWED'],
    ['ROLLBACK', 'STATEMENT_NOT_ALLOWED'],
    ['ALTER SYSTEM SET default_transaction_read_only = off', 'STATEMENT_NOT_ALLOWED'],
  ]

  it.each(settings)('rejects %s', (sql, code) => expectRejection(sql, code))
})

describe('code execution and privilege escalation', () => {
  const escalation: [string, SafetyCode][] = [
    ['DO $$ BEGIN DELETE FROM users; END $$', 'STATEMENT_NOT_ALLOWED'],
    ["COPY (SELECT 1) TO PROGRAM 'sh -c id'", 'STATEMENT_NOT_ALLOWED'],
    ["COPY users FROM '/etc/passwd'", 'STATEMENT_NOT_ALLOWED'],
    [
      "CREATE FUNCTION evil() RETURNS void AS $$ DELETE FROM users $$ LANGUAGE sql",
      'STATEMENT_NOT_ALLOWED',
    ],
    ['GRANT ALL ON users TO PUBLIC', 'STATEMENT_NOT_ALLOWED'],
    ['ALTER ROLE app_reader SUPERUSER', 'STATEMENT_NOT_ALLOWED'],
    ['CREATE ROLE intruder LOGIN PASSWORD \'x\'', 'STATEMENT_NOT_ALLOWED'],
    ['CALL some_procedure()', 'STATEMENT_NOT_ALLOWED'],
    ['CREATE EXTENSION plpython3u', 'STATEMENT_NOT_ALLOWED'],
  ]

  it.each(escalation)('rejects %s', (sql, code) => expectRejection(sql, code))
})

describe('plain writes and DDL', () => {
  const writes: [string, SafetyCode][] = [
    ['INSERT INTO users (email) VALUES (\'a@b.c\')', 'STATEMENT_NOT_ALLOWED'],
    ['UPDATE users SET admin = true', 'STATEMENT_NOT_ALLOWED'],
    ['DELETE FROM users', 'STATEMENT_NOT_ALLOWED'],
    ['TRUNCATE users', 'STATEMENT_NOT_ALLOWED'],
    ['DROP TABLE users', 'STATEMENT_NOT_ALLOWED'],
    ['DROP SCHEMA public CASCADE', 'STATEMENT_NOT_ALLOWED'],
    ['CREATE TABLE t (id int)', 'STATEMENT_NOT_ALLOWED'],
    ['CREATE TABLE backup AS SELECT * FROM users', 'STATEMENT_NOT_ALLOWED'],
    ['CREATE MATERIALIZED VIEW mv AS SELECT 1', 'STATEMENT_NOT_ALLOWED'],
    ['REFRESH MATERIALIZED VIEW mv', 'STATEMENT_NOT_ALLOWED'],
    ['ALTER TABLE users ADD COLUMN x int', 'STATEMENT_NOT_ALLOWED'],
    ['MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE', 'STATEMENT_NOT_ALLOWED'],
    ['VACUUM FULL', 'STATEMENT_NOT_ALLOWED'],
    ['LOCK TABLE users', 'STATEMENT_NOT_ALLOWED'],
    ['NOTIFY channel', 'STATEMENT_NOT_ALLOWED'],
  ]

  it.each(writes)('rejects %s', (sql, code) => expectRejection(sql, code))
})

describe('indirection', () => {
  // Deferring the write to a later call is still a write.
  const indirect: [string, SafetyCode][] = [
    ['PREPARE p AS INSERT INTO users VALUES (1)', 'STATEMENT_NOT_ALLOWED'],
    ['EXECUTE p', 'STATEMENT_NOT_ALLOWED'],
    ['DECLARE c CURSOR FOR SELECT * FROM users', 'STATEMENT_NOT_ALLOWED'],
    ['FETCH ALL FROM c', 'STATEMENT_NOT_ALLOWED'],
    ['CLOSE c', 'STATEMENT_NOT_ALLOWED'],
    ['EXPLAIN ANALYZE DELETE FROM users', 'STATEMENT_NOT_ALLOWED'],
    ['EXPLAIN INSERT INTO users VALUES (1)', 'STATEMENT_NOT_ALLOWED'],
    ['CREATE RULE r AS ON SELECT TO t DO INSTEAD DELETE FROM users', 'STATEMENT_NOT_ALLOWED'],
  ]

  it.each(indirect)('rejects %s', (sql, code) => expectRejection(sql, code))
})
