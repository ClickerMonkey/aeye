/**
 * Example runner — imports every numbered example, runs it in order, prints
 * its output, and exits non-zero if any example reported an unexpected error.
 *
 *   npm run examples
 */
import { printReport, type ExampleReport } from './_util';
import { run as defineTypes } from './01-define-types';
import { run as buildRunSelect } from './02-build-run-select';
import { run as emitSql } from './03-emit-sql';
import { run as filters } from './04-filters';
import { run as paramsPaginate } from './05-params-paginate';
import { run as drillDownExample } from './06-drill-down';
import { run as costConstraint } from './07-cost-constraint';
import { run as llmTool } from './08-llm-tool';
import { run as customFunctions } from './09-custom-functions';
import { run as schemaDepth } from './10-schema-depth';
import { run as computedFields } from './11-computed-fields';

/** Every example's `run`, in display order. */
export const EXAMPLES: ReadonlyArray<() => Promise<ExampleReport>> = [
  defineTypes,
  buildRunSelect,
  emitSql,
  filters,
  paramsPaginate,
  drillDownExample,
  costConstraint,
  llmTool,
  customFunctions,
  schemaDepth,
  computedFields,
];

async function main(): Promise<void> {
  let totalErrors = 0;
  for (const example of EXAMPLES) {
    const report = await example();
    printReport(report);
    totalErrors += report.errors;
  }
  console.log(`\nDone — ${EXAMPLES.length} examples, ${totalErrors} unexpected error(s).`);
  process.exit(totalErrors === 0 ? 0 : 1);
}

void main();
