import { beforeAll, describe, expect, it } from 'vitest'
import { SafetyError } from '../../src/safety/errors.js'
import { ensureParserReady, validateReadOnlySql } from '../../src/safety/validate.js'

beforeAll(async () => {
  await ensureParserReady()
})

describe('accepted statements', () => {
  const accepted = [
    'SELECT 1',
    'SELECT 1;',
    "SELECT id, email FROM users WHERE created_at > now() - interval '7 days'",
    'WITH recent AS (SELECT * FROM orders) SELECT count(*) FROM recent',
    'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 10) SELECT sum(n) FROM t',
    'SELECT a FROM t UNION ALL SELECT b FROM u',
    'SELECT * FROM (SELECT 1 AS x) sub WHERE x = 1',
    'SELECT * FROM generate_series(1, 10)',
    'EXPLAIN SELECT * FROM users',
    'EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM users',
    'SHOW timezone',
    'SHOW ALL',
  ]

  it.each(accepted)('accepts %s', (sql) => {
    expect(() => validateReadOnlySql(sql)).not.toThrow()
  })
})

describe('comments and string literals are not statements', () => {
  // The parser understands SQL lexical structure, so a "; DROP TABLE" inside a comment or
  // a string is just text. A regex-based guard would reject these useful queries — or
  // worse, be fooled in the other direction.
  const accepted = [
    'SELECT 1 /* ; DROP TABLE users; */',
    'SELECT 1 -- ; DROP TABLE users',
    "SELECT '; DROP TABLE users; --' AS payload",
    'SELECT $$; DROP TABLE users; --$$ AS payload',
    "SELECT e'\\'; DROP TABLE users; --' AS payload",
  ]

  it.each(accepted)('accepts %s', (sql) => {
    expect(() => validateReadOnlySql(sql)).not.toThrow()
  })
})

describe('malformed input', () => {
  it('reports a parse error with the message from Postgres', () => {
    expect(() => validateReadOnlySql('SELEC 1')).toThrowError(
      expect.objectContaining({ code: 'PARSE_ERROR', message: expect.stringContaining('syntax error') })
    )
  })

  it('rejects a comment with no statement', () => {
    expect(() => validateReadOnlySql('-- nothing to see here')).toThrowError(
      expect.objectContaining({ code: 'EMPTY_STATEMENT' })
    )
  })

  it('rejects an empty string', () => {
    expect(() => validateReadOnlySql('')).toThrowError(expect.objectContaining({ code: 'EMPTY_STATEMENT' }))
  })
})

describe('error contract', () => {
  it('throws SafetyError with an actionable message', () => {
    try {
      validateReadOnlySql('DELETE FROM users')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SafetyError)
      expect((error as SafetyError).code).toBe('STATEMENT_NOT_ALLOWED')
      expect((error as SafetyError).message).toContain('DELETE')
      expect((error as SafetyError).message).toContain('read-only')
    }
  })
})
