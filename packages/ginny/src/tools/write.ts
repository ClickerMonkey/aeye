import { z } from 'zod';
import { buildSchemas } from '@aeye/gin';
import type { ExprDef } from '@aeye/gin';
import { ai } from '../ai';
import { logger } from '../logger';

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
      code = ctx.engine.toCode(input.program);
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

    let problemsNote = '';
    let problemsCount = 0;
    try {
      const problems = ctx.engine.validate(input.program, scope);
      problemsCount = problems.list.length;
      if (problemsCount > 0) {
        const lines = problems.list.map((p) => {
          const path = p.path.length > 0 ? ` @ ${p.path.join('.')}` : '';
          return `  - [${p.severity}] ${p.code}: ${p.message}${path}`;
        });
        problemsNote = `\n\n[validation problems — fix these before calling test()]\n${lines.join('\n')}`;
      }
    } catch (e: unknown) {
      // validate shouldn't throw, but be defensive — a thrown error
      // here shouldn't take down the write call.
      problemsNote = `\n\n[validation threw: ${e instanceof Error ? e.message : String(e)}]`;
      problemsCount = 1;
    }

    // Stderr (the user's terminal) gets the rendered code plus a
    // single-line problem count when there are issues. The full
    // problem list and threading goes to ginny.log for post-mortem
    // debugging — keeps the live view scannable while preserving
    // every detail in the log.
    process.stderr.write(`\x1b[2m${code}\x1b[0m\n`);
    if (problemsCount > 0) {
      const noun = problemsCount === 1 ? 'problem' : 'problems';
      process.stderr.write(`\x1b[31m[${problemsCount} validation ${noun} — see ginny.log for details]\x1b[0m\n`);
    }
    logger.log(`write:\n${code}${problemsNote}`);

    return `Draft saved. Call test() to evaluate it.\n\n${code}${problemsNote}`;
  },
});
