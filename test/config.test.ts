import { afterEach, describe, expect, it } from 'vitest'
import {
  ConfigError,
  resolveContextFile,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
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
    expect(parseArgs(['postgres://localhost/app'])).toMatchObject({
      command: 'serve',
      connectionString: 'postgres://localhost/app',
      maxRows: DEFAULT_MAX_ROWS,
      statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
      http: undefined,
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

  it('binds HTTP to loopback unless told otherwise', () => {
    // Exposing a database to the network should take a deliberate flag, never a default.
    expect(parseArgs(['postgres://localhost/app', '--http'], {}).http).toEqual({
      host: DEFAULT_HTTP_HOST,
      port: DEFAULT_HTTP_PORT,
      authToken: undefined,
    })
  })

  it('takes the bearer token from AUTH_TOKEN', () => {
    const config = parseArgs(['postgres://localhost/app', '--http', '--host', '0.0.0.0', '--port', '9000'], {
      AUTH_TOKEN: 'secret',
    })

    expect(config.http).toEqual({ host: '0.0.0.0', port: 9000, authToken: 'secret' })
  })

  it('parses the init command', () => {
    expect(parseArgs(['init', 'postgres://localhost/app']).command).toBe('init')
    expect(() => parseArgs(['postgres://localhost/app', 'init'])).toThrow(ConfigError)
  })

  it('puts the log beside the context file', () => {
    const config = parseArgs(['postgres://localhost/app', '--context-file', 'docs/db/context.md'], {}, '/repo')

    expect(config.contextDirectory).toBe('/repo/docs/db')
  })

  it('resolves the context file against the working directory', () => {
    expect(parseArgs(['postgres://localhost/app'], {}, '/repo').contextFile).toBe('/repo/.contextflo/context.md')
  })

  it('keeps an absolute context file as given', () => {
    const config = parseArgs(['postgres://localhost/app', '--context-file', '/etc/team/context.md'], {}, '/repo')

    expect(config.contextFile).toBe('/etc/team/context.md')
  })

  it('falls back to the home directory when started from the filesystem root', () => {
    // Claude Desktop launches servers with cwd "/", where .contextflo/ is never what anyone meant.
    expect(resolveContextFile('.contextflo/context.md', '/', '/home/ana')).toBe('/home/ana/.contextflo/context.md')
  })
  it('reads the output budget', () => {
    const config = parseArgs(['postgres://localhost/app', '--max-output-chars', '1000'])

    expect(config.maxOutputChars).toBe(1000)
  })

  it('rejects contradictory logging flags', () => {
    expect(() => parseArgs(['postgres://localhost/app', '--log-file', 'a.md', '--no-log'])).toThrow(
      ConfigError
    )
  })

  it('treats --help as a success, not an error', () => {
    expect(() => parseArgs(['--help'])).toThrow(HelpRequested)
  })
})
