/**
 * The SEED case registry — every category's cases concatenated into one array
 * the runner iterates. Add new cases by appending to a category file (or adding
 * a new one) and including it here; ids must stay globally unique.
 */
import type { EvalCase } from './types';
import { filterCases } from './filters';
import { joinCases } from './joins';
import { aggregateCases } from './aggregates';
import { groupByCases } from './groupby';
import { topNCases } from './topn';
import { paginationCases } from './pagination';
import { dateCases } from './dates';
import { textCases } from './text';
import { subqueryCases } from './subquery';
import { writeModelCases } from './writemodel';
import { arrayCases } from './arrays';
import { operatorCases } from './operators';
import { functionCases } from './functions';
import { setopCases } from './setops';
import { cteCases } from './ctes';
import { windowCases } from './windows';

export type { EvalCase } from './types';
export { a } from './assert';
export type { Assertion, AssertCtx, OracleFn } from './assert';

/** All seed cases, in category order. */
export const CASES: readonly EvalCase[] = [
  ...filterCases,
  ...joinCases,
  ...aggregateCases,
  ...groupByCases,
  ...topNCases,
  ...paginationCases,
  ...dateCases,
  ...textCases,
  ...subqueryCases,
  ...writeModelCases,
  ...arrayCases,
  ...operatorCases,
  ...functionCases,
  ...setopCases,
  ...cteCases,
  ...windowCases,
];
