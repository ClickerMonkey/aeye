/**
 * Test helpers for gin's `a` schemas: a verdict per value, the way the zod
 * tests read `safeParse(v).success`. Decoding runs on the LENIENT rendering
 * (the code shape) on a copy of the value, unless a profile is given.
 */
import { LENIENT, type AnySchema, type Bound, type Profile } from '@aeye/schema';
import { GinGrammar, type BuildSchemasOverrides } from '../grammar';
import type { Registry } from '../registry';

type Bindable = Bound<unknown> | AnySchema;

const isBound = (s: Bindable): s is Bound<unknown> => typeof (s as Bound<unknown>).render === 'function' && !('kind' in s);

/** A bound for a schema (a schema with grammar refs is bound with the registry's grammar). */
export function bindA(s: Bindable, registry?: Registry, overrides?: BuildSchemasOverrides): Bound<unknown> {
  if (isBound(s)) return s;
  if (s.refNames().size === 0) return (s as unknown as { bind(): Bound<unknown> }).bind();
  if (!registry) throw new Error('a schema with refs needs a registry');
  return (GinGrammar.result(s as never) as unknown as { bind(r: Registry, o?: BuildSchemasOverrides): Bound<unknown> }).bind(registry, overrides);
}

/** `safeParse`-shaped verdicts over an `a` schema. */
export function asParser(s: Bindable, registry?: Registry, overrides?: BuildSchemasOverrides, profile: Profile = LENIENT) {
  const bound = bindA(s, registry, overrides);
  const run = (v: unknown) => bound.render(profile).parse(structuredClone(v));
  return {
    bound,
    safeParse(v: unknown): { success: boolean; data?: unknown; message?: string } {
      const r = run(v);
      return r.ok ? { success: true, data: r.value } : { success: false, message: r.message };
    },
    parse(v: unknown): unknown {
      const r = run(v);
      if (!r.ok) throw new Error(r.message);
      return r.value;
    },
  };
}

/** Whether the schema accepts the value. */
export const accepts = (s: Bindable, v: unknown, registry?: Registry, overrides?: BuildSchemasOverrides): boolean =>
  asParser(s, registry, overrides).safeParse(v).success;

/** `buildSchemas`' roots as `safeParse`-shaped verdicts. */
export const parsers = (gs: { readonly Type: Bound<unknown>; readonly Expr: Bound<unknown> }) => ({ Type: asParser(gs.Type), Expr: asParser(gs.Expr) });
