import { z } from 'zod';
import type { TypeDef } from '@aeye/gin';
import { ai } from '../ai';
import type { FullCtx } from '../context';

interface ArchitectResult {
  use: string[];
  create: TypeDef[];
}

export const findOrCreateTypes = ai.tool({
  name: 'find_or_create_types',
  description: 'Locate or author the types needed for the program. Returns their code definitions.',
  instructions: 'Delegates to the architect. Provide a description of the types needed.',
  schema: z.object({
    description: z.string().describe('What types are needed and why'),
  }),
  call: async (input: { description: string }, _refs, ctx: FullCtx) => {
    const { architect } = await import('../prompts/architect');
    const result = (await architect.get('result', { description: input.description }, ctx)) as
      | ArchitectResult
      | undefined;
    if (!result) return 'Architect returned no result.';

    const { use = [], create = [] } = result;
    const lines: string[] = [];

    for (const name of use) {
      if (!ctx.loadedTypes.has(name)) {
        try {
          const def = ctx.store.readType(name);
          const type = ctx.registry.parse(def);
          ctx.registry.register(type);
          ctx.loadedTypes.add(name);
        } catch { /* already present */ }
      }
      const t = ctx.registry.lookup(name);
      if (t) lines.push(t.toCodeDefinition());
    }

    for (const def of create) {
      const name = (def as { name?: string }).name;
      if (!name) continue;
      try {
        ctx.store.writeType(def);
        const type = ctx.registry.parse(def);
        ctx.registry.register(type);
        ctx.loadedTypes.add(name);
        lines.push(type.toCodeDefinition());
      } catch (e: unknown) {
        lines.push(`// Failed to create type '${name}': ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return lines.join('\n\n') || 'No types loaded.';
  },
});
