/**
 * Query barrel — re-exports the `Query` base + result shapes, every concrete
 * Query class, the FROM/JOIN/ORDER building blocks, and the `BUILTIN_QUERIES`
 * array the Registry bootstraps from.
 */
import type { QueryClass } from './query';
import { SelectQuery } from './select';
import { InsertQuery } from './insert';
import { UpdateQuery } from './update';
import { DeleteQuery } from './delete';
import { SetOperationQuery } from './set-operation';
import { CTEStatementQuery } from './cte';
import { ExprQuery } from './expr-query';

export {
  Query,
  type QueryClass,
  type QueryField,
  type QueryResult,
  type QueryResultArray,
  syntheticType,
  typeFromFields,
  resolveFields,
  fieldNameOf,
  makeField,
  makeResult,
  toArrayRows,
} from './query';
export { QuerySource } from './source';
export { QueryJoin, type JoinHop, type JoinType } from './join';
export { QueryOrder, sortEntries, type OrderEntry } from './order';

export {
  SelectQuery,
  InsertQuery,
  UpdateQuery,
  DeleteQuery,
  SetOperationQuery,
  CTEStatementQuery,
  ExprQuery,
};

/**
 * All built-in Query classes, in a stable order. The set-operation class
 * registers under all three of its kinds (`union` / `intersect` / `except`).
 */
export const BUILTIN_QUERIES: readonly QueryClass[] = [
  SelectQuery,
  InsertQuery,
  UpdateQuery,
  DeleteQuery,
  ExprQuery,
  CTEStatementQuery,
  { KIND: 'union', from: SetOperationQuery.from },
  { KIND: 'intersect', from: SetOperationQuery.from },
  { KIND: 'except', from: SetOperationQuery.from },
];
