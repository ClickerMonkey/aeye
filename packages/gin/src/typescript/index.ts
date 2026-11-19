/**
 * gin → runnable TypeScript — the public surface.
 *
 *   const out = toTypeScript(engine, lambdaExpr, { name: 'score' });
 *   out.code     // `async function score(args: {…}) { … }`
 *   out.types    // Map<'Person', 'type Person = { … };'> — every non-native type it names
 *   out.helpers  // Map<'$listGet', 'function $listGet…'> — what the code calls
 *
 *   const all = joinTypeScript([a, b, c]);   // one output, each type / helper once
 *   renderTypeScriptFile(all);               // types + helpers + code, ready for tsc
 *   renderTypeScriptTypes(all);              // the types alone — the contract to code against
 *
 * See `aeye-gin-typescript.md`.
 */
import type { Engine } from '../engine';
import type { Expr } from '../expr';
import type { ExprDef } from '../schema';
import { Exporter, TypeScriptExportError, type TypeScriptOptions, type TypeScriptOutput } from './exporter';

export { TypeScriptExportError, type TypeScriptOptions, type TypeScriptOutput } from './exporter';
export { PRELUDE, type PreludeHelper } from './prelude';

/**
 * Compile one gin expression to a TypeScript function. A `lambda` becomes
 * `function name(args, ctx?)`; any other expression becomes a program,
 * `function name(ctx?)`. `ctx` carries the free variables the code reads
 * (engine globals, and `options.scope` for run extras) and appears only when
 * there are some. Throws `TypeScriptExportError` listing every construct
 * that has no TypeScript form.
 */
export function toTypeScript(engine: Engine, expr: Expr | ExprDef, options: TypeScriptOptions = {}): TypeScriptOutput {
  const parsed = engine.registry.parseExpr(expr as ExprDef);
  const ex = new Exporter(engine, options);
  let code = ex.exportFunction(parsed, options.name ?? 'main');
  ex.check();
  const helpers = new Map(ex.helpers);
  if (options.prelude === 'inline' && helpers.size > 0) {
    code = `${[...helpers.values()].join('\n\n')}\n\n${code}`;
    helpers.clear();
  }
  return { code, types: new Map(ex.types), helpers };
}

/**
 * Merge outputs into one: code joined in order, each type and helper kept
 * once. Two outputs declaring the same name differently is an error — it
 * means two different gin types share a name.
 */
export function joinTypeScript(outputs: Iterable<TypeScriptOutput>): TypeScriptOutput {
  const code: string[] = [];
  const types = new Map<string, string>();
  const helpers = new Map<string, string>();
  const merge = (into: Map<string, string>, from: Map<string, string>, what: string): void => {
    for (const [k, v] of from) {
      const had = into.get(k);
      if (had !== undefined && had !== v) {
        throw new TypeScriptExportError([`joinTypeScript: ${what} '${k}' is declared two different ways`]);
      }
      into.set(k, v);
    }
  };
  for (const o of outputs) {
    if (o.code) code.push(o.code);
    merge(types, o.types, 'type');
    merge(helpers, o.helpers, 'helper');
  }
  return { code: code.join('\n\n'), types, helpers };
}

/** One TypeScript file: the types, then the helpers, then the code. */
export function renderTypeScriptFile(output: TypeScriptOutput): string {
  return [...output.types.values(), ...output.helpers.values(), output.code]
    .filter((s) => s.length > 0)
    .join('\n\n') + '\n';
}

/**
 * The type declarations alone, as a file. It type-checks on its own — hand it
 * to whoever (or whatever model) writes code against these types.
 */
export function renderTypeScriptTypes(output: TypeScriptOutput): string {
  return [...output.types.values()].join('\n\n') + '\n';
}
