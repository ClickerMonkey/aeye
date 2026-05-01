import { z } from 'zod';
import { buildSchemas } from '@aeye/gin';
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

    let code: string;
    try {
      // Suppress inline comments in the user-visible render. The comments
      // stay in the saved ExprDef (so `print_fn(name, includeComments:true)`
      // can surface them later) but the live terminal view stays
      // structural — comment volume is the model's biggest source of
      // visual noise during the write→test loop.
      code = ctx.engine.toCode(input.program, { includeComments: false });
    } catch (e: unknown) {
      // toCode shouldn't throw for valid ExprDefs, but if the parse
      // path hits a malformed sub-tree we still want write() to
      // succeed — surface the rendering error inline.
      code = `// toCode failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    // Build the type-scope `engine.validate` walks against. Globals
    // are always there; when the designer is authoring a fn, also
    // bind `args` (the parameter obj) and `recurse` (the function
    // itself, for self-calls). Matches gin's runtime call binding —
    // see `gin/src/path.ts:286-287` for the saved-fn path and
    // `gin/src/exprs/lambda.ts:60-62` for the test path.
    //
    // Note: gin's `Lambda.validateWalk` (lambda.ts:90) only adds
    // `args`, not `recurse` — that's a real upstream gap. Adding
    // recurse here keeps ginny's static analysis aligned with what
    // actually runs.
    const scope = new Map(ctx.engine.globalTypeScope());
    if (ctx.targetFn) {
      scope.set('args', ctx.targetFn.argsType);
      scope.set('recurse', ctx.registry.fn(ctx.targetFn.argsType, ctx.targetFn.returnsType));
    }

    // Generate the 6-char id up front so the SAME id appears in
    // every place this validation surfaces: the stderr line the user
    // sees in their terminal, the line ginny.log records, AND the
    // tool result the model + the `← write (Xms): ...` timeline line
    // show. `grep <id> ginny.log` from any of those recovers the
    // full problem list + rendered code.
    const id = genId();

    let problemsNote = '';
    let problemsCount = 0;
    try {
      // When authoring a fn body (`targetFn` set), the program runs
      // INSIDE the saved fn's call boundary — `return` is legal there,
      // even though the body isn't wrapped in a LambdaExpr. Pass
      // `inLambda: true` so the validator doesn't warn `flow.outside-
      // lambda` on `return`. For a top-level user program (no
      // targetFn), defaults stand: `return` warns as before.
      const ctxFlags = ctx.targetFn
        ? { inLoop: false, inLambda: true }
        : undefined;
      const problems = ctx.engine.validate(input.program, scope, ctxFlags);
      problemsCount = problems.list.length;
      if (problemsCount > 0) {
        const lines = problems.list.map((p) => {
          const path = p.path.length > 0 ? ` @ ${p.path.join('.')}` : '';
          return `  - [${p.severity}] ${p.code}: ${p.message}${path}`;
        });
        problemsNote = `\n\n[validation problems [${id}] — fix these before calling test()]\n${lines.join('\n')}`;
      }
    } catch (e: unknown) {
      // validate shouldn't throw, but be defensive — a thrown error
      // here shouldn't take down the write call.
      problemsNote = `\n\n[validation threw [${id}]: ${e instanceof Error ? e.message : String(e)}]`;
      problemsCount = 1;
    }

    // Stderr (the user's terminal) gets the rendered code plus a
    // single-line problem count when there are issues.
    process.stderr.write(`\n\x1b[2m${code}\x1b[0m\n`);
    if (problemsCount > 0) {
      const noun = problemsCount === 1 ? 'problem' : 'problems';
      process.stderr.write(`\x1b[31m[${problemsCount} validation ${noun} [${id}] — grep ginny.log for ${id}]\x1b[0m\n`);
      logger.log(`[${id}] write validation problems (${problemsCount}):\n${code}${problemsNote}`);
    } else {
      logger.log(`write:\n${code}`);
    }

    // Tool result that the model sees AND the `← write (Xms): ...`
    // preview line both pull from this string, so the id sits in
    // problemsNote (above) — appears in both with no extra plumbing.
    return `Draft saved. Call test() to evaluate it.\n\n${code}${problemsNote}`;
  },
});
