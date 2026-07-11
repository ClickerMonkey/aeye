/**
 * The gin eval harness's RUNTIME MODEL — the no-LLM machinery every case runs
 * against. Mirrors `@aeye/query`'s `integration/model.ts` (which stands up an
 * in-memory engine over fixture data), but gin's unit of evaluation is a
 * generated FUNCTION, so this module instead:
 *
 *  1. `bootstrap()` — a fresh registry + engine wired with gin's built-in
 *     natives (identical to `@aeye/ginny`'s bootstrap). Each case gets its OWN
 *     registry/engine so per-case custom types + `fns` globals never collide,
 *     which also makes the concurrent runner race-free.
 *  2. `setupCase(case)` — registers the case's custom domain types and its
 *     callable `fns` (as an `fns` global obj), then parses the declared
 *     `argsType` / `returnType` into a fn signature. Everything the model needs
 *     in scope is live BEFORE generation + execution.
 *  3. `invokeOverInputs(runtime, program, inputs)` — the exact
 *     "run the generated function on a test input" mechanism `@aeye/ginny`'s
 *     `test` tool uses: wrap the emitted body in a `LambdaExpr` of the case's
 *     `fnType`, evaluate it once to a callable, then call it per input.
 *  4. `compareValues` / `toPlain` — deep-equal raw values with a numeric
 *     tolerance (gin's `compareResults` analogue) and unwrap a `Value` tree into
 *     plain JSON so an ORACLE's plain-JS output can be compared to it.
 */
import {
  createRegistry,
  createEngine,
  registerBuiltinNatives,
  LambdaExpr,
  Value,
  type Registry,
  type Engine,
  type Type,
  type Expr,
  type ObjPropsInput,
} from '../src/index';

import type { EvalCase, FnSpec, RawArgs } from './cases/types';

/** A plain-JS args object flowing in and out of the generated function. */
export type { RawArgs } from './cases/types';

// ════════════════════════════════════════════════════════════════════════════
// Bootstrap — a fresh registry + engine per case (mirrors ginny's registry.ts)
// ════════════════════════════════════════════════════════════════════════════

/**
 * A fresh gin `registry` + `engine` with the built-in natives wired. Identical
 * to `@aeye/ginny`'s `bootstrap()` — `createRegistry()` already registers the
 * built-in natives; the explicit `registerBuiltinNatives` call is idempotent and
 * kept to match ginny's exact bootstrap shape.
 */
export function bootstrap(): { registry: Registry; engine: Engine } {
  const registry = createRegistry();
  registerBuiltinNatives(registry);
  const engine = createEngine(registry);
  return { registry, engine };
}

// ════════════════════════════════════════════════════════════════════════════
// Per-case runtime
// ════════════════════════════════════════════════════════════════════════════

/**
 * Everything a single case needs at generation + execution time: the fresh
 * registry/engine, the custom domain types it registered (surfaced in the
 * prompt), its `fns` specs (rendered as callable signatures), and the parsed
 * function signature (`argsType` → `returnsType`, wrapped as `fnType`) the model
 * is asked to fill in.
 */
export interface CaseRuntime {
  registry: Registry;
  engine: Engine;
  /** Domain types registered for this case (for the prompt's type docs). */
  customTypes: Type[];
  /** The generated function's parameter type. */
  argsType: Type;
  /** The generated function's declared return type. */
  returnsType: Type;
  /** The full `(argsType): returnsType` signature the body is wrapped in. */
  fnType: Type;
  /** The case's callable functions (distractors included). */
  fns: readonly FnSpec[];
}

/**
 * Stand up a case's runtime: a fresh registry/engine, its custom types, its
 * `fns` global, and the parsed function signature. No LLM is involved — this is
 * pure setup that both `--check` and the LLM eval share.
 */
export function setupCase(c: EvalCase): CaseRuntime {
  const { registry, engine } = bootstrap();

  // 1. Custom domain types — registered BEFORE anything references them.
  const customTypes = c.setup ? c.setup(registry) : [];

  // 2. Callable `fns` — each spec becomes a typed prop on an `fns` global obj
  //    whose runtime value is a JS closure. The closure decodes the gin call
  //    args to plain JS, runs the deterministic `impl`, and re-parses the result
  //    back into a `Value` of the fn's return type — so the generated program
  //    calls `fns.<name>(...)` and gets a first-class typed value back.
  const fns = c.fns ?? [];
  if (fns.length > 0) {
    const fnsProps: ObjPropsInput = {};
    const fnsValue: Record<string, (args: Value) => Promise<Value>> = {};
    for (const spec of fns) {
      const fnArgsType = registry.parse(spec.args);
      const fnReturns = registry.parse(spec.returns);
      const fnType = registry.fn({ args: fnArgsType, returns: fnReturns });
      fnsProps[spec.name] = spec.docs ? { type: fnType, docs: spec.docs } : { type: fnType };
      fnsValue[spec.name] = async (argsValue: Value): Promise<Value> => {
        // `toPlain` yields a JSON-shaped record; the impl is authored over that
        // plain shape (boundary between gin Values and hand-written closures).
        const rawArgs = toPlain(argsValue) as RawArgs;
        return fnReturns.parse(spec.impl(rawArgs));
      };
    }
    engine.registerGlobal('fns', { type: registry.obj(fnsProps), value: fnsValue });
  }

  // 3. The function signature the model fills in.
  const argsType = registry.parse(c.argsType);
  const returnsType = registry.parse(c.returnType);
  const fnType = registry.fn({ args: argsType, returns: returnsType });

  return { registry, engine, customTypes, argsType, returnsType, fnType, fns };
}

// ════════════════════════════════════════════════════════════════════════════
// Invocation — run the generated function over the case's inputs
// ════════════════════════════════════════════════════════════════════════════

/** One input's outcome: its plain-JS output + runtime type name, or an error. */
export interface InputOutcome {
  /** The raw-args input this outcome is for. */
  input: RawArgs;
  /** The generated function's output as plain JSON (null when it threw). */
  output: unknown;
  /** The output `Value`'s runtime type name (null when it threw). */
  outputTypeName: string | null;
  /** The runtime error message, or null on success. */
  error: string | null;
}

/**
 * Invoke the generated function body over every input. Mirrors `@aeye/ginny`'s
 * `test` tool: wrap the body in a `LambdaExpr` of the case's `fnType`, evaluate
 * it ONCE against a root scope (seeding globals + `fns`), then call the resulting
 * closure per input with `argsType.parse(input)`. Each input is caught
 * independently so one bad input doesn't lose the rest.
 */
export async function invokeOverInputs(
  runtime: CaseRuntime,
  program: Expr,
  inputs: readonly RawArgs[],
): Promise<InputOutcome[]> {
  const outcomes: InputOutcome[] = [];
  // The lambda evaluates to its callable form once; reuse across inputs.
  let callable: ((args: Value) => Promise<Value>) | null = null;
  for (const input of inputs) {
    try {
      if (callable === null) {
        const lambda = new LambdaExpr(runtime.fnType, program);
        const lambdaValue = await lambda.evaluate(runtime.engine, runtime.engine.createRootScope());
        // A lambda's raw is its `(argsValue) => Promise<Value>` invoker (same
        // boundary cast ginny's `test` tool applies).
        callable = lambdaValue.raw as (args: Value) => Promise<Value>;
      }
      const argsValue = runtime.argsType.parse(input);
      const out = await callable(argsValue);
      outcomes.push({ input, output: toPlain(out), outputTypeName: out.type?.name ?? null, error: null });
    } catch (err) {
      outcomes.push({ input, output: null, outputTypeName: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcomes;
}

// ════════════════════════════════════════════════════════════════════════════
// Value ↔ plain-JSON + comparison
// ════════════════════════════════════════════════════════════════════════════

/**
 * Unwrap a `Value` tree into plain JSON — the shape a hand-written ORACLE
 * returns. gin's `Value.encode()` produces the subtype-preserving ENVELOPE form
 * (`{type, value}` at every composite slot), which is the wrong shape to compare
 * against a plain oracle result; this strips the `Value` wrappers instead,
 * leaving bare scalars / arrays / objects.
 */
export function toPlain(value: Value): unknown {
  return unwrap(value.raw);
}

/** Recursively strip `Value` wrappers from a runtime `raw` into plain JSON. */
function unwrap(raw: unknown): unknown {
  if (raw instanceof Value) return unwrap(raw.raw);
  if (Array.isArray(raw)) return raw.map((el) => unwrap(el));
  if (raw instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const entry of raw.values()) {
      const [k, v] = entry as [Value, Value];
      out[String(unwrap(k.raw))] = unwrap(v.raw);
    }
    return out;
  }
  if (raw instanceof Date) return raw.toISOString();
  if (raw !== null && typeof raw === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) out[k] = unwrap(v);
    return out;
  }
  return raw;
}

/**
 * Deep structural equality with an absolute numeric tolerance (gin's analogue of
 * query's `compareResults`). Numbers compare within `tol`; arrays compare
 * element-wise; objects compare by their union of keys; everything else compares
 * by strict `JSON.stringify` equality. Returns `{ ok, diff }` — `diff` names the
 * first mismatch (empty on success).
 */
export function compareValues(expected: unknown, actual: unknown, tol: number): { ok: boolean; diff: string | null } {
  const diff = firstDiff(expected, actual, tol, '$');
  return { ok: diff === null, diff };
}

/** The path of the first mismatch between two plain-JSON trees, or null. */
function firstDiff(expected: unknown, actual: unknown, tol: number, path: string): string | null {
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(expected - actual) <= tol ? null : `${path}: expected ${expected}, got ${actual}`;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    }
    if (expected.length !== actual.length) {
      return `${path}: length ${expected.length} (expected) vs ${actual.length} (actual)`;
    }
    for (let i = 0; i < expected.length; i++) {
      const d = firstDiff(expected[i], actual[i], tol, `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      const d = firstDiff(expected[k], actual[k], tol, `${path}.${k}`);
      if (d !== null) return d;
    }
    return null;
  }
  return JSON.stringify(expected) === JSON.stringify(actual)
    ? null
    : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

/** Whether `v` is a plain (non-array, non-null) object with string keys. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
