/**
 * The bare issue lines of a result (`- at <path>: <message>`), for tests
 * that check where a problem is and what it says, not how the model's
 * message is laid out (feedback.test.ts checks that).
 */
import { formatIssues, type Issue } from '../index';

export const lines = (r: { readonly ok: boolean } & ({ readonly ok: true } | { readonly ok: false; readonly issues: readonly Issue[] })): string =>
  r.ok ? 'ok' : formatIssues(r.issues);
