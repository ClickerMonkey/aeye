/**
 * examples — every numbered example module runs end-to-end over the bundled
 * dataset (define → build → validate → run → toSQL) and reports zero
 * unexpected errors.
 *
 * Note: we import each example's `run` directly, NOT `examples/examples.ts`
 * (whose runner calls `process.exit`).
 */
import { describe, it, expect } from 'vitest';
import { run as defineTypes } from '../../examples/01-define-types';
import { run as buildRunSelect } from '../../examples/02-build-run-select';
import { run as emitSql } from '../../examples/03-emit-sql';
import { run as filters } from '../../examples/04-filters';
import { run as paramsPaginate } from '../../examples/05-params-paginate';
import { run as drillDownExample } from '../../examples/06-drill-down';
import { run as costConstraint } from '../../examples/07-cost-constraint';
import { run as llmTool } from '../../examples/08-llm-tool';
import { run as customFunctions } from '../../examples/09-custom-functions';
import { run as schemaDepth } from '../../examples/10-schema-depth';
import { run as computedFields } from '../../examples/11-computed-fields';

const EXAMPLES = {
  '01-define-types': defineTypes,
  '02-build-run-select': buildRunSelect,
  '03-emit-sql': emitSql,
  '04-filters': filters,
  '05-params-paginate': paramsPaginate,
  '06-drill-down': drillDownExample,
  '07-cost-constraint': costConstraint,
  '08-llm-tool': llmTool,
  '09-custom-functions': customFunctions,
  '10-schema-depth': schemaDepth,
  '11-computed-fields': computedFields,
};

describe('examples', () => {
  for (const [name, run] of Object.entries(EXAMPLES)) {
    it(`${name} runs with zero unexpected errors`, async () => {
      const report = await run();
      expect(report.errors).toBe(0);
      expect(report.output.length).toBeGreaterThan(0);
    });
  }
});
