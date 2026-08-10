# Security policy

This server exists because the one it replaces had a vulnerability. Reports are welcome and taken seriously.

## Reporting

Please do not open a public issue for a vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/contextflo/postgres-mcp/security/advisories/new), or email
**security@contextflo.com**.

Include the SQL or request that reproduces it, the Postgres version, and how the server was started. We aim to
acknowledge within two business days.

## In scope

Anything that gets a write, DDL, or command execution past the read-only layers. Specifically:

- SQL that modifies data or schema and is not rejected
- Escaping the read-only transaction, or leaving a pooled connection writable for the next caller
- Multiple statements executing from a single `query` call
- Reading a table the connected role has no `SELECT` on
- Authentication bypass on the HTTP transport when `AUTH_TOKEN` is set

## Out of scope

These are documented behaviors rather than vulnerabilities:

- **Reading anything the connected role can read.** Read-only is not confidentiality. Grant the role only what an
  agent should see.
- **An unauthenticated HTTP endpoint that was deliberately exposed.** Binding a non-loopback address requires an
  explicit `--host`, and the server warns loudly when it is exposed without `AUTH_TOKEN`.
- **Side effects of a volatile or `SECURITY DEFINER` function called from an allowed `SELECT`.** The parser cannot
  see through function bodies. This is what the read-only role exists for, and why it is the recommended setup.
- **Resource exhaustion from an expensive but legitimate query.** `statement_timeout` and the row cap bound it;
  tune them for your database.
- **Anything requiring an already-compromised connection string.** The connection string is the credential.

## How read-only is enforced

Four independent layers, described in detail in the [README](README.md#how-read-only-is-enforced). The design intent
is that any single layer failing still leaves the others holding — so a bypass of one is a real finding even if it
does not by itself let you write.
