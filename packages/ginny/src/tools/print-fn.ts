import { z } from 'zod';
import type { Type, TypeDef } from '@aeye/gin';
import { formatParams, renderGenerics } from '@aeye/gin';
import { ai } from '../ai';

/**
 * Inspect a saved function's source. The programmer often wants to
 * read the body of a fn it (or a previous session) created — to reuse
 * a pattern, debug a failure, or compose a new program on top.
 *
 * Renders a TypeScript-like declaration:
 *   fn <name><Generics>(<params>): <Returns> {
 *     type <alias> = <code>;            // call.types declared aliases
 *     ...
 *     <body>                            // call.get rendered via engine.toCode
 *   }
 *
 * Aliases declared on `call.types` appear as `type` lines at the top
 * of the body block — same as how a TypeScript fn would declare local
 * type aliases before the implementation.
 *
 * `includeComments` defaults to true. Set false to suppress docs and
 * inline / line comments at every level — `noComments` threads through
 * gin's toCode so wrap decisions reflect the actual rendered content.
 */
export const printFn = ai.tool({
  name: 'print_fn',
  description: 'Render a saved function as a TypeScript-like fn declaration.',
  instructions:
    'Look up a saved fn by name and return its signature + body in `fn name<G>(args): R { types; body }` form. '
    + 'Use `includeComments: false` to drop docs/comment annotations and just show the structure. '
    + 'Errors when the fn does not exist on disk.',
  schema: z.object({
    name: z.string().describe('Function name (matches the file at `./fns/<name>.json`).'),
    includeComments: z.boolean()
      .optional()
      .default(true)
      .describe('Include inline `/* docs */` and `// line` comments. Default true.'),
  }),
  call: async (input: { name: string; includeComments?: boolean }, _refs, ctx) => {
    let typeDef: TypeDef;
    try {
      typeDef = ctx.store.readFn(input.name);
    } catch {
      return `// FAILED: function '${input.name}' not found at \`./fns/${input.name}.json\`.`;
    }

    const fnType = ctx.registry.parse(typeDef);
    const includeComments = input.includeComments ?? true;
    const codeOpts = { includeComments };

    const call = fnType.call();
    if (!call) return `// FAILED: '${input.name}' is not a callable type — got ${fnType.name}.`;

    const generics = renderGenerics(fnType.generic, codeOpts);
    const params = formatParams(call.args, codeOpts);
    const returns = call.returns ? call.returns.toCode(undefined, codeOpts) : 'void';

    // Body lines: `type <alias> = ...;` declarations for each declared
    // call.types alias, then the rendered body.
    const bodyLines: string[] = [];
    if (call.types) {
      for (const [aliasName, aliasType] of Object.entries(call.types as Record<string, Type>)) {
        bodyLines.push(`  type ${aliasName} = ${aliasType.toCode(undefined, codeOpts)};`);
      }
      if (Object.keys(call.types).length > 0) bodyLines.push('');
    }
    if (call.get) {
      try {
        const body = ctx.engine.toCode(call.get, { expectsValue: false, includeComments });
        // Indent each line by two spaces so it sits visually inside
        // the fn block. Empty lines stay empty.
        const indented = body.split('\n').map((l) => l.length > 0 ? `  ${l}` : l).join('\n');
        bodyLines.push(indented);
      } catch (e: unknown) {
        bodyLines.push(`  // body render failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      bodyLines.push('  // (no body — fn declared with signature only)');
    }

    const docsLine = includeComments && (typeDef as { docs?: string }).docs
      ? `// ${(typeDef as { docs?: string }).docs}\n`
      : '';
    return `${docsLine}fn ${input.name}${generics}(${params}): ${returns} {\n${bodyLines.join('\n')}\n}`;
  },
});
