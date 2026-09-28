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

describe('functions that act outside the read-only transaction', () => {
  // The parser cannot see inside a function body, so these are named explicitly. Each
  // one parses as a plain SELECT, which the statement allowlist alone would accept.
  const escapes: string[] = [
    // A second connection, which is not read-only.
    "SELECT dblink_exec('dbname=prod', 'DROP TABLE users')",
    "SELECT * FROM dblink('dbname=prod', 'DELETE FROM users RETURNING id') AS t(id int)",
    "SELECT public.dblink_exec('dbname=prod', 'DROP TABLE users')",
    // SQL strings the parser never sees.
    "SELECT query_to_xml('SELECT dblink_exec(''x'', ''DROP TABLE users'')', true, false, '')",
    "SELECT * FROM ts_stat('SELECT to_tsvector(body) FROM docs')",
    // Settings; SET is rejected, so its function form is too.
    "SELECT set_config('statement_timeout', '0', false)",
    // Other sessions and the server.
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity',
    'SELECT pg_cancel_backend(pid) FROM pg_stat_activity',
    'SELECT pg_reload_conf()',
    "SELECT pg_notify('channel', 'payload')",
    // A session-level lock outlives the ROLLBACK, on a pooled connection.
    'SELECT pg_advisory_lock(42)',
    'SELECT pg_try_advisory_lock_shared(42)',
    // The server's filesystem.
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT pg_catalog.pg_read_binary_file('/etc/passwd')",
    "SELECT pg_ls_dir('.')",
    'SELECT * FROM pg_ls_waldir()',
    "SELECT lo_import('/etc/passwd')",
    "SELECT lo_export(1234, '/tmp/out')",
    // Replication slots.
    "SELECT pg_create_logical_replication_slot('s', 'pgoutput')",
    "SELECT * FROM pg_logical_slot_get_changes('s', NULL, NULL)",
    // Writes to the WAL, and Postgres allows it in a read-only transaction.
    "SELECT pg_logical_emit_message(false, 'prefix', 'payload')",
    "SELECT pg_catalog.pg_logical_emit_message(true, 'p', repeat('x', 1000000))",
    'SELECT pg_log_standby_snapshot()',
    "SELECT pg_replication_slot_advance('s', '0/0')",
    "SELECT pg_copy_logical_replication_slot('s', 't')",
    // Server-wide state.
    'SELECT pg_stat_reset()',
    "SELECT pg_stat_reset_single_table_counters('orders'::regclass)",
    "SELECT pg_backup_start('label')",
    'SELECT pg_wal_replay_pause()',
    // Sequences: refused by the read-only transaction as well, but named here first.
    "SELECT nextval('orders_id_seq')",
    "SELECT setval('orders_id_seq', 1)",
    // Hidden deeper in the tree.
    "SELECT id FROM users WHERE EXISTS (SELECT pg_advisory_lock(id))",
    "WITH x AS (SELECT pg_read_file('/etc/passwd') AS f) SELECT * FROM x",
    "EXPLAIN ANALYZE SELECT pg_terminate_backend(1)",
  ]

  it.each(escapes)('rejects %s', (sql) => expectRejection(sql, 'FUNCTION_NOT_ALLOWED'))

  const ordinary = [
    'SELECT count(*), lower(email), now() FROM users',
    "SELECT date_trunc('month', created_at), sum(amount) FROM orders GROUP BY 1",
    // The transaction-scoped lock is released by the ROLLBACK, so it is harmless.
    'SELECT pg_advisory_xact_lock(42)',
    "SELECT current_setting('statement_timeout')",
    "SELECT table_to_xml('users', true, false, '')",
    'SELECT pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class',
  ]

  it.each(ordinary)('allows %s', (sql) => {
    expect(() => validateReadOnlySql(sql)).not.toThrow()
  })
})
