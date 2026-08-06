/**
 * node-postgres has supported `queryMode: 'extended'` since 8.11 (see
 * `pg/lib/query.js` — `requiresPreparation()` returns true for it), but `@types/pg` has
 * not caught up.
 *
 * This is not a convenience: forcing the extended query protocol is safety layer 1, and
 * without this declaration the compiler would push us back onto the simple-protocol call
 * that produced the archived server's CVE.
 */
import 'pg'

declare module 'pg' {
  interface QueryConfig<I = any[]> {
    queryMode?: 'extended' | undefined
  }
}
