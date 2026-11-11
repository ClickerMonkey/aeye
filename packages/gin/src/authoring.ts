/**
 * Authoring aids: what a model that writes gin types, values and expressions is
 * shown a step at a time (progressive disclosure), and the checks its drafts go
 * through before they are saved. Each check answers in words a model can act
 * on, so a check-and-fix loop can send the text straight back.
 *
 * - `typeSurface` prints one type compactly and names the types it refers to
 *   without inlining them, so a caller shows those only when asked.
 * - `disclose` walks those references a step at a time, within a character
 *   budget, never printing a type twice.
 * - `argProblems` checks call args against an `obj` args type (missing required
 *   args, unknown args, then gin's own value checks).
 * - `exprProblems` validates an expression and, when an expected type is given,
 *   checks what it produces against it, with compiler-style pointers.
 */
import type { Engine } from './engine';
import type { Locals } from './analysis';
import { typeReferences, type TypeResolver } from './refs';
import type { Registry } from './registry';
import type { ExprDef, TypeDef } from './schema';

/** One type as a model sees it: its code, and the named types it refers to but does not print. */
export interface TypeSurface {
  /** The type as TypeScript-like code, docs included; cut at the budget with `…`. */
  readonly code: string;
  /** Named types it refers to, in first-seen order (built-ins are never listed). */
  readonly refs: readonly string[];
  /** Whether `code` was cut to fit the budget. */
  readonly cut: boolean;
}

/** The default most characters one printed type takes. */
export const TYPE_SURFACE_CHARS = 2_000;

/**
 * Print a type for a model: its code (`toCodeDefinition` for a named type, else
 * `toCode`) cut to `maxChars`, and the names it refers to, which the caller can
 * show next with {@link disclose}.
 */
export function typeSurface(registry: Registry, def: TypeDef, maxChars: number = TYPE_SURFACE_CHARS): TypeSurface {
  const type = registry.parse(def);
  const full = def.extends !== undefined ? type.toCodeDefinition() : type.toCode(registry);
  const cut = full.length > maxChars;
  return { code: cut ? `${full.slice(0, Math.max(0, maxChars - 1))}…` : full, refs: typeReferences(def, registry).refs, cut };
}

/** What one disclosure step printed and what is left to show. */
export interface Disclosure {
  /** Each named type printed in this step, by name, in the order shown. */
  readonly shown: ReadonlyArray<{ readonly name: string; readonly surface: TypeSurface }>;
  /** Names referred to but not printed yet (over the budget, or past `names`). */
  readonly next: readonly string[];
  /** Names nothing could resolve. */
  readonly missing: readonly string[];
}

/**
 * One step of progressive disclosure over named types: print `names` (those
 * not in `seen`), then, while the budget lasts, the types they refer to,
 * breadth first. Everything printed is added to `seen`, so the next step never
 * repeats it; what did not fit is in `next`.
 */
export function disclose(
  registry: Registry,
  names: readonly string[],
  resolve: TypeResolver,
  seen: Set<string>,
  maxChars: number = TYPE_SURFACE_CHARS * 2,
): Disclosure {
  const shown: Array<{ name: string; surface: TypeSurface }> = [];
  const missing: string[] = [];
  const queue = names.filter((name) => !seen.has(name));
  const next: string[] = [];
  let used = 0;
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) continue;
    const def = resolve(name);
    if (!def) {
      missing.push(name);
      seen.add(name);
      continue;
    }
    const surface = typeSurface(registry, def, maxChars);
    if (shown.length > 0 && used + surface.code.length > maxChars) {
      next.push(name);
      continue;
    }
    shown.push({ name, surface });
    seen.add(name);
    used += surface.code.length;
    for (const ref of surface.refs) if (!seen.has(ref) && !queue.includes(ref)) queue.push(ref);
  }
  return { shown, next: next.filter((name) => !seen.has(name)), missing };
}

/** The required props (not `optional`) an args value leaves out, in declaration order. */
export function missingArgs(type: TypeDef, args: unknown): string[] {
  const given = isRecord(args) ? args : {};
  return Object.entries(type.props ?? {})
    .filter(([name, prop]) => prop.type.name !== 'optional' && given[name] === undefined)
    .map(([name]) => name);
}

/**
 * What is wrong with call args for an `obj` args type, one line per problem;
 * empty when they fit. Missing required args come first (a missing arg is
 * refused, never filled with null), then the shape (no unknown args), then
 * gin's own value checks (whole numbers, ranges, choices).
 */
export function argProblems(registry: Registry, type: TypeDef, args: unknown): string[] {
  const missing = missingArgs(type, args);
  if (missing.length > 0) return missing.map((name) => `${name} is required: give a value for it.`);
  const parsed = registry.parse(type);
  const shape = parsed.toValueSchema({ unknownKeys: 'refuse' }).safeParse(args);
  if (!shape.success) {
    return shape.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message));
  }
  try {
    parsed.parse(args);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** What `exprProblems` found. */
export interface ExprCheck {
  /** True when nothing at error severity was found. */
  readonly ok: boolean;
  /** The expression's static type, as code. */
  readonly produces: string;
  /** Every problem, formatted with `^^^` pointers into the expression's code; empty when there are none. */
  readonly report: string;
}

/**
 * Check an expression a model wrote: gin's validation (unknown names, props,
 * natives, misplaced control flow) and, given `expect`, whether the type it
 * produces is compatible with it. Never throws.
 */
export function exprProblems(engine: Engine, expr: ExprDef, options: { expect?: TypeDef; scope?: Locals } = {}): ExprCheck {
  const problems = engine.validate(expr, options.scope);
  const produced = engine.typeOf(expr, options.scope);
  if (options.expect !== undefined) {
    const expected = engine.registry.parse(options.expect);
    if (!expected.compatible(produced)) {
      problems.push('expr.type', `It produces \`${produced.toCode(engine.registry)}\` but \`${expected.toCode(engine.registry)}\` is expected.`);
    }
  }
  const errors = problems.list.filter((p) => p.severity === 'error');
  const report = problems.list.length === 0 ? '' : engine.toGinCode(expr).formatProblems(problems);
  return { ok: errors.length === 0, produces: produced.toCode(engine.registry), report };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
