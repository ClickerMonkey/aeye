/**
 * The SEED case registry — every category's cases concatenated into one array the
 * runner iterates. Add cases by appending to a category file (or adding a new one)
 * and including it here; ids must stay globally unique.
 */
import type { EvalCase } from './types';
import { listCases } from './lists';
import { functionCases } from './functions';
import { domainCases } from './domain';
import { numCases } from './numbers';
import { textCases } from './text';
import { objCases } from './objects';
import { mapCases } from './maps';
import { controlCases } from './control';
import { lambdaCases } from './lambdas';
import { dateCases } from './dates';

export type { EvalCase, FnSpec, RawArgs } from './types';
export { a } from './assert';
export type { Assertion, AssertCtx, OracleFn, Severity } from './assert';

/** All cases, in category order. */
export const CASES: readonly EvalCase[] = [
  ...listCases,
  ...functionCases,
  ...domainCases,
  ...numCases,
  ...textCases,
  ...objCases,
  ...mapCases,
  ...controlCases,
  ...lambdaCases,
  ...dateCases,
];
