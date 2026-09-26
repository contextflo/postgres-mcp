import { DEFAULT_CONTEXT_DIRECTORY, DEFAULT_CONTEXT_FILE } from './context/context-file.js'

export interface HttpConfig {
  host: string
  port: number
  /** From the AUTH_TOKEN environment variable. Unset means no authentication. */
  authToken: string | undefined
}

export interface ServerConfig {
  command: 'serve' | 'init'
  connectionString: string
  maxRows: number
  maxOutputChars: number
  statementTimeoutMs: number
  contextFile: string
  contextDirectory: string
  logFile: string | undefined
  logDisabled: boolean
  /** Undefined means stdio. */
  http: HttpConfig | undefined
}

export const DEFAULT_MAX_ROWS = 1000
/** About 12k tokens: room for a real answer, not enough to crowd out the conversation. */
export const DEFAULT_MAX_OUTPUT_CHARS = 50_000
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000
export const DEFAULT_HTTP_PORT = 8080
/** Loopback by default: exposing a database to the network should take a deliberate flag. */
export const DEFAULT_HTTP_HOST = '127.0.0.1'

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
  npx @contextflo/postgres-mcp init <connection-string>

The connection string may also be supplied via the DATABASE_URL environment variable.

Commands:
  init                      Scan the schema and write ${DEFAULT_CONTEXT_FILE} for you to edit

Options:
  --max-rows <n>            Maximum rows returned per query (default: ${DEFAULT_MAX_ROWS})
  --max-output-chars <n>    Character budget for one query result (default: ${DEFAULT_MAX_OUTPUT_CHARS})
  --statement-timeout <ms>  Server-side statement timeout in milliseconds (default: ${DEFAULT_STATEMENT_TIMEOUT_MS})
  --context-file <path>     Curated schema context served to the model (default: ${DEFAULT_CONTEXT_FILE})
  --log-file <path>         Append a query audit log here (default: ${DEFAULT_CONTEXT_DIRECTORY}/log.md once that directory exists)
  --no-log                  Never write a query log
  --http                    Serve over streamable HTTP instead of stdio
  --port <n>                HTTP port (default: ${DEFAULT_HTTP_PORT})
  --host <addr>             HTTP bind address (default: ${DEFAULT_HTTP_HOST}; use 0.0.0.0 to expose)
  -h, --help                Show this message

Environment:
  DATABASE_URL              Connection string, if not given as an argument
  AUTH_TOKEN                If set with --http, require this as a bearer token`

/**
 * The connection URL is the first positional argument, matching the archived
 * `@modelcontextprotocol/server-postgres` so migrating is a package-name swap.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ServerConfig {
  let command: ServerConfig['command'] = 'serve'
  let connectionString: string | undefined
  let maxRows = DEFAULT_MAX_ROWS
  let maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS
  let statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS
  let contextFile = DEFAULT_CONTEXT_FILE
  let logFile: string | undefined
  let logDisabled = false
  let http = false
  let port = DEFAULT_HTTP_PORT
  let host = DEFAULT_HTTP_HOST

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!

    switch (arg) {
      case 'init':
        if (index !== 0) throw new ConfigError(`"init" must come first.\n\n${USAGE}`)
        command = 'init'
        break
      case '--max-rows':
        maxRows = requirePositiveInteger(arg, argv[++index])
        break
      case '--max-output-chars':
        maxOutputChars = requirePositiveInteger(arg, argv[++index])
        break
      case '--statement-timeout':
        statementTimeoutMs = requirePositiveInteger(arg, argv[++index])
        break
      case '--context-file':
        contextFile = requireValue(arg, argv[++index])
        break
      case '--log-file':
        logFile = requireValue(arg, argv[++index])
        break
      case '--no-log':
        logDisabled = true
        break
      case '--http':
        http = true
        break
      case '--port':
        port = requirePositiveInteger(arg, argv[++index])
        break
      case '--host':
        host = requireValue(arg, argv[++index])
        break
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

  connectionString ??= env.DATABASE_URL

  if (!connectionString) {
    throw new ConfigError(`A Postgres connection string is required.\n\n${USAGE}`)
  }

  if (logFile && logDisabled) {
    throw new ConfigError('--log-file and --no-log contradict each other.')
  }

  return {
    command,
    connectionString,
    maxRows,
    maxOutputChars,
    statementTimeoutMs,
    contextFile,
    contextDirectory: directoryOf(contextFile),
    logFile,
    logDisabled,
    http: http ? { host, port, authToken: env.AUTH_TOKEN || undefined } : undefined,
  }
}

/** The log lives beside the context file, wherever that was pointed. */
function directoryOf(filePath: string): string {
  const separator = filePath.lastIndexOf('/')
  return separator === -1 ? '.' : filePath.slice(0, separator)
}

function requireValue(flag: string, raw: string | undefined): string {
  if (!raw || raw.startsWith('-')) {
    throw new ConfigError(`${flag} expects a value, received: ${raw ?? '(nothing)'}`)
  }
  return raw
}

function requirePositiveInteger(flag: string, raw: string | undefined): number {
  const value = Number(raw)

  if (!raw || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${flag} expects a positive integer, received: ${raw ?? '(nothing)'}`)
  }

  return value
}
