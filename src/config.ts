export interface ServerConfig {
  connectionString: string
  maxRows: number
  statementTimeoutMs: number
}

export const DEFAULT_MAX_ROWS = 1000
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000

export class ConfigError extends Error {}

/** Not a failure — `--help` is a successful invocation that prints and exits 0. */
export class HelpRequested extends Error {
  constructor() {
    super(USAGE)
  }
}

export const USAGE = `postgres-mcp — the analytics MCP server for Postgres (read-only)

Usage:
  npx @contextflo/postgres-mcp <connection-string> [options]

The connection string may also be supplied via the DATABASE_URL environment variable.

Options:
  --max-rows <n>            Maximum rows returned per query (default: ${DEFAULT_MAX_ROWS})
  --statement-timeout <ms>  Server-side statement timeout in milliseconds (default: ${DEFAULT_STATEMENT_TIMEOUT_MS})
  -h, --help                Show this message`

/**
 * The connection URL is the first positional argument, matching the archived
 * `@modelcontextprotocol/server-postgres` so migrating is a package-name swap.
 */
export function parseArgs(argv: string[]): ServerConfig {
  let connectionString: string | undefined
  let maxRows = DEFAULT_MAX_ROWS
  let statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!

    switch (arg) {
      case '--max-rows':
        maxRows = requirePositiveInteger(arg, argv[++index])
        break
      case '--statement-timeout':
        statementTimeoutMs = requirePositiveInteger(arg, argv[++index])
        break
      case '--http':
        throw new ConfigError(
          'HTTP mode is not available yet — this release is stdio only. Track it in the project README.'
        )
      case '-h':
      case '--help':
        throw new HelpRequested()
      default:
        if (arg.startsWith('-')) {
          throw new ConfigError(`Unknown option: ${arg}\n\n${USAGE}`)
        }
        if (connectionString !== undefined) {
          throw new ConfigError(`Unexpected argument: ${arg}\n\n${USAGE}`)
        }
        connectionString = arg
    }
  }

  connectionString ??= process.env.DATABASE_URL

  if (!connectionString) {
    throw new ConfigError(`A Postgres connection string is required.\n\n${USAGE}`)
  }

  return { connectionString, maxRows, statementTimeoutMs }
}

function requirePositiveInteger(flag: string, raw: string | undefined): number {
  const value = Number(raw)

  if (!raw || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${flag} expects a positive integer, received: ${raw ?? '(nothing)'}`)
  }

  return value
}
