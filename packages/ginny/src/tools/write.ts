import { z } from 'zod';
import { buildSchemas, formatProblems, Code } from '@aeye/gin';
import type { ExprDef } from '@aeye/gin';
import { ai } from '../ai';
import { logger, genId } from '../logger';

export const write = ai.tool({
  name: 'write',
  description: 'Write a gin program expression and store it as the draft.',
  instructions:
    'Store the program draft. Provide the gin ExprDef JSON as "program". ' +
    'Returns the program rendered as TypeScript-like source via toCode() so you can sanity-check what gin actually parsed, ' +
    'plus any validation problems (unknown vars / props / out-of-place flow / type mismatches) found by static analysis. ' +
    'Fix reported errors before calling test().',
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
      scope.set('recurse', ctx.registry.fn(ctx.targetFn.argsType, ctx.targetFn.returnsType));
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
    let problemsTsNote = '';
    let problemsLogNote = '';
    let problemsCount = 0;
    try {
      const ctxFlags = ctx.targetFn
        ? { inLoop: false, inLambda: true }
        : undefined;
      const problems = ctx.engine.validate(input.program, scope, ctxFlags);
      problemsCount = problems.list.length;
      if (problemsCount > 0) {
        const tsBlock = formatProblems(richCode, problems, { color: false });
        const jsonBlock = formatProblems(jsonCode, problems, { color: false });
        problemsTsNote = `\n\n[validation problems [${id}] — fix before calling test()]\n\n${tsBlock}`;
        problemsLogNote = `${problemsTsNote}\n\n— or, in JSON form —\n\n${jsonBlock}`;
      }
    } catch (e: unknown) {
      problemsTsNote = `\n\n[validation threw [${id}]: ${e instanceof Error ? e.message : String(e)}]`;
      problemsLogNote = problemsTsNote;
      problemsCount = 1;
    }

    // Stderr (the user's terminal) gets the rendered code dim + a
    // single-line problem count. The full problems block is in
    // ginny.log only.
    process.stderr.write(`\n\x1b[2m${codeStr}\x1b[0m\n`);
    if (problemsCount > 0) {
      const noun = problemsCount === 1 ? 'problem' : 'problems';
      process.stderr.write(`\x1b[31m[${problemsCount} validation ${noun} [${id}] — grep ginny.log for ${id}]\x1b[0m\n`);
      logger.log(`[${id}] write validation problems (${problemsCount}):\n${codeStr}${problemsLogNote}`);
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
