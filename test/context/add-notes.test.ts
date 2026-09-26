import { describe, expect, it } from 'vitest'
import { addTableNotes, notesForTable, parseContextFile } from '../../src/context/context-file.js'

const SAMPLE = `# Database context

Revenue means gross, before refunds.

## Tables

### public.orders
One row per customer order.

- revenue_usd — Gross revenue, before refunds.
- status — One of pending, paid, refunded

### public.customers
Everyone who has signed up.
`

describe('addTableNotes', () => {
  it('appends a column note to the existing line without replacing it', () => {
    const updated = addTableNotes(SAMPLE, 'public.orders', {
      columns: { status: "Also 'void' on rows before 2022." },
    })

    expect(updated).toContain("- status — One of pending, paid, refunded. Also 'void' on rows before 2022.")
    expect(notesForTable(parseContextFile(updated), 'public.orders')?.columns.get('status')).toBe(
      "One of pending, paid, refunded. Also 'void' on rows before 2022."
    )
  })

  it('adds a new column line after the existing ones', () => {
    const updated = addTableNotes(SAMPLE, 'public.orders', { columns: { amount_cents: 'In cents, not dollars.' } })

    const lines = updated.split('\n')
    expect(lines.indexOf('- amount_cents — In cents, not dollars.')).toBe(
      lines.findIndex((line) => line.startsWith('- status')) + 1
    )
    expect(notesForTable(parseContextFile(updated), 'public.orders')?.columns.get('amount_cents')).toBe(
      'In cents, not dollars.'
    )
  })

  it('appends a table note to the description, not after the column list', () => {
    const updated = addTableNotes(SAMPLE, 'public.orders', { note: 'Exclude rows where test_order is true.' })

    expect(notesForTable(parseContextFile(updated), 'public.orders')?.description).toBe(
      'One row per customer order. Exclude rows where test_order is true.'
    )
  })

  it('gives a table with only prose its first column list', () => {
    const updated = addTableNotes(SAMPLE, 'public.customers', { columns: { email: 'Lower-cased on write.' } })

    const customers = notesForTable(parseContextFile(updated), 'public.customers')
    expect(customers?.description).toBe('Everyone who has signed up.')
    expect(customers?.columns.get('email')).toBe('Lower-cased on write.')
  })

  it('adds a section for a table the file does not mention yet', () => {
    const updated = addTableNotes(SAMPLE, 'analytics.events', {
      note: 'Append-only.',
      columns: { ts: 'UTC.' },
    })

    const events = notesForTable(parseContextFile(updated), 'analytics.events')
    expect(events?.description).toBe('Append-only.')
    expect(events?.columns.get('ts')).toBe('UTC.')
  })

  it('reuses a section headed with the bare table name', () => {
    const raw = '## Tables\n\n### orders\nOne row per order.\n'

    const updated = addTableNotes(raw, 'public.orders', { note: 'Soft-deleted rows have deleted_at set.' })

    expect(updated.match(/^### /gm)).toHaveLength(1)
    expect(updated).toContain('One row per order.\nSoft-deleted rows have deleted_at set.')
  })

  it('leaves everything else in the file untouched', () => {
    const updated = addTableNotes(SAMPLE, 'public.orders', { columns: { status: 'Extra.' } })

    expect(updated.replace('. Extra.', '')).toBe(SAMPLE)
  })

  it('is idempotent: the same note twice is written once', () => {
    const notes = { note: 'Test orders excluded.', columns: { status: 'Extra.' } }

    const once = addTableNotes(SAMPLE, 'public.orders', notes)
    const twice = addTableNotes(once, 'public.orders', notes)

    expect(twice).toBe(once)
  })

  it('keeps a note on one line so it cannot break the file structure', () => {
    const updated = addTableNotes(SAMPLE, 'public.orders', {
      note: '- looks like a bullet\n### and a heading',
      columns: { status: 'two\nlines' },
    })

    const document = parseContextFile(updated)
    expect(document.tables.size).toBe(2)
    expect(notesForTable(document, 'public.orders')?.columns.get('status')).toContain('two lines')
    expect(notesForTable(document, 'public.orders')?.columns.has('looks')).toBe(false)
  })

  it('starts a new file from the standard header', () => {
    const updated = addTableNotes('', 'public.orders', { note: 'One row per order.' })

    expect(updated).toContain('## Business definitions')
    expect(notesForTable(parseContextFile(updated), 'public.orders')?.description).toBe('One row per order.')
  })
})
