import { readFile } from 'node:fs/promises'

/**
 * `.contextflo/context.md` — the whole context layer.
 *
 * No database, no embeddings, no index: a markdown file a human edits and this server
 * hands to the model. The catalog can say a column is `numeric(12,2)` named `revenue`;
 * only a person can say it is gross rather than net, or that `fct_orders_v2` is the one
 * the team actually uses.
 *
 * Parsing is deliberately forgiving. This file's job is to be edited by hand, so anything
 * it does not recognise is left alone rather than treated as an error — a file that
 * rejects your notes is a file you stop updating.
 */

export const DEFAULT_CONTEXT_DIRECTORY = '.contextflo'
export const DEFAULT_CONTEXT_FILE = `${DEFAULT_CONTEXT_DIRECTORY}/context.md`

/** Everything above this heading is passed to the model verbatim. */
const TABLES_HEADING = /^##\s+tables\s*$/i
const TABLE_HEADING = /^###\s+(.+?)\s*$/
/** `- \`col\` — meaning`, `- col: meaning`, `- col - meaning`. */
const COLUMN_LINE = /^[-*]\s+`?([A-Za-z_][\w$]*)`?\s*(?:[—–:-])\s*(.+)$/

export interface TableNotes {
  description?: string
  columns: Map<string, string>
}

export interface ContextDocument {
  /** Free text above `## Tables`: business definitions, caveats, which tables to prefer. */
  preamble: string
  /** Keyed by lower-cased `schema.table`. */
  tables: Map<string, TableNotes>
}

export function emptyContextDocument(): ContextDocument {
  return { preamble: '', tables: new Map() }
}

/** Returns null when the file does not exist — the server runs fine without one. */
export async function loadContextFile(path: string): Promise<ContextDocument | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  return parseContextFile(raw)
}

export function parseContextFile(raw: string): ContextDocument {
  const document = emptyContextDocument()
  const lines = raw.split(/\r?\n/)

  let index = 0
  const preamble: string[] = []

  while (index < lines.length && !TABLES_HEADING.test(lines[index]!)) {
    preamble.push(lines[index]!)
    index++
  }
  // HTML comments are notes to the human editing the file (init writes one), not to the model.
  document.preamble = preamble.join('\n').replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()

  index++ // step past "## Tables"

  let current: TableNotes | undefined
  let descriptionLines: string[] = []

  const flush = (): void => {
    if (current) {
      const description = descriptionLines.join(' ').trim()
      if (description) current.description = description
    }
    descriptionLines = []
  }

  for (; index < lines.length; index++) {
    const line = lines[index]!

    const heading = TABLE_HEADING.exec(line)
    if (heading) {
      flush()
      current = { columns: new Map() }
      document.tables.set(heading[1]!.trim().toLowerCase(), current)
      continue
    }

    if (!current) continue

    const column = COLUMN_LINE.exec(line)
    if (column) {
      flush()
      current.columns.set(column[1]!.toLowerCase(), column[2]!.trim())
      continue
    }

    // Prose between the heading and the first bullet is the table's description.
    if (current.columns.size === 0 && line.trim() !== '' && !line.startsWith('#')) {
      descriptionLines.push(line.trim())
    }
  }

  flush()

  return document
}

export function notesForTable(document: ContextDocument, fullyQualifiedName: string): TableNotes | undefined {
  const notes = document.tables.get(fullyQualifiedName.toLowerCase())
  if (notes) return notes

  // Tolerate an unqualified heading like "### orders" for a single-schema database.
  const bare = fullyQualifiedName.split('.').pop()
  return bare ? document.tables.get(bare.toLowerCase()) : undefined
}

/**
 * The curated file wins over the database comment. `init` seeds the file from comments,
 * so the two agree until somebody edits — and an edit is exactly the signal to prefer it.
 */
export function preferCuratedDescription(
  curated: string | undefined,
  fromCatalog: string | null
): string | null {
  return curated ?? fromCatalog
}

export interface NewTableNotes {
  /** Appended to the table's description. */
  note?: string | undefined
  /** Column name → note, appended to that column's line or added as a new one. */
  columns?: Record<string, string> | undefined
}

/**
 * Adds notes to the file's text, touching nothing else — the file belongs to the humans
 * editing it, so formatting, comments, and ordering all survive.
 *
 * Append-only by design. A note never replaces what is there: when the table or column
 * already has a description, the note is added after it. Anything an agent writes can be
 * reviewed in a diff and deleted, and nothing a person wrote is ever lost to it.
 *
 * `fullyQualifiedName` is the resolved `schema.table`. An existing section headed with
 * the bare table name is reused rather than duplicated.
 */
export function addTableNotes(raw: string, fullyQualifiedName: string, notes: NewTableNotes): string {
  const lines = (raw.trim() === '' ? CONTEXT_FILE_HEADER : raw).replace(/\r\n/g, '\n').split('\n')

  if (!lines.some((line) => TABLES_HEADING.test(line))) {
    trimTrailingBlankLines(lines)
    lines.push('', '## Tables', '')
  }

  // A leading bullet would make the parser read the note as a column line.
  const tableNote = notes.note ? singleLine(notes.note).replace(/^[-*]\s+/, '') : undefined
  const columnNotes = Object.entries(notes.columns ?? {})
    .map(([column, note]) => [column, singleLine(note)] as const)
    .filter(([, note]) => note !== '')

  const section = findTableSection(lines, fullyQualifiedName)

  if (!section) {
    trimTrailingBlankLines(lines)
    lines.push('', `### ${fullyQualifiedName}`)
    if (tableNote) lines.push(tableNote)
    if (columnNotes.length > 0) {
      lines.push('')
      for (const [column, note] of columnNotes) lines.push(`- ${column} — ${note}`)
    }
    return `${lines.join('\n')}\n`
  }

  let end = section.end

  for (const [column, note] of columnNotes) {
    const existing = findColumnLine(lines, section.start, end, column)
    if (existing !== -1) {
      lines[existing] = appendSentence(lines[existing]!, note)
      continue
    }

    // After the section's last column line; or, for the first one, after the prose with a
    // blank line between, which is how the parser tells a description from a column list.
    const lastColumn = findLastColumnLine(lines, section.start, end)
    const inserted = lastColumn === -1 ? ['', `- ${column} — ${note}`] : [`- ${column} — ${note}`]
    const at = lastColumn === -1 ? lastContentLine(lines, section.start, end) + 1 : lastColumn + 1
    lines.splice(at, 0, ...inserted)
    end += inserted.length
  }

  if (tableNote && !sectionText(lines, section.start, end).includes(tableNote)) {
    // The parser reads prose between the heading and the first column line as the
    // description, so the note goes at the end of that prose.
    const firstColumn = findFirstColumnLine(lines, section.start, end)
    const proseEnd = lastContentLine(lines, section.start, firstColumn === -1 ? end : firstColumn)
    lines.splice(proseEnd + 1, 0, tableNote)
  }

  return `${lines.join('\n').replace(/\n*$/, '')}\n`
}

/** Section bounds as [start, end): `start` is the heading line. */
function findTableSection(lines: string[], fullyQualifiedName: string): { start: number; end: number } | undefined {
  const tablesAt = lines.findIndex((line) => TABLES_HEADING.test(line))
  const wanted = fullyQualifiedName.toLowerCase()
  const bare = wanted.split('.').pop()

  const headings = lines
    .map((line, index) => ({ index, name: TABLE_HEADING.exec(line)?.[1]?.trim().toLowerCase() }))
    .filter((heading) => heading.index > tablesAt && heading.name !== undefined)

  const match =
    headings.find((heading) => heading.name === wanted) ?? headings.find((heading) => heading.name === bare)
  if (!match) return undefined

  let end = match.index + 1
  while (end < lines.length && !/^#{1,3}\s/.test(lines[end]!)) end++
  return { start: match.index, end }
}

function findColumnLine(lines: string[], start: number, end: number, column: string): number {
  for (let index = start + 1; index < end; index++) {
    if (COLUMN_LINE.exec(lines[index]!)?.[1]?.toLowerCase() === column.toLowerCase()) return index
  }
  return -1
}

function findFirstColumnLine(lines: string[], start: number, end: number): number {
  for (let index = start + 1; index < end; index++) {
    if (COLUMN_LINE.test(lines[index]!)) return index
  }
  return -1
}

function findLastColumnLine(lines: string[], start: number, end: number): number {
  for (let index = end - 1; index > start; index--) {
    if (COLUMN_LINE.test(lines[index]!)) return index
  }
  return -1
}

/** The last non-blank line in (start, end), or `start` itself when there is none. */
function lastContentLine(lines: string[], start: number, end: number): number {
  for (let index = end - 1; index > start; index--) {
    if (lines[index]!.trim() !== '') return index
  }
  return start
}

function sectionText(lines: string[], start: number, end: number): string {
  return lines.slice(start, end).join('\n')
}

function appendSentence(line: string, note: string): string {
  if (line.includes(note)) return line
  const trimmed = line.trimEnd()
  return /[.!?]$/.test(trimmed) ? `${trimmed} ${note}` : `${trimmed}. ${note}`
}

/** A note is one line: a newline would end the column line or split the description. */
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function trimTrailingBlankLines(lines: string[]): void {
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
}

export const CONTEXT_FILE_HEADER = `# Database context

<!--
postgres-mcp reads this file and hands it to the model every session. It is the whole
context layer — no database, no index, just this file.

Everything above "## Tables" is passed through verbatim. Put the things your team
argues about here: whether revenue is gross or net, what counts as an active customer,
which table is the source of truth and which one nobody got around to dropping.

Under "## Tables", a "###" heading names a table, the prose beneath it describes the
table, and each "- column — meaning" line describes a column. Seeded from your
database's COMMENT ON values; anything you write wins over those.

Add a line for any column you like — only already-commented ones were seeded, to keep
this file small enough that you will actually edit it.

The agent can add notes here too, with the add_table_context tool, when it finds
something about the data the next person would get wrong. It only ever appends, so
review those additions in a diff like any other change.
-->

## Business definitions

_Replace this with the definitions a new analyst would get wrong on their first day._

## Tables
`
