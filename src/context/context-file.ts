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
  document.preamble = preamble.join('\n').trim()

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
