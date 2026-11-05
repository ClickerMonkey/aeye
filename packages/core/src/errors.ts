import type { ErrorKind, SchemaTarget } from './types';

/**
 * A prompt failure, with who caused it: the `model` (an invalid tool call or
 * output it can fix on another try) or a `tool`'s own code. A prompt that
 * gives up throws one, its `cause` holding the last failure.
 */
export class PromptError extends Error {
  constructor(message: string, readonly kind: ErrorKind, readonly cause?: Error) {
    super(message);
    this.name = 'PromptError';
  }
}

/**
 * The model called a tool that doesn't exist, or with arguments that don't
 * parse or don't match the tool's schema.
 */
export class ToolInputError extends PromptError {
  constructor(readonly tool: string, message: string, readonly rawArgs?: string) {
    super(message, 'model');
    this.name = 'ToolInputError';
  }
}

/**
 * A tool's own code threw: its handler, the prompt's interceptor, or its
 * result transformer.
 */
export class ToolExecutionError extends PromptError {
  constructor(readonly tool: string, message: string, cause: Error) {
    super(message, 'tool', cause);
    this.name = 'ToolExecutionError';
  }
}

/**
 * Why a tool call failed.
 */
export type ToolFailure = ToolInputError | ToolExecutionError;

/**
 * The model's output wasn't JSON, didn't match the schema, or failed the
 * prompt's `validate`.
 */
export class OutputValidationError extends PromptError {
  constructor(message: string, readonly reason: 'json-parsing' | 'schema-parsing' | 'validation', readonly output: string) {
    super(message, 'model');
    this.name = 'OutputValidationError';
  }
}

/**
 * The prompt's review still had feedback once its review retries ran out.
 * Carries the last output, which passed parsing and validation.
 */
export class ReviewRejectedError<TOutput> extends PromptError {
  constructor(readonly output: TOutput, readonly feedback: string) {
    super(`The review rejected the output: ${feedback}`, 'model');
    this.name = 'ReviewRejectedError';
  }
}

/**
 * A provider rejected a schema it was sent, or the model can't express it.
 * A prompt answers it by stepping down its schema fallbacks.
 */
export class SchemaRejectedError extends Error {
  constructor(readonly target: SchemaTarget, message: string, readonly cause?: Error) {
    super(message);
    this.name = 'SchemaRejectedError';
  }
}
