import { z } from 'zod';
import { buildSchemas } from '@aeye/gin';
import type { ExprDef } from '@aeye/gin';
import { ai } from '../ai';

export const write = ai.tool({
  name: 'write',
  description: 'Write a gin program expression and store it as the draft.',
  instructions: 'Store the program draft. Provide the gin ExprDef JSON as "program".',
  schema: (ctx) => {
    const opts = buildSchemas(ctx.registry, { newStrict: true });
    return z.object({ program: opts.Expr as z.ZodType<ExprDef> });
  },
  call: async (input: { program: ExprDef }, _refs, ctx) => {
    ctx.runState.draft = input.program;
    ctx.runState.lastTest = null;
    return 'Draft saved. Call test() to evaluate it.';
  },
});
