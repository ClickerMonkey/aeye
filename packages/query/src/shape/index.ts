/**
 * Barrel for the owned, zod-free structural-parser combinators. See
 * `shape.ts` for the design (never throws, accumulates problems, no casts).
 */
export {
  INVALID,
  isRecord,
  expected,
  lit,
  str,
  num,
  int,
  bool,
  scalar,
  json,
  isJsonValue,
  JSON_MAX_DEPTH,
  enumOf,
  optional,
  list,
  record,
  exprRef,
  queryRef,
  queryDefRef,
  sourceRef,
  obj,
  type Shape,
  type CheckCtx,
} from './shape';
