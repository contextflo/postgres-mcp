import { appendFile, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_CONTEXT_DIRECTORY } from './context/context-file.js'

/**
 * `.contextflo/log.md` — an audit trail of every statement the agent ran, in a file a
 * human reads. Nothing here is served back to the model.
 *
 * Off unless asked for: enabled by `--log-file`, or automatically once `.contextflo/`
 * exists, since creating that directory with `init` is the opt-in. A database tool that
 * writes files into your project uninvited is a bad neighbour.
 */

export const DEFAULT_LOG_FILE = `${DEFAULT_CONTEXT_DIRECTORY}/log.md`

export type QueryOutcome = 'ok' | 'rejected' | 'error'

export interface QueryLogEntry {
  sql: string
  outcome: QueryOutcome
  rowCount?: number | undefined
  durationMs?: number | undefined
  /** Rejection reason or database error, for the non-ok outcomes. */
  message?: string | undefined
}

const FILE_HEADER = `# postgres-mcp query log

Every statement this server ran, newest last. Written for you, not for the model.
`

export class QueryLog {
  private readonly path: string | null
  /** Appends are chained so concurrent tool calls cannot interleave mid-entry. */
  private pending: Promise<void> = Promise.resolve()
  private warned = false

  private constructor(path: string | null) {
    this.path = path
  }

  static disabled(): QueryLog {
    return new QueryLog(null)
  }

  static enabled(path: string): QueryLog {
    return new QueryLog(path)
  }

  /**
   * Resolves whether to log at all: an explicit path wins, otherwise log only if the
   * context directory is already there.
   */
  static async resolve(options: {
    explicitPath?: string | undefined
    disabled: boolean
    contextDirectory: string
  }): Promise<QueryLog> {
    if (options.disabled) return QueryLog.disabled()
    if (options.explicitPath) return QueryLog.enabled(options.explicitPath)

    try {
      const info = await stat(options.contextDirectory)
      if (info.isDirectory()) return QueryLog.enabled(`${options.contextDirectory}/log.md`)
    } catch {
      // No context directory — nothing was opted into.
    }

    return QueryLog.disabled()
  }

  get isEnabled(): boolean {
    return this.path !== null
  }

  get filePath(): string | null {
    return this.path
  }

  /**
   * Never rejects. A failed write must not turn a successful query into a failed tool
   * call, so problems are reported once to stderr and then swallowed.
   */
  record(entry: QueryLogEntry): void {
    if (this.path === null) return

    this.pending = this.pending
      .then(() => this.write(this.path!, entry))
      .catch((error: unknown) => {
        if (this.warned) return
        this.warned = true
        console.error(
          `[postgres-mcp] could not write the query log at ${this.path}: ` +
            `${error instanceof Error ? error.message : String(error)}. Continuing without it.`
        )
      })
  }

  /** Waits for queued writes — used on shutdown so the last entry is not lost. */
  async flush(): Promise<void> {
    await this.pending
  }

  private async write(path: string, entry: QueryLogEntry): Promise<void> {
    let isNew = false
    try {
      await stat(path)
    } catch {
      isNew = true
      await mkdir(dirname(path), { recursive: true })
    }

    await appendFile(path, (isNew ? FILE_HEADER : '') + formatEntry(entry), 'utf8')
  }
}

function formatEntry(entry: QueryLogEntry): string {
  const parts = [new Date().toISOString(), entry.outcome]

  if (entry.rowCount !== undefined) parts.push(`${entry.rowCount} rows`)
  if (entry.durationMs !== undefined) parts.push(`${entry.durationMs}ms`)

  const heading = `\n## ${parts.join(' · ')}\n\n`
  const sql = '```sql\n' + entry.sql.trim() + '\n```\n'
  const message = entry.message ? `\n> ${entry.message.replace(/\n/g, '\n> ')}\n` : ''

  return heading + sql + message
}
