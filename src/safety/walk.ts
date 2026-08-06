/**
 * Walking the whole parse tree — not just the top-level node — is the point of this file.
 *
 * `WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x` parses to a
 * SelectStmt at the top, with the InsertStmt buried at
 * `SelectStmt.withClause.ctes[].CommonTableExpr.ctequery.InsertStmt`. A validator that
 * only inspects the top-level statement type waves that through, and it writes.
 */

/**
 * Postgres parse trees wrap every node as `{ PascalCaseTypeName: { ...fields } }`, while
 * plain fields are camelCase (`stmt`, `ctequery`, `withClause`). Requiring a leading
 * capital keeps this from matching a field that merely ends in "Stmt".
 */
const STATEMENT_NODE_KEY = /^[A-Z][A-Za-z0-9]*Stmt$/

export interface StatementNode {
  /** Parse-tree node name, e.g. `SelectStmt`. */
  name: string
  /** The node's fields. */
  fields: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Yields every statement node anywhere in the tree, in document order, including the
 * root. Callers check membership against an allowlist so unfamiliar node types — from a
 * future Postgres, say — fail closed instead of slipping through a denylist.
 */
export function* findStatementNodes(node: unknown): Generator<StatementNode> {
  if (Array.isArray(node)) {
    for (const item of node) yield* findStatementNodes(item)
    return
  }

  if (!isRecord(node)) return

  for (const [key, value] of Object.entries(node)) {
    if (STATEMENT_NODE_KEY.test(key) && isRecord(value)) {
      yield { name: key, fields: value }
    }
    yield* findStatementNodes(value)
  }
}
