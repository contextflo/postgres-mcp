#!/usr/bin/env node
import { createRequire } from 'node:module'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigError, HelpRequested, parseArgs, type ServerConfig } from './config.js'
import { parse as parseConnectionString } from 'pg-connection-string'
import { ContextFileExists, readOnlyRoleSnippet, runInit } from './context/init.js'
import { ContextStore } from './context/store.js'
import { roleCanWrite } from './db/introspection.js'
import { Database, LazyDatabase } from './db/pool.js'
import { startHttpServer } from './http.js'
import { QueryLog } from './log.js'
import { FunctionPolicy } from './safety/functions.js'
import { ensureParserReady } from './safety/validate.js'
import { createServer } from './server.js'

// stdout carries MCP protocol frames on a stdio transport, so every diagnostic in this
// package goes to stderr. A stray console.log corrupts the stream. The exceptions are
// --help and `init`, neither of which starts a transport.

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

async function main(): Promise<void> {
  const config = readConfig()

  // The WASM parser must be loaded before any query is validated.
  await ensureParserReady()

  if (config.command === 'init') {
    await initialiseContextFile(config)
    return
  }

  await serve(config)
}

function readConfig(): ServerConfig {
  try {
    return parseArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof HelpRequested) {
      // Safe on stdout: no transport is running yet, and this process exits immediately.
      console.log(error.message)
      process.exit(0)
    }
    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exit(1)
    }
    throw error
  }
}

async function initialiseContextFile(config: ServerConfig): Promise<void> {
  // parseArgs guarantees a connection string for init.
  const connectionString = config.connectionString!
  const database = await Database.connect({ connectionString, statementTimeoutMs: config.statementTimeoutMs })

  let result
  try {
    result = await runInit(database, config.contextFile)
  } catch (error) {
    await database.close().catch(() => {})
    if (error instanceof ContextFileExists) {
      console.error(error.message)
      process.exit(1)
    }
    throw error
  }

  const databaseName = parseConnectionString(connectionString).database || 'postgres'

  console.log(`Wrote ${result.path}`)
  console.log(
    `  ${result.tableCount} tables across ${result.schemas.length} schema(s); ` +
      `${result.seededColumnCount} column descriptions seeded from COMMENT ON.`
  )
  if (result.truncated) {
    console.log('  Note: only the first 1000 tables were included.')
  }
  console.log('\nEdit it: the business definitions section is where the value is.')

  // Already on a role that cannot write, which is the recommended setup: nothing to add.
  if (await roleCanWrite(database)) {
    console.log('\nThis role can write. Connect as one that cannot, so read-only holds even if this')
    console.log('server has a bug:\n')
    console.log(readOnlyRoleSnippet(databaseName, result.schemas))
  }

  await database.close()
}

async function serve(config: ServerConfig): Promise<void> {
  // Connects on first use, so the server starts and lists its tools without a database.
  const database = new LazyDatabase(
    config.connectionString
      ? { connectionString: config.connectionString, statementTimeoutMs: config.statementTimeoutMs }
      : null
  )
  if (!config.connectionString) {
    console.error(
      '[postgres-mcp] no connection string: set DATABASE_URL in the environment or .env. Tools will ' +
        'report this until one is configured.'
    )
  }

  const contextFile = await ContextStore.open(config.contextFile, { writable: config.contextWrites })
  const contextDocument = contextFile.current
  if (contextDocument.tables.size === 0 && !contextDocument.preamble) {
    console.error(
      `[postgres-mcp] no context file at ${config.contextFile}. Run \`postgres-mcp init <url>\` to ` +
        'generate one, or pass --context-file with an absolute path — the model does better when it ' +
        'knows what your tables mean.'
    )
  } else {
    console.error(`[postgres-mcp] context from ${config.contextFile}`)
  }

  const log = await QueryLog.resolve({
    explicitPath: config.logFile,
    disabled: config.logDisabled,
    contextDirectory: config.contextDirectory,
  })
  if (log.isEnabled) {
    console.error(`[postgres-mcp] logging queries to ${log.filePath}`)
  }

  const functions = FunctionPolicy.fromDatabase(database)

  const toolContext = {
    database,
    functions,
    contextFile,
    log,
    maxRows: config.maxRows,
    maxOutputChars: config.maxOutputChars,
  }
  const buildServer = (): ReturnType<typeof createServer> =>
    createServer({ context: toolContext, version, connectionString: config.connectionString })

  const shutdown = async (): Promise<void> => {
    await log.flush().catch(() => {})
    await database.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  if (config.http) {
    await startHttpServer({ config: config.http, createMcpServer: buildServer })
    return
  }

  await buildServer().connect(new StdioServerTransport())
}

main().catch((error: unknown) => {
  console.error(`[postgres-mcp] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
