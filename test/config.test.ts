import { afterEach, describe, expect, it } from 'vitest'
import {
  ConfigError,
  DEFAULT_MAX_ROWS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  HelpRequested,
  parseArgs,
} from '../src/config.js'

const originalDatabaseUrl = process.env.DATABASE_URL

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalDatabaseUrl
})

describe('parseArgs', () => {
  it('takes the connection string as the first positional argument', () => {
    // Matches the archived server, so migrating is a package-name swap.
    expect(parseArgs(['postgres://localhost/app'])).toEqual({
      connectionString: 'postgres://localhost/app',
      maxRows: DEFAULT_MAX_ROWS,
      statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
    })
  })

  it('falls back to DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://localhost/from-env'
    expect(parseArgs([]).connectionString).toBe('postgres://localhost/from-env')
  })

  it('prefers the positional argument over DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://localhost/from-env'
    expect(parseArgs(['postgres://localhost/explicit']).connectionString).toBe('postgres://localhost/explicit')
  })

  it('reads the row cap and statement timeout', () => {
    const config = parseArgs(['postgres://localhost/app', '--max-rows', '50', '--statement-timeout', '5000'])

    expect(config.maxRows).toBe(50)
    expect(config.statementTimeoutMs).toBe(5000)
  })

  it.each([
    [['--max-rows', '0']],
    [['--max-rows', '-1']],
    [['--max-rows', 'lots']],
    [['--max-rows']],
    [['--statement-timeout', '1.5']],
  ])('rejects %j', (flags) => {
    expect(() => parseArgs(['postgres://localhost/app', ...flags])).toThrow(ConfigError)
  })

  it('requires a connection string', () => {
    delete process.env.DATABASE_URL
    expect(() => parseArgs([])).toThrow(ConfigError)
  })

  it('rejects unknown options and stray arguments', () => {
    expect(() => parseArgs(['postgres://localhost/app', '--nope'])).toThrow(ConfigError)
    expect(() => parseArgs(['postgres://a', 'postgres://b'])).toThrow(ConfigError)
  })

  it('points --http at the future release rather than failing obscurely', () => {
    expect(() => parseArgs(['postgres://localhost/app', '--http'])).toThrow(/stdio only/)
  })

  it('treats --help as a success, not an error', () => {
    expect(() => parseArgs(['--help'])).toThrow(HelpRequested)
  })
})
