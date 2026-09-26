import type { ContextDocument } from '../context/context-file.js'
import type { Database } from '../db/pool.js'
import type { QueryLog } from '../log.js'

/** Everything the tools share. Assembled once at startup in src/index.ts. */
export interface ToolContext {
  database: Database
  contextDocument: ContextDocument
  log: QueryLog
  maxRows: number
  /** Character budget for one query result, so a wide result cannot flood the model's context. */
  maxOutputChars: number
}
