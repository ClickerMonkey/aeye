/**
 * FLEXIBLE ASSERTIONS for the `@aeye/gin` eval (mirrors `@aeye/query`'s
 * `cases/assert.ts`).
 *
 * A case declares a LIST of `Assertion`s, each with a `severity`. The eval is
 * CORRECTNESS-primary: a case PASSES iff every `'error'`-severity assertion
 * passes. `'warn'` assertions are still evaluated + LOGGED (so a differing shape
 * stays visible) but never fail the case — a program that produces the RIGHT
 * outputs via a different construct still passes. Every case must carry ≥1
 * `'error'` assertion (enforced by `--check`). The two dimensions:
 *
 *  - RESULT — do the generated function's outputs match a hand-written,
 *    obviously-correct ORACLE across ALL inputs? `a.produces(oracle)` is the core
 *    check: it runs the emitted function over every input and every output must
 *    deep-equal `oracle(rawArgs)` (with a numeric tolerance). Defaults to
 *    `'error'`.
 *  - STRUCTURE — did the model build the right SHAPE? `a.usesFn(name)` (the
 *    program calls `fns.<name>`), `a.usesKind(kind)` (an expr of that kind
 *    appears), and `a.returnsType(name)` (outputs carry that runtime type). These
 *    read the emitted `ExprDef` (or the output types) and default to `'warn'`.
 *
 * `a.refused(sample?)` expresses "the model should DECLINE this ill-typed /
 * impossible request"; it is the correctness gate for a refusal case, and its
 * optional `sample` is an illegal program the `--check` gate proves gets rejected
 * by `engine.validate`.
 */
import type { Registry, Expr, ExprDef } from '../../src/index';
import type { RawArgs } from './types';
import { compareValues, type CaseRuntime, type InputOutcome } from '../model';

// ════════════════════════════════════════════════════════════════════════════
// Assertion contract
// ════════════════════════════════════════════════════════════════════════════

/**
 * How much a failing assertion counts:
 *  - `'error'` — a CORRECTNESS gate. The case FAILS if this assertion fails.
 *    `a.produces` and `a.refused` default here.
 *  - `'warn'` — ADVISORY shape. Evaluated + LOGGED but never fails the case.
 *    Structural builders (`usesFn`, `usesKind`, `returnsType`) default here.
 * Flip with `a.require(...)` / `a.warn(...)`. Every case MUST carry ≥1 `'error'`
 * assertion (enforced by `--check`), else it would pass vacuously.
 */
export type Severity = 'error' | 'warn';

/**
 * The context an assertion checks against. `program` is the model's parsed
 * function body (or `null` if parse/validation failed); `programDef` is its raw
 * `ExprDef` JSON; `runAll()` lazily invokes the generated function over EVERY
 * input once (cached) and returns each outcome.
 */
export interface AssertCtx {
  program: Expr | null;
  programDef: ExprDef | null;
  parseError: string | null;
  runtime: CaseRuntime;
  inputs: readonly RawArgs[];
  runAll(): Promise<InputOutcome[]>;
}

/** A hand-written, obviously-correct oracle: `(rawArgs) => rawExpected`. */
export type OracleFn = (args: RawArgs) => unknown;

/** One check in a case. `check` returns a FAILURE reason, or `null` on pass. */
export interface Assertion {
  /** Human-readable description (e.g. "produces oracle", "uses fns.double"). */
  describe: string;
  /** Correctness gate (`'error'`) vs advisory shape (`'warn'`). See `Severity`. */
  severity: Severity;
  /** Whether `check` needs to RUN the generated function (calls `ctx.runAll()`). */
  needsResult: boolean;
  check(ctx: AssertCtx): Promise<string | null>;
  /** `--check` hook: the `a.produces` oracle — run + proven deterministic + typed. */
  oracle?: OracleFn;
  /** `--check` hook: the numeric tolerance the oracle comparison uses. */
  tolerance?: number;
  /** `--check` hook: an illegal program that MUST fail `engine.validate`. */
  refusalSample?: (registry: Registry) => ExprDef;
}

// ════════════════════════════════════════════════════════════════════════════
// ExprDef structure walk (for the structural assertions)
// ════════════════════════════════════════════════════════════════════════════

/** Collect every `kind` string that appears anywhere in the ExprDef tree. */
function collectKinds(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const x of node) collectKinds(x, out);
    return;
  }
  if (node !== null && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    if (typeof rec['kind'] === 'string') out.add(rec['kind']);
    for (const v of Object.values(rec)) collectKinds(v, out);
  }
}

/** Whether a path `step` is a `{ prop: <name> }` access. */
function isPropStep(step: unknown, name: string): boolean {
  return step !== null && typeof step === 'object' && (step as Record<string, unknown>)['prop'] === name;
}

/**
 * Whether the tree contains a `get`/`set` path that calls `fns.<name>` — i.e. a
 * `path` array with a `{prop:'fns'}` step immediately followed by `{prop:name}`.
 */
function callsFn(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some((x) => callsFn(x, name));
  if (node !== null && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    const path = rec['path'];
    if (Array.isArray(path)) {
      for (let i = 0; i + 1 < path.length; i++) {
        if (isPropStep(path[i], 'fns') && isPropStep(path[i + 1], name)) return true;
      }
    }
    return Object.values(rec).some((v) => callsFn(v, name));
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// Assertion builders
// ════════════════════════════════════════════════════════════════════════════

/** Build a STRUCTURAL assertion (defaults to `'warn'`; fails if no program). */
function struct(describe: string, fn: (programDef: ExprDef) => string | null): Assertion {
  return {
    describe,
    severity: 'warn',
    needsResult: false,
    check: (ctx) =>
      Promise.resolve(ctx.programDef === null ? `${describe}: model produced no valid program` : fn(ctx.programDef)),
  };
}

/**
 * The `a` namespace of assertion builders. Each returns an `Assertion` whose
 * `check` runs the generated function (result) or inspects its `ExprDef`
 * (structure).
 */
export const a = {
  /**
   * RESULT (the core check): the generated function's output matches `oracle`
   * for EVERY input. `oracle(rawArgs)` is a plain-JS, obviously-correct function;
   * each output is deep-compared with `opts.tolerance` (default `1e-9`). Any
   * input that throws or mismatches fails the case.
   */
  produces(oracle: OracleFn, opts?: { tolerance?: number }): Assertion {
    const tol = opts?.tolerance ?? 1e-9;
    return {
      describe: 'produces oracle output for every input',
      severity: 'error',
      needsResult: true,
      oracle,
      tolerance: tol,
      check: async (ctx) => {
        if (ctx.program === null) return `no valid program (${ctx.parseError ?? 'unknown'})`;
        const outcomes = await ctx.runAll();
        for (const o of outcomes) {
          if (o.error !== null) return `input ${JSON.stringify(o.input)} threw: ${o.error}`;
          const expected = oracle(o.input);
          const cmp = compareValues(expected, o.output, tol);
          if (!cmp.ok) return `input ${JSON.stringify(o.input)} → ${cmp.diff}`;
        }
        return null;
      },
    };
  },

  /** STRUCTURE: the program calls `fns.<name>` somewhere. Defaults to `'warn'`. */
  usesFn(name: string): Assertion {
    return struct(`uses fns.${name}`, (def) => (callsFn(def, name) ? null : `program never calls fns.${name}`));
  },

  /** STRUCTURE: an expression of `kind` appears in the tree. Defaults to `'warn'`. */
  usesKind(kind: ExprDef['kind']): Assertion {
    return struct(`uses ${kind} expr`, (def) => {
      const kinds = new Set<string>();
      collectKinds(def, kinds);
      return kinds.has(kind) ? null : `no ${kind} expression present`;
    });
  },

  /**
   * STRUCTURE (over the OUTPUT): every input's output `Value` carries runtime
   * type `typeName`. Defaults to `'warn'`. Needs a run.
   */
  returnsType(typeName: string): Assertion {
    return {
      describe: `returns ${typeName}`,
      severity: 'warn',
      needsResult: true,
      check: async (ctx) => {
        if (ctx.program === null) return `returns ${typeName}: model produced no valid program`;
        const outcomes = await ctx.runAll();
        for (const o of outcomes) {
          if (o.error !== null) return `input ${JSON.stringify(o.input)} threw: ${o.error}`;
          if (o.outputTypeName !== typeName) {
            return `output type '${o.outputTypeName ?? 'unknown'}' ≠ '${typeName}'`;
          }
        }
        return null;
      },
    };
  },

  /**
   * REFUSAL: the model should DECLINE this ill-typed / impossible request. In the
   * LLM eval it PASSES iff the model produced no valid program (parse/validation
   * failed). In `--check`, the optional `sample` is an illegal program the
   * fixture gate proves `engine.validate` rejects.
   */
  refused(sample?: (registry: Registry) => ExprDef): Assertion {
    return {
      describe: 'refused (no valid program)',
      // A refusal case's correctness IS the refusal — its error-severity gate.
      severity: 'error',
      needsResult: false,
      refusalSample: sample,
      check: (ctx) =>
        Promise.resolve(
          ctx.program === null || ctx.parseError !== null
            ? null
            : 'expected a refusal, but the model built a valid program',
        ),
    };
  },

  /** Promote an assertion to a CORRECTNESS gate (`'error'`). */
  require(assertion: Assertion): Assertion {
    return { ...assertion, severity: 'error' };
  },

  /** Demote an assertion to ADVISORY (`'warn'`) — evaluated + logged, never fails. */
  warn(assertion: Assertion): Assertion {
    return { ...assertion, severity: 'warn' };
  },
};
