import type { Engine, ExprDef, Type, Value } from '@aeye/gin';

/**
 * Wire a saved gin function (`fns/<name>.json`) into the engine as a
 * runtime callable global. With this in place a program can call
 * `<name>({...args})` directly — same calling convention as the
 * built-in globals (`fns.fetch`, `fns.llm`).
 *
 * The body is evaluated lazily on each invocation: each call constructs
 * a fresh root scope with the caller's args bound, so saved fns can be
 * recursive, can reference other globals (`vars.*`, other saved fns),
 * and stay decoupled from the parent program's scope.
 *
 * Takes `engine` directly rather than the dynamic `ctx` so this helper
 * doesn't need to import the (purposely loose) ctx type.
 */
export function registerFnAsGlobal(
  engine: Engine,
  name: string,
  type: Type,
  body: ExprDef,
): void {
  const callable = async (argsValue: Value): Promise<Value> => {
    // Gin's calling convention: a function's parameters are bound as a
    // single `args` scope var (matches how `Lambda.evaluate` does it
    // in @aeye/gin/exprs/lambda.ts). The body accesses individual
    // params via `[{prop: 'args'}, {prop: '<name>'}]`.
    //
    // The single-namespace wrapping is deliberate: param names are
    // controlled by the caller (engineer/programmer), but a function
    // body also has globals (`fns`, `vars`, loaded fns), `recurse`,
    // and lambda-context names (`this`, `super`, `key`, `value`) in
    // scope. Putting params under `args.*` keeps any of those names
    // free for use as parameters without collision risk.
    return await engine.run(body, { args: argsValue });
  };
  engine.registerGlobal(name, { type, value: callable });
}
