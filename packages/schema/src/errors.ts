/**
 * Runtime errors of `@aeye/schema`. Model mistakes are never thrown: `parse`
 * returns them as `Issue`s for a re-prompt. These are for the code's own
 * mistakes, and for callers that prefer throwing.
 */
import type { Issue } from './render';
import { formatIssues } from './render';

/**
 * A schema or chain is defined wrongly in a way the types could not catch:
 * a ref missing at bind time, a dynamic step redefining a name, an example
 * that doesn't fit its own schema, encoding at a path that doesn't exist.
 */
export class SchemaDefinitionError extends Error {
  constructor(message: string) {
    super(`@aeye/schema: ${message}`);
    this.name = 'SchemaDefinitionError';
  }
}

/** A value did not match its schema (`parseOrThrow`). `issues` has both paths; the message is the model's feedback. */
export class SchemaParseError extends Error {
  constructor(readonly issues: readonly Issue[], message: string = formatIssues(issues)) {
    super(message);
    this.name = 'SchemaParseError';
  }
}

/**
 * A request cannot fit its provider's limits whatever is degraded (too many
 * tools, or more hard-`strict: true` schemas than the budget allows).
 * Thrown only on request (`RenderedRequest.assertNoDegradation()` or `{ failOnDegrade: true }`); `problems` lists each degradation.
 */
export class RequestLimitError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`@aeye/schema: the request does not fit the model's limits:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'RequestLimitError';
  }
}
