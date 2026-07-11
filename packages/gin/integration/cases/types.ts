/**
 * The EVAL CASE contract every gin seed case follows.
 *
 * A case describes a natural-language `request` to generate a gin FUNCTION
 * `(args) => output`. The model emits the function BODY (a gin `ExprDef`) that
 * reads its parameters through the `args` path — e.g. the param `n` is
 * `{ kind: 'get', path: [{ prop: 'args' }, { prop: 'n' }] }`. The harness wraps
 * that body in a `LambdaExpr` of the declared `argsType` → `returnType` signature
 * and runs it, exactly like `@aeye/ginny`'s designer flow.
 *
 * Correctness is proven by running the generated function over SEVERAL `inputs`
 * and comparing each output to an ORACLE — a plain-JS `(rawArgs) => rawExpected`
 * function that is obviously correct and trivial to author (gin `ExprDef`s are
 * raw JSON and far too verbose to hand-author as oracles). Multiple inputs guard
 * against a model that hard-codes one answer.
 *
 * A case may also register per-case CUSTOM TYPES (via `setup`) and expose a set
 * of callable `fns` — some of which are DISTRACTORS (present but not needed) to
 * test whether the model selects the right function.
 *
 * See `assert.ts` for the `a` assertion builder and the `--check` fixture gate.
 */
import type { Registry, Type, TypeDef } from '../../src/index';
import type { Assertion } from './assert';

/** A plain-JS args object passed to the generated function (and its oracle). */
export type RawArgs = Record<string, unknown>;

/**
 * One callable function exposed to the generated program as `fns.<name>(...)`,
 * rendered into the prompt with its signature. Some are DISTRACTORS: present in
 * scope but NOT needed to solve the task, so the eval measures whether the model
 * picks the RIGHT function.
 */
export interface FnSpec {
  /** The name the program calls it by: `fns.<name>(...)`. */
  name: string;
  /** The call-arguments type — an `obj` TypeDef keyed by parameter name. */
  args: TypeDef;
  /** The return type. */
  returns: TypeDef;
  /**
   * The deterministic JS implementation, authored over PLAIN args: it receives a
   * `{ paramName: rawValue }` object (gin call args decoded to plain JSON) and
   * returns a plain-JS value of `returns`. The ORACLE knows this real behavior.
   */
  impl: (args: RawArgs) => unknown;
  /** Short human-readable note rendered next to the signature in the prompt. */
  docs?: string;
  /** When true, this fn is a DISTRACTOR — available but not the intended tool. */
  distractor?: boolean;
  /**
   * Sample args the `--check` fixture gate calls `impl` with, to prove the impl
   * runs and returns a value of `returns`. Author one per fn so the gate
   * exercises every closure without an LLM.
   */
  probe?: RawArgs;
}

/** One natural-language → gin-function evaluation case. */
export interface EvalCase {
  /** Stable unique id (used as the log key). */
  id: string;
  /** Grouping bucket for the summary (e.g. `list`, `functions`, `domain`). */
  category: string;
  /** The natural-language request shown to the model. */
  request: string;
  /** Which trap / discriminator this case exercises, and why a wrong answer fails. */
  note: string;
  /**
   * Register per-case custom domain types into the fresh registry BEFORE
   * generation + execution. Return the types you created so they appear in the
   * prompt's type docs. Use `registry.extend` / `register` / `augment`.
   */
  setup?: (registry: Registry) => Type[];
  /** 0–10 callable functions (distractors included) exposed as `fns.<name>`. */
  fns?: FnSpec[];
  /** The generated function's parameter type — an `obj` TypeDef. */
  argsType: TypeDef;
  /** The generated function's declared return type. */
  returnType: TypeDef;
  /** ≥2 test inputs; each a raw-args record matching `argsType`. */
  inputs: RawArgs[];
  /** The checks. The case PASSES iff every `'error'`-severity assertion passes. */
  assert: Assertion[];
}

export type { Assertion } from './assert';
