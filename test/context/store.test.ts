import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { notesForTable } from '../../src/context/context-file.js'
import { ContextStore } from '../../src/context/store.js'

describe('ContextStore', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'postgres-mcp-context-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('picks up an edit made while the server is running', async () => {
    const path = join(directory, 'context.md')
    await writeFile(path, '## Tables\n\n### public.orders\nFirst.\n')
    const store = await ContextStore.open(path, { writable: false })

    await writeFile(path, '## Tables\n\n### public.orders\nSecond, and longer.\n')

    expect(notesForTable(await store.refresh(), 'public.orders')?.description).toBe('Second, and longer.')
  })

  it('creates the file and directory on the first note, and serves it straight away', async () => {
    const path = join(directory, 'nested', 'context.md')
    const store = await ContextStore.open(path, { writable: true })

    await store.addNotes('public.orders', { note: 'One row per order.' })

    expect(await readFile(path, 'utf8')).toContain('### public.orders')
    expect(notesForTable(store.current, 'public.orders')?.description).toBe('One row per order.')
  })

  it('does not lose either of two notes added at once', async () => {
    const path = join(directory, 'context.md')
    const store = await ContextStore.open(path, { writable: true })

    await Promise.all([
      store.addNotes('public.orders', { columns: { a: 'First.' } }),
      store.addNotes('public.orders', { columns: { b: 'Second.' } }),
    ])

    const orders = notesForTable(store.current, 'public.orders')
    expect(orders?.columns.get('a')).toBe('First.')
    expect(orders?.columns.get('b')).toBe('Second.')
  })

  it('refuses to write when writes are off', async () => {
    const store = await ContextStore.open(join(directory, 'context.md'), { writable: false })

    await expect(store.addNotes('public.orders', { note: 'x' })).rejects.toThrow(/disabled/)
  })
})
