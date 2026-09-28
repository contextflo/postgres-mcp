import type { Database } from './pool.js'

/**
 * Schema introspection straight off the live catalog.
 *
 * Everything here filters on `has_table_privilege`, so the picture the model gets is
 * scoped to what the connecting role can actually read. On the read-only role the README
 * recommends, that is a useful property rather than an accident.
 *
 * These are deliberately thin. The catalog is queryable SQL through the `query` tool, so
 * anything more specific than "list" and "describe" belongs there rather than in a tool
 * signature the model has to learn.
 */

/** Ordinary tables, views, materialized views, partitioned and foreign tables. */
const RELATION_KINDS = "('r', 'v', 'm', 'p', 'f')"

const VISIBLE_SCHEMAS = `
  n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp%'
`

export interface TableSummary {
  schema: string
  name: string
  /** `schema.name`, the identifier every other tool accepts. */
  fullyQualifiedName: string
  kind: string
  description: string | null
}

export interface ListTablesResult {
  tables: TableSummary[]
  /** Total matches before the limit was applied, so truncation can be stated rather than hidden. */
  totalMatches: number
}

export interface ColumnContext {
  name: string
  dataType: string
  isNullable: boolean
  defaultValue: string | null
  description: string | null
  isPrimaryKey: boolean
  /** `schema.table.column` this column references, when it is a foreign key. */
  references: string | null
  /** Labels in sort order, when the column's type is an enum. */
  enumValues: string[] | null
}

export interface TableContext {
  fullyQualifiedName: string
  kind: string
  description: string | null
  /** Planner estimate from `reltuples`, not an exact count — cheap on large tables. */
  approximateRows: number | null
  columns: ColumnContext[]
}

/**
 * Whether the connected role could change data if the other read-only layers failed: a
 * superuser, or write privileges on any visible table. `init` uses it to decide whether
 * to recommend a read-only role at all.
 */
export async function roleCanWrite(database: Database): Promise<boolean> {
  const [row] = await database.internalQuery<{ can_write: boolean }>(
    `
    SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
        OR EXISTS (
             SELECT 1
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r', 'p')
                AND ${VISIBLE_SCHEMAS}
                AND has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
           ) AS can_write
    `
  )
  return row?.can_write ?? true
}

/**
 * Lists tables, optionally narrowed by a case-insensitive substring.
 *
 * The pattern matches anywhere in the table name, the qualified name, or the table's
 * comment — the comment included because a table named `fct_orders` may be the one
 * someone means by "revenue", and a name-only match would report nothing and send the
 * model away empty-handed.
 */
export async function listTables(
  database: Database,
  options: { pattern?: string | undefined; schema?: string | undefined; limit: number }
): Promise<ListTablesResult> {
  const pattern = options.pattern ?? null
  const schema = options.schema ?? null

  const rows = await database.internalQuery<{
    schema: string
    name: string
    kind: string
    description: string | null
    total_matches: string
  }>(
    `
    SELECT n.nspname AS schema,
           c.relname AS name,
           CASE c.relkind
             WHEN 'r' THEN 'table'
             WHEN 'p' THEN 'partitioned table'
             WHEN 'v' THEN 'view'
             WHEN 'm' THEN 'materialized view'
             WHEN 'f' THEN 'foreign table'
           END AS kind,
           obj_description(c.oid, 'pg_class') AS description,
           count(*) OVER () AS total_matches
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ${RELATION_KINDS}
       AND ${VISIBLE_SCHEMAS}
       AND has_table_privilege(c.oid, 'SELECT')
       -- A table partitioned by day has hundreds of children; the parent is the one to query.
       AND NOT c.relispartition
       AND ($2::text IS NULL OR n.nspname = $2)
       AND (
         $1::text IS NULL
         OR c.relname ILIKE '%' || $4::text || '%'
         OR (n.nspname || '.' || c.relname) ILIKE '%' || $4::text || '%'
         OR obj_description(c.oid, 'pg_class') ILIKE '%' || $4::text || '%'
       )
     ORDER BY
       CASE
         WHEN $1::text IS NULL THEN 0
         WHEN lower(n.nspname || '.' || c.relname) = lower($1) THEN 0
         WHEN lower(c.relname) = lower($1) THEN 1
         WHEN c.relname ILIKE $4::text || '%' THEN 2
         WHEN c.relname ILIKE '%' || $4::text || '%' THEN 3
         ELSE 4
       END,
       n.nspname,
       c.relname
     LIMIT $3
    `,
    [pattern, schema, options.limit, pattern === null ? null : escapeLike(pattern)]
  )

  return {
    tables: rows.map((row) => ({
      schema: row.schema,
      name: row.name,
      fullyQualifiedName: `${row.schema}.${row.name}`,
      kind: row.kind,
      description: row.description,
    })),
    totalMatches: rows.length > 0 ? Number(rows[0]!.total_matches) : 0,
  }
}

/** `order_items` should match that name, not every table with "order" + any char + "items". */
function escapeLike(pattern: string): string {
  return pattern.replace(/[\\%_]/g, (character) => `\\${character}`)
}

/**
 * Describes several tables in one round trip — the model usually has two or three
 * candidates after a search and should not need a call each to choose between them.
 *
 * Names are matched case-insensitively, and an unqualified name resolves against any
 * visible schema, because a model that read `orders` in a list will ask for `orders`.
 */
export async function getTableContext(
  database: Database,
  fullyQualifiedNames: string[]
): Promise<TableContext[]> {
  if (fullyQualifiedNames.length === 0) return []

  const wanted = fullyQualifiedNames.map((name) => name.toLowerCase())

  const rows = await database.internalQuery<{
    schema: string
    table: string
    kind: string
    table_description: string | null
    approximate_rows: string | null
    column_name: string | null
    data_type: string | null
    is_nullable: boolean | null
    default_value: string | null
    column_description: string | null
    is_primary_key: boolean | null
    references: string | null
    enum_values: string[] | null
    ordinal: number | null
  }>(
    `
    SELECT n.nspname AS schema,
           c.relname AS table,
           CASE c.relkind
             WHEN 'r' THEN 'table'
             WHEN 'p' THEN 'partitioned table'
             WHEN 'v' THEN 'view'
             WHEN 'm' THEN 'materialized view'
             WHEN 'f' THEN 'foreign table'
           END AS kind,
           obj_description(c.oid, 'pg_class') AS table_description,
           NULLIF(c.reltuples, -1) AS approximate_rows,
           a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           NOT a.attnotnull AS is_nullable,
           pg_get_expr(d.adbin, d.adrelid) AS default_value,
           col_description(c.oid, a.attnum) AS column_description,
           EXISTS (
             SELECT 1 FROM pg_index i
              WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)
           ) AS is_primary_key,
           (
             SELECT tn.nspname || '.' || tc.relname || '.' || ta.attname
               FROM pg_constraint con
               JOIN pg_class tc ON tc.oid = con.confrelid
               JOIN pg_namespace tn ON tn.oid = tc.relnamespace
               JOIN pg_attribute ta
                 ON ta.attrelid = con.confrelid
                AND ta.attnum = con.confkey[array_position(con.conkey, a.attnum)]
              WHERE con.conrelid = c.oid
                AND con.contype = 'f'
                AND a.attnum = ANY (con.conkey)
              LIMIT 1
           ) AS references,
           (
             SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
               FROM pg_enum e
              WHERE e.enumtypid = a.atttypid
           ) AS enum_values,
           a.attnum AS ordinal
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute a
        ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE c.relkind IN ${RELATION_KINDS}
       AND ${VISIBLE_SCHEMAS}
       AND has_table_privilege(c.oid, 'SELECT')
       AND (
         lower(n.nspname || '.' || c.relname) = ANY ($1::text[])
         OR lower(c.relname) = ANY ($1::text[])
       )
     ORDER BY n.nspname, c.relname, a.attnum
    `,
    [wanted]
  )

  const byTable = new Map<string, TableContext>()

  for (const row of rows) {
    const fullyQualifiedName = `${row.schema}.${row.table}`

    let table = byTable.get(fullyQualifiedName)
    if (!table) {
      table = {
        fullyQualifiedName,
        kind: row.kind,
        description: row.table_description,
        approximateRows: row.approximate_rows === null ? null : Math.max(0, Math.round(Number(row.approximate_rows))),
        columns: [],
      }
      byTable.set(fullyQualifiedName, table)
    }

    if (row.column_name !== null) {
      table.columns.push({
        name: row.column_name,
        dataType: row.data_type ?? 'unknown',
        isNullable: row.is_nullable ?? true,
        defaultValue: row.default_value,
        description: row.column_description,
        isPrimaryKey: row.is_primary_key ?? false,
        references: row.references,
        enumValues: row.enum_values,
      })
    }
  }

  return [...byTable.values()]
}
