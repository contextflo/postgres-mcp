import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    const store = await ContextStore.open(path)

    await writeFile(path, '## Tables\n\n### public.orders\nSecond, and longer.\n')

    expect(notesForTable(await store.refresh(), 'public.orders')?.description).toBe('Second, and longer.')
  })
})
