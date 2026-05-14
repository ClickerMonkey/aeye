import { z } from 'zod';
import type { TypeDef } from '@aeye/gin';
import { ai } from '../ai';
import { architect } from '../prompts/architect';
import { runSubagent } from '../progress';

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
  call: async (input: { description: string }, _refs, ctx) => {
    const result = await runSubagent(
      `architect: ${input.description}`,
      () => architect.get('stream', { description: input.description }, ctx),
      ctx.signal,
    );
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

      // Reject a bare `{ name }` (or anything with no structural fields)
      // — gin treats that as a reference to an existing named type, not
      // a definition. The architect occasionally puts these in `create`
      // when they belong in `use`, and writing one would clobber the
      // real on-disk definition.
      const d = def as TypeDef;
      const hasBody = !!(d.extends || d.satisfies || d.generic ||
                         d.options || d.init || d.props ||
                         d.get || d.call || d.constraint);
      if (!hasBody) {
        // Treat as `use`: load existing if present, else skip.
        if (!ctx.loadedTypes.has(name)) {
          try {
            const existing = ctx.store.readType(name);
            const type = ctx.registry.parse(existing);
            ctx.registry.register(type);
            ctx.loadedTypes.add(name);
          } catch { /* nothing on disk either — silently drop */ }
        }
        const t = ctx.registry.lookup(name);
        if (t) lines.push(t.toCodeDefinition());
        continue;
      }

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
