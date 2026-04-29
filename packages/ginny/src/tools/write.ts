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
    // are always there; when the engineer is authoring a fn, bind the
    // entire args obj as a single `args` scope var (matches gin's
    // runtime calling convention — see `fns-global.ts`). The body
    // accesses params via `args.<name>`.
    const scope = new Map(ctx.engine.globalTypeScope());
    if (ctx.targetFn) {
      scope.set('args', ctx.targetFn.argsType);
    }

    let problemsNote = '';
    try {
      const problems = ctx.engine.validate(input.program, scope);
      if (problems.list.length > 0) {
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
    }

    // Mirror to stderr for the user watching the terminal, and to
    // ginny.log for the post-mortem.
    process.stderr.write(`\x1b[2m${code}\x1b[0m\n`);
    if (problemsNote) process.stderr.write(`\x1b[31m${problemsNote.trim()}\x1b[0m\n`);
    logger.log(`write:\n${code}${problemsNote}`);

    return `Draft saved. Call test() to evaluate it.\n\n${code}${problemsNote}`;
  },
});
