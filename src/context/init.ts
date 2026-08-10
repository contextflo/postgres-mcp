import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getTableContext, listTables, type TableContext } from '../db/introspection.js'
import type { Database } from '../db/pool.js'

/**
 * `init` — scan the schema and write a context file worth editing.
 *
 * The temptation is to emit a placeholder line for every column of every table. On a
 * real warehouse that is thousands of blank lines, and a file nobody edits is a file
 * that does nothing. So: every table gets a heading, but only columns that already carry
 * a COMMENT are seeded. The file stays proportional to what is already documented, and
 * adding a line for an undocumented column is one line of typing.
 */

const MAX_TABLES = 1000

export interface InitResult {
  path: string
  tableCount: number
  seededColumnCount: number
  truncated: boolean
  schemas: string[]
}

export class ContextFileExists extends Error {
  constructor(path: string) {
    super(
      `${path} already exists. Delete it to regenerate, or pass --context-file to write elsewhere — ` +
        'refusing to overwrite notes you may have written by hand.'
    )
  }
}

export async function runInit(database: Database, contextFile: string): Promise<InitResult> {
  const { tables, totalMatches } = await listTables(database, { limit: MAX_TABLES })
  const described = await getTableContext(
    database,
    tables.map((table) => table.fullyQualifiedName)
  )

  const markdown = renderContextFile(described)

  await mkdir(dirname(contextFile), { recursive: true })
  // 'wx' fails if the file exists, so a hand-edited context file is never clobbered.
  try {
    await writeFile(contextFile, markdown, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ContextFileExists(contextFile)
    throw error
  }

  return {
    path: contextFile,
    tableCount: described.length,
    seededColumnCount: described.reduce(
      (total, table) => total + table.columns.filter((column) => column.description).length,
      0
    ),
    truncated: totalMatches > tables.length,
    schemas: [...new Set(described.map((table) => table.fullyQualifiedName.split('.')[0]!))].sort(),
  }
}

function renderContextFile(tables: TableContext[]): string {
  const sections = tables.map((table) => {
    const lines = [`### ${table.fullyQualifiedName}`]

    lines.push(table.description ?? '')

    const documented = table.columns.filter((column) => column.description)
    if (documented.length > 0) {
      lines.push('')
      for (const column of documented) {
        lines.push(`- ${column.name} — ${column.description}`)
      }
    }

    return lines.join('\n')
  })

  return `${HEADER}\n${sections.join('\n\n')}\n`
}

const HEADER = `# Database context

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
-->

## Business definitions

_Replace this with the definitions a new analyst would get wrong on their first day._

## Tables
`

/** The setup that makes read-only true regardless of any bug in this server. */
export function readOnlyRoleSnippet(databaseName: string, schemas: string[]): string {
  const grants = schemas
    .flatMap((schema) => [
      `GRANT USAGE ON SCHEMA ${schema} TO mcp_readonly;`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO mcp_readonly;`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO mcp_readonly;`,
    ])
    .join('\n')

  return `CREATE ROLE mcp_readonly LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE ${databaseName} TO mcp_readonly;
${grants}`
}
