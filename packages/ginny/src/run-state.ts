import type { ExprDef } from '@aeye/gin';

export interface TestResult {
  success: boolean;
  value?: unknown;
  error?: string;
  expectError?: boolean;
}

export interface RunState {
  draft: ExprDef | null;
  lastTest: TestResult | null;
}

export function createRunState(): RunState {
  return { draft: null, lastTest: null };
}
