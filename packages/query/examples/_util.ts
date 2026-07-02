/**
 * Tiny shared helpers for the numbered examples: a uniform `ExampleReport`
 * shape so the runner (`examples.ts`) and the test (`examples.test.ts`) can
 * treat every example the same way, plus a pretty-printer.
 */

/** What each numbered example's `run()` returns. */
export interface ExampleReport {
  /** Human title shown by the runner. */
  title: string;
  /** Lines of output to print. */
  output: string[];
  /**
   * Count of UNEXPECTED validation errors. A green example always returns 0
   * — even the cost-rejection example, whose rejection is the expected
   * outcome rather than a failure.
   */
  errors: number;
}

/** Print one report block to stdout. */
export function printReport(report: ExampleReport): void {
  console.log(`\n=== ${report.title} ===`);
  for (const line of report.output) console.log(line);
}
