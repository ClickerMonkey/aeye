import type { Ctx } from './context';

export function refreshVarsGlobal(ctx: Ctx): void {
  const props: Record<string, { type: any; docs?: string }> = {};
  const value: Record<string, unknown> = {};
  for (const [name, { type, parsed, docs }] of ctx.loadedVars) {
    props[name] = { type, docs };
    value[name] = parsed;
  }
  const varsType = ctx.registry.obj(props);
  ctx.engine.registerGlobal('vars', { type: varsType, value });
}

export function loadVarInto(ctx: Ctx, name: string): void {
  if (ctx.loadedVars.has(name)) return;
  const def = ctx.store.readVar(name);
  const type = ctx.registry.parse(def.type);
  const parsed = type.parse(def.value);
  ctx.loadedVars.set(name, { type, parsed, docs: def.docs });
  refreshVarsGlobal(ctx);
}
