/**
 * Turns Postgres driver errors into messages a model can act on, without echoing more of
 * the database's internals than the caller already knew.
 *
 * Ported from the ContextFlo connector's `executeQuery` error handling and extended with
 * the cases this server's safety layers produce.
 */

interface PgErrorLike {
  message?: string
  code?: string
  position?: string
  hint?: string | null
}

/** Postgres SQLSTATE 25006 — attempted a write inside a read-only transaction. */
const READ_ONLY_TRANSACTION = '25006'

export function describeQueryError(error: unknown): string {
  const pgError = error as PgErrorLike
  const message = pgError?.message ?? 'Unknown database error'

  if (pgError?.code === READ_ONLY_TRANSACTION) {
    return `Rejected by the database: this connection is read-only. (${message})`
  }

  // Postgres refuses multi-statement input over the extended query protocol. Reaching
  // this means the parser-level check was bypassed — the wire protocol caught it anyway.
  if (message.includes('cannot insert multiple commands into a prepared statement')) {
    return 'Only one statement per call is allowed. Send each statement as a separate query call.'
  }

  if (message.includes('canceling statement due to statement timeout')) {
    return 'Query exceeded the statement timeout. Narrow the query, or raise the limit with --statement-timeout.'
  }

  if (message.includes('syntax error')) {
    const position = pgError?.position ? ` (at position ${pgError.position})` : ''
    return `SQL syntax error: ${message}${position}`
  }

  if (message.includes('does not exist')) {
    return `Object not found: ${message}`
  }

  if (message.includes('permission denied')) {
    return `Permission denied: ${message}`
  }

  return message
}

export function describeConnectionError(error: unknown): string {
  const message = (error as PgErrorLike)?.message ?? 'Unknown connection error'

  if (message.includes('ECONNREFUSED')) {
    return 'Connection refused. Check that the Postgres server is running and the host/port are correct.'
  }

  if (message.includes('ENOTFOUND')) {
    return 'Host not found. Check the hostname or IP address in the connection string.'
  }

  if (message.includes('password authentication failed')) {
    return 'Authentication failed. Check the username and password in the connection string.'
  }

  if (message.includes('database') && message.includes('does not exist')) {
    return 'Database does not exist. Check the database name in the connection string.'
  }

  if (message.includes('SSL') || message.includes('ssl')) {
    return `SSL connection error: ${message}. Try adding ?sslmode=require to the connection string.`
  }

  if (message.includes('timeout')) {
    return 'Connection timed out. Check network connectivity to the database host.'
  }

  return message
}
