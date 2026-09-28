import type { ContextStore } from '../context/store.js'
import type { Database } from '../db/pool.js'
import type { QueryLog } from '../log.js'
import type { FunctionPolicy } from '../safety/functions.js'

/** Everything the tools share. Assembled once at startup in src/index.ts. */
export interface ToolContext {
  database: Database
  contextFile: ContextStore
  log: QueryLog
  /** Which functions a query may call, from the database's own catalog. */
  functions: FunctionPolicy
  maxRows: number
  /** Character budget for one query result, so a wide result cannot flood the model's context. */
  maxOutputChars: number
}
