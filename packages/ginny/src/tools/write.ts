import { z } from 'zod';
import { buildSchemas, Code, Problems } from '@aeye/gin';
import type { ExprDef, Problem } from '@aeye/gin';
import { ai } from '../ai';
import { logger, genId } from '../logger';

export const write = ai.tool({
  name: 'write',
  description: 'Write a gin program expression and store it as the draft.',
  instructions:
    'Store the program draft. Provide the gin ExprDef JSON as "program". ' +
    'Returns the program rendered as TypeScript-like source via toCode() so you can sanity-check what gin actually parsed, ' +
    'plus any validation problems found by static analysis. ' +
    'ERRORS block the next step — fix them before calling test(). ' +
    'WARNINGS are advisory — review and address what you can; a fn whose saved warnings exceed the threshold will be rejected at finish().',
  schema: (ctx) => {
    const opts = buildSchemas(ctx.registry, { newStrict: true });
    return z.object({ program: opts.Expr as z.ZodType<ExprDef> });
  },
  call: async (input: { program: ExprDef }, _refs, ctx) => {
    ctx.runState.draft = input.program;
    ctx.runState.lastTest = null;

    // Two structured renders. `richCode` is the TS-pseudocode form
    // (what the model + reader scan most quickly); `jsonCode` is the
    // raw JSON form (matches what the LLM emitted). Both carry spans
    // tying every rendered range back to the validator's structural
    // path, so `formatProblems` can underline the offending range
    // beneath each problem.
    let richCode: Code;
    let jsonCode: Code;
    try {
      richCode = ctx.engine.toGinCode(input.program, { includeComments: false });
    } catch (e: unknown) {
      richCode = new Code(`// toGinCode failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      jsonCode = ctx.engine.toJSONCode(input.program);
    } catch (e: unknown) {
      jsonCode = new Code(`// toJSONCode failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const codeStr = richCode.toString();

    // Build the type-scope `engine.validate` walks against. Globals
    // are always there; when the designer is authoring a fn, also
    // bind `args` and `recurse` so the lambda body's free variables
    // resolve.
    const scope = new Map(ctx.engine.globalTypeScope());
    if (ctx.targetFn) {
      scope.set('args', ctx.targetFn.argsType);
      scope.set('recurse', ctx.registry.fn({ args: ctx.targetFn.argsType, returns: ctx.targetFn.returnsType }));
    }

    // 6-char id for grepping ginny.log. Same id appears in stderr,
    // the log entry, and the LLM tool result.
    const id = genId();

    // The LLM tool result carries ONLY the TS-form pointers — the
    // JSON-form pointers (with their multi-line span underlines) live
    // in ginny.log under the same run id. Doubling the rendering in
    // the tool result roughly doubled the conversation-history bytes
    // the OpenAI client serialized on every turn; with multiple
    // programmer agents in flight that pushed total resident memory
    // toward GB-scale OOMs. Both forms are still captured for human
    // debugging — `grep ginny.log <id>` pulls up the full block.
    //
    // Errors and warnings render as TWO distinct blocks so the model
    // sees the severity difference at a glance: errors MUST be fixed
    // before test() (the program likely won't even evaluate); warnings
    // SHOULD be addressed but allow forward motion. The finish() tool
    // re-counts warnings against `GIN_MAX_WARNINGS` and rejects saving
    // a fn that exceeds the threshold.
    let problemsTsNote = '';
    let problemsLogNote = '';
    let errorCount = 0;
    let warningCount = 0;
    try {
      const ctxFlags = ctx.targetFn
        ? { inLoop: false, inLambda: true }
        : undefined;
      const problems = ctx.engine.validate(input.program, scope, ctxFlags);
      const split = splitBySeverity(problems);
      errorCount = split.errors.list.length;
      warningCount = split.warnings.list.length;
      const tsParts: string[] = [];
      const logParts: string[] = [];
      if (errorCount > 0) {
        const tsBlock = richCode.formatProblems(split.errors, { color: false });
        const jsonBlock = jsonCode.formatProblems(split.errors, { color: false });
        tsParts.push(`[validation ERRORS [${id}] — fix before calling test()]\n\n${tsBlock}`);
        logParts.push(`${tsParts[tsParts.length - 1]}\n\n— or, in JSON form —\n\n${jsonBlock}`);
      }
      if (warningCount > 0) {
        const tsBlock = richCode.formatProblems(split.warnings, { color: false });
        const jsonBlock = jsonCode.formatProblems(split.warnings, { color: false });
        tsParts.push(`[validation WARNINGS [${id}] — address before finish() (saved fn rejected if too many)]\n\n${tsBlock}`);
        logParts.push(`${tsParts[tsParts.length - 1]}\n\n— or, in JSON form —\n\n${jsonBlock}`);
      }
      if (tsParts.length > 0) {
        problemsTsNote = `\n\n${tsParts.join('\n\n')}`;
        problemsLogNote = `\n\n${logParts.join('\n\n')}`;
      }
    } catch (e: unknown) {
      problemsTsNote = `\n\n[validation threw [${id}]: ${e instanceof Error ? e.message : String(e)}]`;
      problemsLogNote = problemsTsNote;
      errorCount = 1;
    }

    // Stderr (the user's terminal) gets the rendered code dim + a
    // single-line problem count. The full problems block is in
    // ginny.log only.
    process.stderr.write(`\n\x1b[2m${codeStr}\x1b[0m\n`);
    if (errorCount > 0 || warningCount > 0) {
      const parts: string[] = [];
      if (errorCount > 0) parts.push(`${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`);
      if (warningCount > 0) parts.push(`${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'}`);
      const color = errorCount > 0 ? '\x1b[31m' : '\x1b[33m';
      process.stderr.write(`${color}[${parts.join(', ')} [${id}] — grep ginny.log for ${id}]\x1b[0m\n`);
      logger.log(`[${id}] write validation (${parts.join(', ')}):\n${codeStr}${problemsLogNote}`);
    } else {
      logger.log(`write:\n${codeStr}`);
    }

    // Tool result the model sees + the `← write (Xms): ...` preview
    // line both pull from this string. The TS-form pointers carry
    // enough signal for the model to fix the program; the matching
    // JSON-form block is in ginny.log under the same `[id]`.
    return `Draft saved. Call test() to evaluate it.\n\n${codeStr}${problemsTsNote}`;
  },
});

/**
 * Partition a `Problems` accumulator into two by severity. Each side is
 * a fresh `Problems` so `formatProblems` can render them independently
 * with their own colored headers.
 */
function splitBySeverity(p: Problems): { errors: Problems; warnings: Problems } {
  const errors = new Problems();
  const warnings = new Problems();
  for (const item of p.list as ReadonlyArray<Problem>) {
    if (item.severity === 'error') errors.list.push(item);
    else if (item.severity === 'warning') warnings.list.push(item);
    // 'info' is silently dropped — no consumers today, and surfacing
    // it would clutter the model's view.
  }
  return { errors, warnings };
}
