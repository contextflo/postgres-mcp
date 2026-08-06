/**
 * Stable rejection codes. These are asserted on by the adversarial test suite and
 * surfaced to the model in tool errors, so treat them as part of the public contract.
 */
export type SafetyCode =
  | 'PARSE_ERROR'
  | 'EMPTY_STATEMENT'
  | 'MULTIPLE_STATEMENTS'
  | 'STATEMENT_NOT_ALLOWED'
  | 'SELECT_INTO'
  | 'LOCKING_CLAUSE'

export class SafetyError extends Error {
  readonly code: SafetyCode

  constructor(code: SafetyCode, message: string) {
    super(message)
    this.name = 'SafetyError'
    this.code = code
  }
}

/**
 * Parse-tree node names are not what a user typed. Map the common ones back to SQL
 * keywords so the rejection message is actionable rather than an implementation detail.
 */
const STATEMENT_KEYWORDS: Record<string, string> = {
  InsertStmt: 'INSERT',
  UpdateStmt: 'UPDATE',
  DeleteStmt: 'DELETE',
  MergeStmt: 'MERGE',
  TruncateStmt: 'TRUNCATE',
  CopyStmt: 'COPY',
  DropStmt: 'DROP',
  CreateStmt: 'CREATE TABLE',
  CreateTableAsStmt: 'CREATE TABLE AS',
  CreateFunctionStmt: 'CREATE FUNCTION',
  CreateRoleStmt: 'CREATE ROLE',
  AlterTableStmt: 'ALTER TABLE',
  AlterRoleStmt: 'ALTER ROLE',
  GrantStmt: 'GRANT/REVOKE',
  GrantRoleStmt: 'GRANT/REVOKE ROLE',
  DoStmt: 'DO',
  CallStmt: 'CALL',
  TransactionStmt: 'BEGIN/COMMIT/ROLLBACK',
  VariableSetStmt: 'SET/RESET',
  DeclareCursorStmt: 'DECLARE CURSOR',
  FetchStmt: 'FETCH/MOVE',
  ClosePortalStmt: 'CLOSE',
  PrepareStmt: 'PREPARE',
  ExecuteStmt: 'EXECUTE',
  DeallocateStmt: 'DEALLOCATE',
  LockStmt: 'LOCK',
  NotifyStmt: 'NOTIFY',
  ListenStmt: 'LISTEN',
  UnlistenStmt: 'UNLISTEN',
  VacuumStmt: 'VACUUM/ANALYZE',
  ReindexStmt: 'REINDEX',
  ClusterStmt: 'CLUSTER',
  RefreshMatViewStmt: 'REFRESH MATERIALIZED VIEW',
  IndexStmt: 'CREATE INDEX',
  ViewStmt: 'CREATE VIEW',
  RuleStmt: 'CREATE RULE',
  CreatedbStmt: 'CREATE DATABASE',
  DropdbStmt: 'DROP DATABASE',
  CreateSchemaStmt: 'CREATE SCHEMA',
  CreateTrigStmt: 'CREATE TRIGGER',
  CreateExtensionStmt: 'CREATE EXTENSION',
  AlterSystemStmt: 'ALTER SYSTEM',
  CheckPointStmt: 'CHECKPOINT',
}

/** Falls back to de-camel-casing the node name so unknown types still read sensibly. */
export function describeStatement(nodeName: string): string {
  const known = STATEMENT_KEYWORDS[nodeName]
  if (known) return known
  return nodeName.replace(/Stmt$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()
}
