import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { HttpConfig } from './config.js'

/**
 * Streamable HTTP transport, for running this on a box and pointing a remote client at it.
 *
 * Stateless: a fresh Server and transport per request, all sharing one connection pool.
 * There is no session state worth keeping between calls, and no session map to leak.
 *
 * On authentication — an MCP endpoint on a reachable port is a live database connection
 * for anyone who can open a socket to it. The read-only layers hold, so the exposure is
 * reading everything rather than breaking anything, which is still the whole database.
 * Hence: loopback unless a flag says otherwise, an optional bearer token, and a warning
 * loud enough to be uncomfortable when it is exposed without one.
 */

const MCP_PATH = '/mcp'

export interface HttpServerDeps {
  config: HttpConfig
  createMcpServer: () => Server
}

export async function startHttpServer({ config, createMcpServer }: HttpServerDeps): Promise<HttpServer> {
  warnAboutExposure(config)

  const server = createHttpServer((request, response) => {
    void handleRequest(request, response, config, createMcpServer)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  // Report the port actually bound, which differs from the requested one when it was 0.
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  console.error(`[postgres-mcp] listening on http://${config.host}:${port}${MCP_PATH}`)

  return server
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: HttpConfig,
  createMcpServer: () => Server
): Promise<void> {
  const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname

  if (path === '/health') {
    respondJson(response, 200, { status: 'ok' })
    return
  }

  if (path !== MCP_PATH) {
    respondJson(response, 404, { error: `Not found. The MCP endpoint is ${MCP_PATH}.` })
    return
  }

  if (!isLoopbackRequestAllowed(request, config.host)) {
    respondJson(response, 403, {
      error: 'Host or Origin is not local. This server is bound to loopback and only answers local requests.',
    })
    return
  }

  if (!isAuthorized(request, config.authToken)) {
    response.setHeader('WWW-Authenticate', 'Bearer')
    respondJson(response, 401, { error: 'Missing or invalid bearer token.' })
    return
  }

  const mcpServer = createMcpServer()
  // `sessionIdGenerator: undefined` is the SDK's documented way to ask for stateless mode,
  // but its own types are not written for exactOptionalPropertyTypes. The two casts here
  // are types-only; keeping the flag on is worth more in the safety layer than it costs
  // at this boundary.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  } as unknown as StreamableHTTPServerTransportOptions)

  response.on('close', () => {
    void transport.close()
    void mcpServer.close()
  })

  try {
    await mcpServer.connect(transport as Transport)
    await transport.handleRequest(request, response)
  } catch (error) {
    console.error(`[postgres-mcp] request failed: ${error instanceof Error ? error.message : String(error)}`)
    if (!response.headersSent) {
      respondJson(response, 500, { error: 'Internal server error.' })
    }
  }
}

function isAuthorized(request: IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) return true

  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) return false

  const presented = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(authToken)

  // timingSafeEqual throws on length mismatch, and the length itself is not a secret.
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
/** As `URL.hostname` spells them, which brackets IPv6. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost'])

/**
 * DNS rebinding: a web page on evil.example re-points its own hostname at 127.0.0.1, and
 * the browser, seeing the same origin, lets its script POST to this server. Loopback plus
 * no token is the default setup, so that script could read the database. The Host header
 * still says evil.example, which is how it is caught. The MCP spec requires this check.
 *
 * Only for loopback binds: behind 0.0.0.0 the Host is whatever the proxy in front sends,
 * and the bearer token is the control.
 */
function isLoopbackRequestAllowed(request: IncomingMessage, boundHost: string): boolean {
  if (!LOOPBACK.has(boundHost)) return true

  const host = request.headers.host
  if (!host || !LOOPBACK_HOSTNAMES.has(hostnameOf(`http://${host}`))) return false

  // Browsers send Origin; local tools such as the MCP Inspector are served from localhost.
  const origin = request.headers.origin
  return origin === undefined || LOOPBACK_HOSTNAMES.has(hostnameOf(origin))
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function warnAboutExposure(config: HttpConfig): void {
  if (LOOPBACK.has(config.host)) return

  if (config.authToken) {
    console.error(
      `[postgres-mcp] bound to ${config.host} with bearer-token auth. Terminate TLS in front of it — ` +
        'the token crosses the wire in plaintext otherwise.'
    )
    return
  }

  console.error(
    `[postgres-mcp] WARNING: bound to ${config.host} with NO AUTHENTICATION. Anyone who can reach ` +
      `${config.host}:${config.port} can read every table this connection can see. Queries stay ` +
      'read-only, so this is data exposure rather than damage — but it is the whole database. ' +
      'Set AUTH_TOKEN, keep it inside a private network, or bind 127.0.0.1.'
  )
}
