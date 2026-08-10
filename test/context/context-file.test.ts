import { describe, expect, it } from 'vitest'
import { notesForTable, parseContextFile, preferCuratedDescription } from '../../src/context/context-file.js'

const SAMPLE = `# Database context

<!-- a comment the parser should not choke on -->

Revenue means gross, before refunds.
"Active customer" means an order in the last 90 days.

## Tables

### public.orders
One row per customer order.
Source of truth for revenue.

- revenue_usd — Gross revenue, before refunds.
- \`status\` — One of pending, paid, refunded.
- customer_id: FK to the customer who placed it

### analytics.revenue_daily
Rebuilt nightly at 03:00 UTC.
`

describe('parseContextFile', () => {
  it('passes everything above "## Tables" through as the preamble', () => {
    const document = parseContextFile(SAMPLE)

    expect(document.preamble).toContain('Revenue means gross')
    expect(document.preamble).toContain('Active customer')
    expect(document.preamble).not.toContain('public.orders')
  })

  it('reads table descriptions from the prose under each heading', () => {
    const document = parseContextFile(SAMPLE)

    expect(notesForTable(document, 'public.orders')?.description).toBe(
      'One row per customer order. Source of truth for revenue.'
    )
    expect(notesForTable(document, 'analytics.revenue_daily')?.description).toBe(
      'Rebuilt nightly at 03:00 UTC.'
    )
  })

  it('accepts the several ways a person might write a column line', () => {
    const columns = notesForTable(parseContextFile(SAMPLE), 'public.orders')!.columns

    expect(columns.get('revenue_usd')).toBe('Gross revenue, before refunds.')
    expect(columns.get('status')).toBe('One of pending, paid, refunded.')
    expect(columns.get('customer_id')).toBe('FK to the customer who placed it')
  })

  it('matches table names case-insensitively and unqualified', () => {
    const document = parseContextFile(SAMPLE)

    expect(notesForTable(document, 'PUBLIC.ORDERS')?.description).toBeDefined()
    // A single-schema database where somebody wrote "### orders".
    expect(notesForTable(parseContextFile('## Tables\n\n### orders\nNotes.\n'), 'public.orders')?.description).toBe(
      'Notes.'
    )
  })

  it('handles a file with no tables section at all', () => {
    const document = parseContextFile('Just some notes about the database.\n')

    expect(document.preamble).toBe('Just some notes about the database.')
    expect(document.tables.size).toBe(0)
  })

  it('handles an empty file', () => {
    const document = parseContextFile('')

    expect(document.preamble).toBe('')
    expect(document.tables.size).toBe(0)
  })

  it('ignores prose that follows the column list', () => {
    // Trailing notes should not silently become the table description.
    const document = parseContextFile(
      '## Tables\n\n### public.orders\nReal description.\n\n- id — the id\n\nsome trailing prose\n'
    )

    expect(notesForTable(document, 'public.orders')?.description).toBe('Real description.')
  })
})

describe('preferCuratedDescription', () => {
  it('lets the hand-written file win over the database comment', () => {
    expect(preferCuratedDescription('curated', 'from catalog')).toBe('curated')
  })

  it('falls back to the catalog comment', () => {
    expect(preferCuratedDescription(undefined, 'from catalog')).toBe('from catalog')
    expect(preferCuratedDescription(undefined, null)).toBeNull()
  })
})
