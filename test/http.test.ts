import { FunctionPolicy } from '../src/safety/functions.js'
import type { AddressInfo } from 'node:net'
import { request as httpRequest, type Server as HttpServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ContextStore } from '../src/context/store.js'
import type { Database } from '../src/db/pool.js'
import { startHttpServer } from '../src/http.js'
import { QueryLog } from '../src/log.js'
import { ensureParserReady } from '../src/safety/validate.js'
import { createServer } from '../src/server.js'

function fakeDatabase(): Database {
  return {
    runReadOnly: async () => ({ rows: [{ ok: true }], truncated: false }),
    internalQuery: async () => [],
  } as unknown as Database
}

let httpServer: HttpServer | undefined

async function start(authToken?: string): Promise<string> {
  httpServer = await startHttpServer({
    // Port 0 asks the OS for a free one, so tests never collide with a real service.
    config: { host: '127.0.0.1', port: 0, authToken },
    createMcpServer: () =>
      createServer({
        context: {
          database: fakeDatabase(),
          contextFile: ContextStore.inMemory(),
          log: QueryLog.disabled(),
          maxRows: 10,
          maxOutputChars: 50_000,
          functions: FunctionPolicy.fromEntries([]),
        },
        version: '0.0.0-test',
        connectionString: 'postgres://user@localhost/app',
      }),
  })

  const { port } = httpServer.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

beforeAll(async () => {
  await ensureParserReady()
})

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()))
  httpServer = undefined
})

describe('HTTP transport', () => {
  it('serves a health check', async () => {
    const base = await start()

    const response = await fetch(`${base}/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('404s anything that is not the MCP endpoint', async () => {
    const base = await start()

    expect((await fetch(`${base}/`)).status).toBe(404)
  })

  it('completes an MCP session end to end', async () => {
    const base = await start()

    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)))

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_table_context',
      'list_tables',
      'query',
    ])

    await client.close()
  })
})

describe('bearer token', () => {
  it('rejects a request with no token when one is configured', async () => {
    const base = await start('secret')

    const response = await fetch(`${base}/mcp`, { method: 'POST' })

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('rejects a wrong token', async () => {
    const base = await start('secret')

    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong!' },
    })

    expect(response.status).toBe(401)
  })

  it('rejects a token that is merely a prefix of the real one', async () => {
    const base = await start('secret')

    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer sec' },
    })

    expect(response.status).toBe(401)
  })

  it('accepts the right token', async () => {
    const base = await start('secret')

    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: 'Bearer secret' } },
      })
    )

    expect((await client.listTools()).tools).not.toHaveLength(0)

    await client.close()
  })

  it('leaves the endpoint open when no token is configured', async () => {
    // The documented default is loopback-only; without a token anyone who reaches it is in.
    const base = await start()

    const response = await fetch(`${base}/mcp`, { method: 'POST' })

    expect(response.status).not.toBe(401)
  })
})

describe('DNS rebinding', () => {
  // fetch() will not let a caller choose the Host header, which is the whole point of the
  // attack, so these go through node:http directly.
  async function postWithHeaders(base: string, headers: Record<string, string>): Promise<number> {
    const { port } = new URL(base)
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        },
        (response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        }
      )
      request.on('error', reject)
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
    })
  }

  it('refuses a request whose Host is not local', async () => {
    const base = await start()

    expect(await postWithHeaders(base, { host: 'evil.example:8080' })).toBe(403)
  })

  it('refuses a local Host carrying a foreign browser Origin', async () => {
    const base = await start()

    expect(await postWithHeaders(base, { host: 'localhost', origin: 'https://evil.example' })).toBe(403)
  })

  it('allows local tools such as the MCP Inspector', async () => {
    const base = await start()

    const status = await postWithHeaders(base, { host: 'localhost', origin: 'http://localhost:6274' })

    expect(status).not.toBe(403)
  })
})

