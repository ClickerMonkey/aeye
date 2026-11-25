// @ts-nocheck — frozen zod-path baseline (see ./index.ts); compiled as it was in its own package, not under this one's stricter test flags.
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
  const name = options.name ?? 'main';
  let code = ex.exportFunction(parsed, name);
  // The function shares the value namespace with the helpers (`makePerson`, `$listGet`, …).
  if (ex.helpers.has(name)) ex.problem(`function name '${name}' is also the name of a helper the code needs — pick another`);
  ex.check();
  const helpers = new Map(ex.helpers);
  if (options.prelude === 'inline' && helpers.size > 0) {
    code = `${[...helpers.values()].join('\n\n')}\n\n${code}`;
    helpers.clear();
  }
  return { code, types: new Map(ex.types), helpers, functions: [name] };
}

/**
 * Merge outputs into one: code joined in order, each type and helper kept
 * once. Every collision is an error, never a silent overwrite:
 *
 *  - a type or helper name declared two different ways — the outputs come from
 *    different registries, or from different `async` / `includeComments` /
 *    `export` options (names themselves are stable within one registry);
 *  - two functions with one name, or a function named like a helper.
 */
export function joinTypeScript(outputs: Iterable<TypeScriptOutput>): TypeScriptOutput {
  const code: string[] = [];
  const types = new Map<string, string>();
  const helpers = new Map<string, string>();
  const functions: string[] = [];
  const problems: string[] = [];
  const merge = (into: Map<string, string>, from: Map<string, string>, what: string): void => {
    for (const [k, v] of from) {
      const had = into.get(k);
      if (had !== undefined && had !== v) {
        problems.push(`${what} '${k}' is declared two different ways (outputs from different registries or options?)`);
        continue;
      }
      into.set(k, v);
    }
  };
  for (const o of outputs) {
    if (o.code) code.push(o.code);
    merge(types, o.types, 'type');
    merge(helpers, o.helpers, 'helper');
    for (const f of o.functions) {
      if (functions.includes(f)) problems.push(`two functions are named '${f}'`);
      else functions.push(f);
    }
  }
  for (const f of functions) if (helpers.has(f)) problems.push(`function '${f}' has the name of a helper`);
  if (problems.length) throw new TypeScriptExportError(problems.map((p) => `joinTypeScript: ${p}`));
  return { code: code.join('\n\n'), types, helpers, functions };
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
