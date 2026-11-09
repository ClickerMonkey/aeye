/**
 * SQL-converter barrel: emit primitives, the dialect hierarchy, the
 * join/CTE planner, and RLS injection.
 */
export {
  SqlText,
  SqlContext,
  type SqlValue,
  type SqlParamValue,
  type RenderedSql,
  raw,
  param,
  concat,
  join,
} from './emit';
export { Dialect, type ValueSite } from './dialect';
export { BaseDialect } from './base-dialect';
export { PostgresDialect } from './postgres-dialect';
export { SqliteDialect } from './sqlite-dialect';
export { SqlServerDialect } from './sqlserver-dialect';
export { JoinCtePlanner, type JoinRequest } from './planner';
export { type RlsProvider, rlsPredicate } from './rls';

/** All built-in dialects, in a stable order (registry bootstrap). */
import { BaseDialect } from './base-dialect';
import { PostgresDialect } from './postgres-dialect';
import { SqliteDialect } from './sqlite-dialect';
import { SqlServerDialect } from './sqlserver-dialect';
import type { Dialect } from './dialect';

/** Construct fresh instances of every built-in dialect. */
export function builtinDialects(): ReadonlyArray<Dialect> {
  return [new BaseDialect(), new PostgresDialect(), new SqliteDialect(), new SqlServerDialect()];
}
