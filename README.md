# @contextflo/postgres-mcp

The analytics MCP server for Postgres — read-only by construction, with schema context that makes answers correct.

A drop-in replacement for the archived `@modelcontextprotocol/server-postgres`, which shipped with a
[SQL injection vulnerability](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/)
that let `COMMIT; DROP SCHEMA public CASCADE` walk straight out of its read-only transaction.

```bash
npx @contextflo/postgres-mcp postgresql://localhost/mydb
```

## Why this one

**Read-only that holds up.** The archived server enforced read-only as a property of the SQL *string*. Here it is a
property of the connection, the role, and the wire protocol — four independent layers, each of which stops that
payload on its own. The exploit is a test case in this repo.

**Answers that make sense.** A model that does not know `fct_orders_v2` is the table your team actually uses, or that
`revenue` is gross rather than net, writes confident, wrong SQL. `.contextflo/context.md` is a markdown file you edit
and this server hands to the model. No database, no index, no service.

## Setup

Add it to your MCP client:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@contextflo/postgres-mcp", "postgresql://localhost/mydb"]
    }
  }
}
```

<details>
<summary>Claude Code, Cursor, Claude Desktop, VS Code</summary>

**Claude Code**

```bash
claude mcp add postgres -- npx -y @contextflo/postgres-mcp postgresql://localhost/mydb
```

**Cursor** — `.cursor/mcp.json`, same shape as above.

**Claude Desktop** — `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), same shape as above.

**VS Code** — `.vscode/mcp.json`:

```json
{
  "servers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@contextflo/postgres-mcp", "postgresql://localhost/mydb"]
    }
  }
}
```

</details>

Then generate a context file:

```bash
npx @contextflo/postgres-mcp init postgresql://localhost/mydb
```

That writes `.contextflo/context.md`, seeded from your `COMMENT ON` values, and prints the `CREATE ROLE` snippet for
a read-only role. Editing the file is the point — the business definitions section is where the value is.

## Tools

| Tool | What it does |
| --- | --- |
| `query` | Runs one read-only statement: `SELECT`, `WITH ... SELECT`, `EXPLAIN`, or `SHOW`. |
| `list_tables` | Lists readable tables with descriptions. `pattern` matches anywhere in the name or description. |
| `get_table_context` | Describes tables: columns, types, keys, foreign key targets, curated descriptions. |

There is no separate search tool, and that is deliberate. `information_schema` and `pg_catalog` are ordinary tables,
so anything more specific — find every column named like `%revenue%`, list tables with no primary key — is a query
the model can write itself:

```sql
SELECT table_schema, table_name, column_name
FROM information_schema.columns
WHERE column_name ILIKE '%revenue%';
```

Table schemas are also exposed as `postgres://<host>/<table>/schema` resources, matching the archived server, for
anything pinned to those URIs. Most clients never fetch resources on their own, which is why discovery lives in the
tools.

## How read-only is enforced

Four layers. Each one stops the archived server's exploit by itself.

**1. Extended query protocol.** User SQL goes through `pg-cursor`, which always issues Parse/Bind/Execute, so
Postgres itself rejects multi-statement input. The archived server called `client.query(sql)` with a bare string;
node-postgres only prepares a statement when there are bind values, so that took the *simple* protocol path, where
`;` separates statements. That is the whole bug.

**2. Connection-level read-only.** `default_transaction_read_only=on` is set in the startup packet, and every
statement runs inside an explicit `BEGIN READ ONLY` that always ends in `ROLLBACK` — never `COMMIT`. The rollback
also undoes any `SET` made inside the transaction, so a statement cannot leave a pooled connection weakened for
whoever gets it next.

**3. A statement allowlist on the real Postgres parser.** [`libpg-query`](https://github.com/launchql/libpg-query-node)
is the actual Postgres C parser compiled to WASM, not a JavaScript approximation of SQL. The whole parse tree is
walked rather than just the top-level node, which is what catches a data-modifying CTE:

```sql
WITH x AS (INSERT INTO users VALUES (1) RETURNING *) SELECT * FROM x
```

That parses as a `SelectStmt`. A validator checking only the statement type runs it. Unknown node types fail closed.

The same walk rejects built-in functions that act outside the transaction even inside a plain `SELECT`:
`dblink` (a second connection, which is not read-only), `query_to_xml` (runs a SQL string the parser never sees),
`pg_terminate_backend`, session-level advisory locks, `set_config`, and the server-filesystem functions.

**4. A read-only database role.** The layers above are code, and code has bugs. A role that cannot write is enforced
by Postgres regardless. `init` prints the snippet; this is the setup we recommend:

```sql
CREATE ROLE mcp_readonly LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE mydb TO mcp_readonly;
GRANT USAGE ON SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;
```

The server warns on startup if you connect as a superuser.

**What this does not protect against.** The parser cannot see inside a user-defined function, so a volatile or
`SECURITY DEFINER` function called from an allowed `SELECT` can do anything its body does — including open its own
connection. The function denylist covers the built-in escapes, not yours. Layer 4 is what stops the rest, which is
why the read-only role is the recommended setup rather than an optional extra. Read-only is also not confidentiality: anything the connected role
can read, a model can read, so grant it only what you want an agent to see.

## Migrating from `@modelcontextprotocol/server-postgres`

Swap the package name. The tool is still called `query`, still takes `sql`, still returns JSON rows, and the
connection string is still the first argument.

Four deliberate differences:

1. **Multi-statement SQL and `SET`/`RESET` are rejected** with a clear error. On the archived server these "worked" —
   that was the vulnerability.
2. **Results are capped** at 1000 rows by default. Truncation is stated in the output, never silent. Raise it with
   `--max-rows`.
3. **Schema discovery is a tool, not just a resource.** Most clients do not auto-attach resources, which is why
   models using the old server so often did not know the schema.
4. **All non-system schemas are visible**, not only `public`, and column descriptions come through from
   `COMMENT ON`.

## Options

```
--max-rows <n>            Maximum rows returned per query (default: 1000)
--statement-timeout <ms>  Server-side statement timeout (default: 30000)
--context-file <path>     Curated schema context (default: .contextflo/context.md)
--log-file <path>         Query audit log (default: .contextflo/log.md once that directory exists)
--no-log                  Never write a query log
--http                    Serve over streamable HTTP instead of stdio
--port <n>                HTTP port (default: 8080)
--host <addr>             HTTP bind address (default: 127.0.0.1)
```

`DATABASE_URL` supplies the connection string if you do not pass one. `AUTH_TOKEN`, with `--http`, requires that
value as a bearer token.

**Connection poolers.** PgBouncer — and so the pooled connection strings from Supabase, Neon, and others — refuses
the startup parameters this server normally sends. When that happens it reconnects without them and says so on
stderr. Nothing is weakened: every statement still runs in `BEGIN READ ONLY` with its own statement timeout, and CI
runs the read-only suite through PgBouncer in transaction mode.

## The context file

```markdown
# Database context

Revenue means gross, before refunds.
"Active customer" means an order in the last 90 days.

## Tables

### public.orders
One row per customer order. Source of truth for revenue — `orders_legacy` is not.

- revenue_usd — Gross revenue, before refunds. Net lives in `order_refunds`.
- status — One of pending, paid, refunded.
```

Everything above `## Tables` is handed to the model verbatim as server instructions. Under `## Tables`, a `###`
heading names a table, the prose beneath describes it, and `- column — meaning` lines describe columns. Your text
wins over `COMMENT ON`.

`init` seeds this from existing comments, and only for columns that already have one — a file with a blank
placeholder for all 4000 columns is a file nobody edits.

Richer context generated from your code and docs, and shared across a team, is what
[contextflo.com](https://contextflo.com) does.

## Query log

Once `.contextflo/` exists, every statement is appended to `.contextflo/log.md` with its outcome, row count, and
duration. It is written for you, not fed back to the model. `--no-log` turns it off.

## Docker

```bash
docker run -i --rm ghcr.io/contextflo/postgres-mcp postgresql://host.docker.internal/mydb
```

For a remote endpoint, see [`docker-compose.example.yml`](docker-compose.example.yml). Note what you are doing
before you bind `0.0.0.0`: that is a live database connection on a port. Set `AUTH_TOKEN`, keep it inside a private
network, and terminate TLS in front of it — the token is plaintext on the wire otherwise. The server prints a
warning when it is exposed without a token.

## Development

```bash
npm install
npm run build
npm test

npm run db:up   # throwaway Postgres for the integration suite (needs Docker)
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres npm test
npm run db:down
```

The integration suite deliberately bypasses the parser and drives the database directly, so it proves the wire and
transaction layers rather than the validator. It skips without `TEST_DATABASE_URL` and is required to run in CI.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

MIT
