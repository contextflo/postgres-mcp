#!/usr/bin/env node
import { createRequire } from 'node:module'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigError, HelpRequested, parseArgs } from './config.js'
import { Database } from './db/pool.js'
import { ensureParserReady } from './safety/validate.js'
import { createServer } from './server.js'

// stdout carries MCP protocol frames on a stdio transport, so every diagnostic in this
// package goes to stderr. A stray console.log corrupts the stream.

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

async function main(): Promise<void> {
  let config
  try {
    config = parseArgs(process.argv.slice(2))
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

  // The WASM parser must be loaded before any query is validated.
  await ensureParserReady()

  const database = await Database.connect({
    connectionString: config.connectionString,
    statementTimeoutMs: config.statementTimeoutMs,
  })

  await database.warnOnWeakSetup()

  const server = createServer({ database, maxRows: config.maxRows, version })
  await server.connect(new StdioServerTransport())

  const shutdown = async (): Promise<void> => {
    await server.close().catch(() => {})
    await database.close().catch(() => {})
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((error: unknown) => {
  console.error(`[postgres-mcp] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
