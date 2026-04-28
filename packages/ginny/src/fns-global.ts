import type { ExprDef, Type, Value } from '@aeye/gin';
import type { Ctx } from './context';

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
 * Parts of `vars-global.ts` already use the same `engine.registerGlobal`
 * API — fns and vars share the global namespace, so a fn name can't
 * collide with a var name.
 */
export function registerFnAsGlobal(
  ctx: Ctx,
  name: string,
  type: Type,
  body: ExprDef,
): void {
  const callable = async (argsValue: Value): Promise<Value> => {
    const args = (argsValue?.raw ?? {}) as Record<string, Value>;
    return await ctx.engine.run(body, args);
  };
  ctx.engine.registerGlobal(name, { type, value: callable });
}
