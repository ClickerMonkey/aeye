import type { Engine } from './engine';
import type { Scope } from './scope';
import type {
  ExprDef, PathDef, PathStepDef, PathPropDef, PathCallDef, PathIndexDef,
  TypeDef,
} from './schema';
import { Value, val } from './value';
import { ReturnSignal, ThrowSignal } from './flow-control';
import type { Call, GetSet, Prop, Type } from './type';
import { Expr } from './expr';
import type { Registry } from './registry';
import type { Locals } from './analysis';
import type { Problems } from './problem';
import type { ValidateContext } from './expr';
import { LocalScope, type TypeScope } from './type-scope';
import { joinAuto } from './type';
import { ObjType } from './types/obj';
import { IfaceType } from './types/iface';
import { Extension } from './extension';
import { AliasType } from './types/alias';
import type { CodeOptions } from './node';
import { Code, code, span, joinCode } from './code';
import type { Effects } from './effects';
import { didYouMean, deepSuggest } from './aids';
import { checkPathStep } from './wire';

/**
 * `true` when accessing a prop whose type is a callable (fn / method)
 * with no required arguments — every field on the args obj is either
 * `optional<...>` or absent. We auto-invoke such callables on prop
 * read, so e.g. `optional<T>.has` resolves to the bool result of
 * `has()` instead of the bare function value. Saves callers from a
 * trailing `{args: {}}` step that's always empty by definition.
 *
 * Only methods (props) auto-call — standalone fn-typed scope vars
 * (`recurse`, user-bound function values) keep the existing
 * "function-value on read, called only via explicit `{args: ...}`"
 * semantics. The walker draws that line by checking whether the
 * resolution came from a prop access (`current` non-null) vs a
 * scope lookup (`current === null`); auto-call only runs in the
 * prop-access branch.
 */
function isAutoCallable(propType: Type, scope?: TypeScope): boolean {
  const call = propType.call(scope);
  if (!call) return false;
  const args = call.args;
  if (!(args instanceof ObjType)) {
    // Empty / no-args fn — auto-callable.
    return true;
  }
  for (const prop of Object.values(args.fields)) {
    if (!prop.type.isOptional()) return false;
  }
  return true;
}

/**
 * Report each REQUIRED parameter of `callable` (a non-optional field on its
 * args obj) that `provided` omits. A method called without its required args
 * would otherwise bind them to nothing and silently produce a wrong value
 * (`n.lt` with no `other` reads as a `false` bool; `text.replace` with no
 * search/replacement returns the string unchanged) — a wrong answer the retry
 * loop never sees because nothing errors. Surfacing it as a validation error
 * lets the loop re-prompt with a concrete fix.
 */
function reportMissingArgs(
  callable: Call | undefined,
  provided: Record<string, Expr>,
  p: Problems,
  at: (string | number)[],
): void {
  if (!callable) return;
  const args = callable.args;
  if (!(args instanceof ObjType)) return;
  for (const [name, prop] of Object.entries(args.fields)) {
    if (prop.type.isOptional()) continue;
    if (!(name in provided)) {
      p.at(at, () => p.error('call.missing-arg', `missing required argument '${name}'`));
    }
  }
}

/**
 * A prop's declared type as seen THROUGH the receiver that carries it.
 *
 * A generic's props are declared against its type PARAMETERS, so on a
 * specialized instance `QueryResult<Row=obj{id: text}>.props().rows` is still
 * an `AliasType('Row')`. The binding is not lost — `specialize` layers a
 * `LocalScope` over the instance's own scope, which is "what makes a bound
 * `QueryResult<Row=…>` actually behave as the bound type rather than merely
 * print like one" — and every VALUE operation (`valid` / `parse` / `encode`)
 * already routes through it. The path walk did not, so
 *
 *   res.data.USD   on   HttpResponse<T = obj{USD: num, EUR: num}>
 *
 * reported `no prop 'USD' on type 'alias'` while the type printed its binding
 * correctly one line above. A named generic envelope was unusable for exactly
 * the reason it exists.
 *
 * Only an alias is resolved. `simplify` on anything else is a canonicalizer
 * (`and<obj, obj>` collapses to an `obj`, a one-variant `or` unwraps) and
 * running every prop read through it would change what the walk reports about
 * types that were never in question.
 */
function propTypeVia(receiver: Type, prop: Prop): Type {
  return prop.type instanceof AliasType ? prop.type.simplify(receiver.scope) : prop.type;
}

/**
 * The `Value` a composite's raw carries at `name`, when the DECLARED type
 * could not answer for it.
 *
 * The runtime half of the same defect: a composite's raw holds a `Value` per
 * slot, each with its own concrete type, and the walk consulted only
 * `current.type`. A value whose declared type is an unresolved placeholder
 * but whose raw holds typed cells is not an error — it is a value carrying
 * MORE information than its declaration, and the pair is what gin trades in.
 * Consulted only after the declared type has failed, so a declaration always
 * wins where it has an opinion.
 */
function carriedSlot(receiver: Value, name: string): Value | undefined {
  const raw = receiver.raw;
  if (!raw || typeof raw !== 'object') return undefined;
  const slot = (raw as Record<string, unknown>)[name];
  return slot instanceof Value ? slot : undefined;
}

/**
 * True when `t` navigates like a record — its props are DATA fields worth
 * descending into (obj / interface, or an Extension of one) rather than the
 * method surface of a scalar. Bounds the deep-path search to field graphs.
 */
function isObjLike(t: Type): boolean {
  if (t instanceof ObjType || t instanceof IfaceType) return true;
  if (t instanceof Extension) return isObjLike(t.base);
  return false;
}

/**
 * The "did you mean?" tail for an unknown prop `steps[i]` on `receiver`. Beyond
 * fixing the single mis-typed key, it reads the REMAINING prop steps (the
 * failing key plus any that follow) and predicts the full path they most likely
 * meant, via {@link deepSuggest} over the receiver's field graph — so
 * `user.usr.name` suggests `user.name` and `user.name` (when `name` lives under
 * `profile`) suggests `user.profile.name`. A single-segment prediction renders
 * as the bare key (an ordinary same-level typo); a multi-segment one renders as
 * the full dotted path from the root when the whole prefix is prop steps, else
 * relative to the receiver. Returns `''` when there is no confident prediction.
 */
function suggestPathTail(receiver: Type, steps: readonly PathStep[], i: number): string {
  const target: string[] = [];
  for (let k = i; k < steps.length; k++) {
    const s = steps[k]!;
    if (s instanceof PropStep) target.push(s.prop);
    else break;
  }
  if (target.length === 0) return '';
  const predicted = deepSuggest(
    receiver,
    (t: Type) => Object.keys(t.props()),
    (t: Type) => {
      const nav: Array<[string, Type]> = [];
      for (const name of Object.keys(t.props())) {
        const pt = t.prop(name)?.type;
        if (pt && isObjLike(pt)) nav.push([name, pt]);
      }
      return nav;
    },
    target,
  );
  if (!predicted || predicted.length === 0) return '';
  if (predicted.length === 1) return ` — did you mean \`${predicted[0]}\`?`;
  // Multi-segment prediction — prepend the resolved prefix when it is all props.
  const prefix: string[] = [];
  for (let k = 0; k < i; k++) {
    const s = steps[k]!;
    if (s instanceof PropStep) prefix.push(s.prop);
    else { prefix.length = 0; break; }
  }
  return ` — did you mean \`${[...prefix, ...predicted].join('.')}\`?`;
}

/**
 * Path — a sequence of steps against a starting value. The third citizen
 * of the gin language alongside Type and Expr. Classes:
 *   PathStep (abstract) ← PropStep, IndexStep, CallStep
 *   Path              — a sequence of PathSteps
 *
 * Path owns all path-walking logic (runtime + analysis + code-emit).
 * Prop/GetSet runtime operations live on those classes themselves
 * (Prop.read/write/invokeMethod/invokeMethodSet, GetSet.indexRead/Write).
 */

export interface PathMode {
  mode: 'get' | 'set';
  setValue?: Value;
}

// ─── step hierarchy ────────────────────────────────────────────────────────

export abstract class PathStep {
  abstract toJSON(): PathStepDef;
  abstract clone(): PathStep;
  /**
   * Structural cost the step contributes to the enclosing path. Each
   * subclass implements this — see `Path.complexity()` for the
   * helper-discount rationale (a `CallStep` pays for the call SITE,
   * not the called body, so decomposition reduces caller cost).
   */
  abstract complexity(): number;

  static from(json: PathStepDef, scope: TypeScope): PathStep {
    // Refuse a step gin would read only part of — a fused `{prop, args}`, or a
    // key outside the form the step selected. Both used to truncate silently
    // and then be mis-diagnosed as the missing half. See `wire.ts`.
    checkPathStep(json);
    if ('prop' in json) return new PropStep(json.prop);
    const r = scope.registry;
    if ('args' in json) {
      const args: Record<string, Expr> = {};
      for (const [k, v] of Object.entries(json.args ?? {})) {
        args[k] = r.parseExpr(v, scope);
      }
      return new CallStep(args, json.generic, json.catch ? r.parseExpr(json.catch, scope) : undefined);
    }
    if ('key' in json) return new IndexStep(r.parseExpr((json as PathIndexDef).key, scope));
    throw new Error(`PathStep.from: unknown step shape`);
  }
}

export class PropStep extends PathStep {
  constructor(readonly prop: string) {
    super();
  }
  toJSON(): PathPropDef { return { prop: this.prop }; }
  clone(): PropStep { return new PropStep(this.prop); }
  complexity(): number { return 1; }
}

export class CallStep extends PathStep {
  /**
   * Effects of the called `Call` as resolved during `Path.validateWalk`.
   * Populated lazily — undefined until validation has resolved the
   * call site's type. Consumed by `GetExpr.effects()` so a path like
   * `fns.fetch({url})` propagates EXTERNAL up to the loop / branch
   * no-effect warnings (which run after the validator).
   */
  resolvedEffects?: Effects;

  constructor(
    readonly args: Record<string, Expr>,
    readonly generic?: Record<string, TypeDef>,
    readonly catch_?: Expr,
  ) {
    super();
  }

  toJSON(): PathCallDef {
    const outArgs: Record<string, ExprDef> = {};
    for (const [k, v] of Object.entries(this.args)) outArgs[k] = v.toJSON();
    const out: PathCallDef = { args: outArgs };
    if (this.generic) out.generic = this.generic;
    if (this.catch_) out.catch = this.catch_.toJSON();
    return out;
  }

  clone(): CallStep {
    const args: Record<string, Expr> = {};
    for (const [k, v] of Object.entries(this.args)) args[k] = v.clone();
    return new CallStep(args, this.generic, this.catch_?.clone());
  }

  /** Build a TypeScope of this step's generic bindings layered on top
   *  of `calledType.scope`. Returns the called type's scope verbatim
   *  when there are no bindings. Threaded through type-resolution
   *  methods (`call`, `parse`, etc.) at the call site so AliasTypes
   *  inside the called signature resolve to the bound types without
   *  rebuilding the type tree.
   *
   *  Validates each binding against its declared constraint
   *  (`calledType.generic[name]`). A binding `T` is accepted iff
   *  `constraint.compatible(T)` — equivalently, `T` is assignable to
   *  the constraint. Throws on violation: parsing the binding into
   *  the call scope before that check would silently use an unsound
   *  type, so failing fast is the right call.
   *
   *  Bindings for generic names the called type didn't declare are
   *  parsed into the call scope but not validated (they may target
   *  aliases declared on `call.types` or simply be ignored). */
  callSiteScope(calledType: Type): TypeScope {
    if (!this.generic || Object.keys(this.generic).length === 0) {
      return calledType.scope;
    }
    const bindings: Record<string, Type> = {};
    const declaredGenerics = calledType.generic ?? {};
    // Parse each binding TypeDef in the called type's own scope so
    // intra-binding name lookups (e.g. R: list<num>) resolve naturally.
    for (const [k, def] of Object.entries(this.generic)) {
      const bound = calledType.scope.parse(def);
      const constraint = declaredGenerics[k];
      if (constraint) {
        // Self-referential placeholder (e.g. `R: alias('R')`) means
        // "no constraint" — skip the satisfies check, every binding
        // is accepted.
        const isSelfRef = constraint.name === 'alias'
          && (constraint.options as { name?: string } | undefined)?.name === k;
        if (!isSelfRef && !constraint.compatible(bound)) {
          throw new Error(
            `path: generic '${k}' binding '${bound.toCode()}' does not satisfy constraint '${constraint.toCode()}'`,
          );
        }
      }
      bindings[k] = bound;
    }
    return new LocalScope(calledType.scope, bindings);
  }

  /** Call sites pay for the SIGNATURE (every arg Expr, the catch
   *  handler), not the called fn's body. This is the helper discount
   *  that makes decomposition genuinely reduce caller complexity. */
  complexity(): number {
    let cost = 1;
    for (const arg of Object.values(this.args)) cost += arg.complexity();
    if (this.catch_) cost += this.catch_.complexity();
    return cost;
  }

  /** Evaluate all arg Exprs against `scope` and return a Value<args>. */
  async buildArgsValue(calledType: Type, scope: Scope, engine: Engine): Promise<Value> {
    const callScope = this.callSiteScope(calledType);
    const callable = calledType.call?.(callScope);
    const argsType = callable?.args ?? engine.registry.obj({});
    const raw: Record<string, Value> = {};
    for (const [name, expr] of Object.entries(this.args)) {
      raw[name] = await expr.evaluate(engine, scope);
    }
    return new Value(argsType, raw as unknown as object);
  }
}

export class IndexStep extends PathStep {
  constructor(readonly key: Expr) {
    super();
  }
  toJSON(): PathIndexDef { return { key: this.key.toJSON() }; }
  clone(): IndexStep { return new IndexStep(this.key.clone()); }
  complexity(): number { return 1 + this.key.complexity(); }
}

// ─── Path ──────────────────────────────────────────────────────────────────

export class Path {
  constructor(readonly steps: ReadonlyArray<PathStep>) {}

  static from(json: PathDef, scope: TypeScope): Path {
    return new Path(json.map((s) => PathStep.from(s, scope)));
  }

  toJSON(): PathDef {
    return this.steps.map((s) => s.toJSON());
  }

  /**
   * `Code`-rendered JSON form of this path. Each step gets a span at
   * `[...path, i]`; nested arg / key / catch sub-Exprs nest deeper to
   * match validator-emitted paths during a path validateWalk. Used by
   * `GetExpr.toJSONCode` / `SetExpr.toJSONCode`.
   */
  toJSONCode(
    path: ReadonlyArray<string | number> = [],
    indent: number = 2,
    level: number = 0,
  ): Code {
    const items = this.steps.map((step, i) => {
      const stepPath = [...path, i] as const;
      return renderPathStepJSON(step, stepPath, indent, level + 1);
    });
    return Code.jsonArray(items, { path }, level, indent);
  }

  clone(): Path {
    return new Path(this.steps.map((s) => s.clone()));
  }

  /** Sum of structural complexity over every step. Each step kind
   *  defines its own cost contribution (see `PathStep.complexity()`).
   *  The helper-discount lives on `CallStep`: a call pays for its
   *  signature (args + catch), not the called fn's body. */
  complexity(): number {
    let cost = 0;
    for (const step of this.steps) cost += step.complexity();
    return cost;
  }

  /** Visit every Expr embedded in this Path's step arguments/keys. */
  forEachExpr(visit: (expr: Expr) => void): void {
    for (const step of this.steps) {
      if (step instanceof CallStep) {
        for (const a of Object.values(step.args)) visit(a);
        if (step.catch_) visit(step.catch_);
      } else if (step instanceof IndexStep) {
        visit(step.key);
      }
    }
  }

  toCode(registry: Registry, options: CodeOptions = {}): string {
    return this.toGinCode(registry, options).toString();
  }

  /**
   * `Code`-aware path render. Every step gets a span at `[...path,
   * 'path', i]`; nested arg / key / catch sub-Exprs get their own
   * deeper spans matching what the validator emits during a path
   * validateWalk. Used by GetExpr / SetExpr (which delegate path
   * rendering to Path).
   */
  toGinCode(registry: Registry, options: CodeOptions = {}, path: ReadonlyArray<string | number> = []): Code {
    if (this.steps.length === 0) return new Code('');
    let out: Code = new Code('');
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]!;
      const stepPath = [...path, 'path', i] as const;
      if (step instanceof PropStep) {
        const stepText = i === 0 ? step.prop : `.${step.prop}`;
        out = i === 0
          ? span(stepText, { path: stepPath })
          : code`${out}${span(stepText, { path: stepPath })}`;
      } else if (step instanceof CallStep) {
        const entries = Object.entries(step.args);
        let callBody: Code;
        if (entries.length === 0) {
          callBody = new Code('()');
        } else {
          const parts: Code[] = entries.map(([k, v]) => {
            const argPath = [...stepPath, 'args', k] as const;
            const valCode = v.toGinCode(registry, { ...options, expectsValue: true }, argPath);
            return code`${k}: ${valCode}`;
          });
          // Reuse joinAuto's heuristic on the joined string form.
          const joined = joinAuto(parts.map((p) => p.toString()));
          if (joined.startsWith('\n')) {
            // Wrapped form: `({\n  a,\n  b,\n  c\n})`. The separator
            // already places 2 spaces of indent before each non-first
            // entry; only the first entry needs its own leading
            // indent (supplied by the outer template's `\n  `).
            const inner = joinCode(parts, ',\n  ');
            callBody = code`({\n  ${inner}\n})`;
          } else {
            const inner = joinCode(parts, ', ');
            callBody = code`({ ${inner} })`;
          }
        }
        out = code`${out}${span(callBody, { path: stepPath })}`;
        if (step.catch_) {
          const handler = step.catch_.toGinCode(registry, { ...options, expectsValue: true }, [...stepPath, 'catch']);
          out = code`${out}.catch((error) => ${handler})`;
        }
      } else if (step instanceof IndexStep) {
        const key = step.key.toGinCode(registry, { ...options, expectsValue: true }, [...stepPath, 'key']);
        out = code`${out}${span(code`[${key}]`, { path: stepPath })}`;
      }
    }
    return out;
  }

  // ─── RUNTIME EVALUATION ──────────────────────────────────────────────────

  /**
   * Walk this path producing a Value. In 'set' mode the tail step is the
   * write target; on safe-nav short-circuit (null/undefined dereference
   * on prop/index) returns `bool(false)` silently.
   */
  async walk(scope: Scope, engine: Engine, mode: PathMode = { mode: 'get' }): Promise<Value> {
    if (this.steps.length === 0) throw new Error('Path.walk: empty path');

    const abortSet = (): Value => val(engine.registry.bool(), false);
    const okSet = (): Value => val(engine.registry.bool(), true);

    let current: Value | null = null;
    let i = 0;

    while (i < this.steps.length) {
      const step = this.steps[i]!;
      const isLast = i === this.steps.length - 1;

      if (
        mode.mode === 'set' &&
        current !== null &&
        isEmpty(current) &&
        !(step instanceof CallStep)
      ) {
        return abortSet();
      }

      if (step instanceof PropStep) {
        if (current === null) {
          const v = scope.get(step.prop);
          if (v === undefined) {
            throw new Error(`path: unknown variable '${step.prop}'${didYouMean(step.prop, scope.names())}`);
          }
          current = v;
          i++;
          continue;
        }
        const prop = current.type.prop(step.prop);
        if (!prop) {
          // The declaration cannot answer — ask the value itself before
          // giving up. See `carriedSlot`.
          const carried: Value | undefined = mode.mode === 'get'
            ? carriedSlot(current, step.prop)
            : undefined;
          if (carried) {
            current = carried;
            i++;
            continue;
          }
          throw new Error(
            `path: no prop '${step.prop}' on type '${current.type.name}'${suggestPathTail(current.type, this.steps, i)}`,
          );
        }
        const propType = propTypeVia(current.type, prop);

        const next = this.steps[i + 1];
        const nextIsCall = next instanceof CallStep;
        if (nextIsCall && propType.call()) {
          const argsValue = await (next as CallStep).buildArgsValue(propType, scope, engine);

          if (i + 1 === this.steps.length - 1 && mode.mode === 'set') {
            await prop.invokeMethodSet(current, step.prop, argsValue, mode.setValue!, scope, engine, propType);
            return okSet();
          }

          try {
            current = await prop.invokeMethod(current, step.prop, argsValue, scope, engine, propType);
          } catch (sig) {
            if (sig instanceof ThrowSignal && (next as CallStep).catch_) {
              const c = scope.child({ error: sig.error });
              current = await (next as CallStep).catch_!.evaluate(engine, c);
            } else {
              throw sig;
            }
          }
          i += 2;
          continue;
        }

        // Auto-call: prop is a method with no required args, no
        // explicit `{args: ...}` step follows. Synthesize an empty-
        // args call so `optional<T>.has` reads as the bool result,
        // not the bare function value. Only triggers in the
        // prop-access branch (current !== null) — standalone fn vars
        // in scope still resolve to their function value.
        if (!nextIsCall && isAutoCallable(propType)) {
          const argsValue = await new CallStep({}, undefined, undefined).buildArgsValue(propType, scope, engine);
          if (isLast && mode.mode === 'set') {
            await prop.invokeMethodSet(current, step.prop, argsValue, mode.setValue!, scope, engine, propType);
            return okSet();
          }
          current = await prop.invokeMethod(current, step.prop, argsValue, scope, engine, propType);
          i++;
          continue;
        }

        if (isLast && mode.mode === 'set') {
          await prop.write(current, step.prop, mode.setValue!, scope, engine);
          return okSet();
        }

        current = await prop.read(current, step.prop, scope, engine, propType);
        i++;
        continue;
      }

      if (step instanceof IndexStep) {
        if (current === null) throw new Error('path: [key] cannot be the first step');
        const gs = current.type.get();
        if (!gs) throw new Error(`path: type '${current.type.name}' has no indexed access`);
        const keyValue = await step.key.evaluate(engine, scope);

        if (isLast && mode.mode === 'set') {
          await gs.indexWrite(current, keyValue, mode.setValue!, scope, engine);
          return okSet();
        }

        current = await gs.indexRead(current, keyValue, scope, engine);
        i++;
        continue;
      }

      if (step instanceof CallStep) {
        if (current === null) throw new Error('path: (args) cannot be the first step');
        const callable: unknown = current.raw;
        const callType = current.type;
        const callSpec = callType.call();
        const argsValue = await step.buildArgsValue(callType, scope, engine);

        if (isLast && mode.mode === 'set') {
          if (!callSpec?.set) {
            throw new Error(`path: call on type '${callType.name}' has no call.set`);
          }
          const callSetExpr = callSpec.set;
          const setterCallable = async (newArgs: Value): Promise<Value> => {
            const recurseValue = new Value(callType, setterCallable);
            await callSetExpr.evaluate(engine, scope.child({
              args: newArgs, value: mode.setValue!, recurse: recurseValue,
            }));
            return val(engine.registry.void(), undefined);
          };
          await setterCallable(argsValue);
          return okSet();
        }

        try {
          if (typeof callable === 'function') {
            current = await callable(argsValue);
          } else if (callSpec?.get) {
            const callGetExpr = callSpec.get;
            const getterCallable = async (newArgs: Value): Promise<Value> => {
              const recurseValue = new Value(callType, getterCallable);
              // Catch ReturnSignal so a saved fn body using `flow:'return'`
              // unwinds to its own call boundary (not all the way out
              // through the caller's enclosing lambda).
              try {
                return await callGetExpr.evaluate(engine, scope.child({
                  args: newArgs, recurse: recurseValue,
                }));
              } catch (sig) {
                if (sig instanceof ReturnSignal) {
                  return sig.value ?? val(engine.registry.void(), undefined);
                }
                throw sig;
              }
            };
            current = await getterCallable(argsValue);
          } else {
            throw new Error(`path: value of type '${callType.name}' is not callable`);
          }
        } catch (sig) {
          if (sig instanceof ThrowSignal && step.catch_) {
            const child = scope.child({ error: sig.error });
            current = await step.catch_.evaluate(engine, child);
          } else {
            throw sig;
          }
        }
        i++;
        continue;
      }

      throw new Error(`path: unknown step at index ${i}`);
    }

    return current!;
  }

  // ─── STATIC ANALYSIS ─────────────────────────────────────────────────────

  typeOf(engine: Engine, scope: Locals): Type {
    if (this.steps.length === 0) return engine.registry.any();
    let current: Type | null = null;
    let i = 0;

    while (i < this.steps.length) {
      const step = this.steps[i]!;

      if (step instanceof PropStep) {
        if (current === null) {
          current = scope.get(step.prop) ?? engine.registry.any();
          i++;
          continue;
        }
        const propI: Prop | undefined = current.prop(step.prop);
        if (!propI) return engine.registry.any();
        const propIType = propTypeVia(current, propI);

        const next = this.steps[i + 1];
        if (next instanceof CallStep && propIType.call()) {
          const callScope: TypeScope = next.callSiteScope(propIType);
          const ret: Type | undefined = propIType.call(callScope)?.returns;
          current = ret?.simplify(callScope) ?? ret ?? engine.registry.any();
          i += 2;
          continue;
        }
        // Auto-call zero-required-arg methods on prop access (see
        // `isAutoCallable` for the rule). Mirrors the runtime branch
        // in `evaluate` so static type inference matches what the
        // program will actually return.
        if (!(next instanceof CallStep) && isAutoCallable(propIType)) {
          const ret: Type | undefined = propIType.call()?.returns;
          current = ret ?? engine.registry.any();
          i++;
          continue;
        }
        current = propIType;
        i++;
        continue;
      }

      if (step instanceof IndexStep) {
        current = current?.get()?.value ?? engine.registry.any();
        i++;
        continue;
      }

      if (step instanceof CallStep) {
        if (current) {
          const callScope: TypeScope = step.callSiteScope(current);
          const ret: Type | undefined = current.call(callScope)?.returns;
          current = ret?.simplify(callScope) ?? ret ?? engine.registry.any();
        } else {
          current = engine.registry.any();
        }
        i++;
        continue;
      }
      i++;
    }

    return current ?? engine.registry.any();
  }

  validateWalk(
    engine: Engine,
    scope: Locals,
    p: Problems,
    ctx: ValidateContext,
    mode: 'get' | 'set' = 'get',
  ): Type {
    if (this.steps.length === 0) {
      p.error('path.empty', 'path is empty');
      return engine.registry.any();
    }

    if (mode === 'set' && this.steps.length === 1 && this.steps[0] instanceof PropStep) {
      return engine.registry.any();
    }

    let current: Type | null = null;
    let i = 0;

    while (i < this.steps.length) {
      const step = this.steps[i]!;
      const isLast = i === this.steps.length - 1;

      if (step instanceof PropStep) {
        if (current === null) {
          const t = scope.get(step.prop);
          if (!t) {
            p.at(['path', i], () => p.error('var.unknown',
              `unknown variable '${step.prop}'${didYouMean(step.prop, [...scope.keys()])}`));
            current = engine.registry.any();
          } else {
            current = t;
          }
          i++;
          continue;
        }
        const propV: Prop | undefined = current.prop(step.prop);
        if (!propV) {
          p.at(['path', i], () => p.error('prop.unknown',
            `no prop '${step.prop}' on type '${current!.name}'${suggestPathTail(current!, this.steps, i)}`));
          current = engine.registry.any();
          i++;
          continue;
        }
        const propVType = propTypeVia(current, propV);
        const next = this.steps[i + 1];
        if (next instanceof CallStep && propVType.call()) {
          for (const [name, argExpr] of Object.entries(next.args)) {
            p.at(['path', i + 1, 'args', name], () => argExpr.validateWalk(engine, scope, p, ctx));
          }
          if (next.catch_) {
            p.at(['path', i + 1, 'catch'], () => next.catch_!.validateWalk(engine, scope, p, ctx));
          }
          const callScope: TypeScope = next.callSiteScope(propVType);
          const callable: Call | undefined = propVType.call(callScope);
          reportMissingArgs(callable, next.args, p, ['path', i + 1]);
          if (mode === 'set' && i + 1 === this.steps.length - 1) {
            if (!callable?.set) {
              p.at(['path', i + 1], () => p.error('set.call.no-set', `method '${step.prop}' has no call.set`));
            }
          }
          // Cache the resolved call's effects on the step so
          // `GetExpr.effects()` can propagate them after the
          // validator runs.
          next.resolvedEffects = callable?.effects() ?? 0;
          const ret: Type | undefined = callable?.returns;
          current = ret?.simplify(callScope) ?? ret ?? engine.registry.any();
          i += 2;
          continue;
        }
        // Auto-call zero-required-arg methods on prop access: mirrors
        // `evaluate` and `typeOf` so a program like `args.opt.has`
        // type-checks as bool (the call's return) instead of fn.
        if (!(next instanceof CallStep) && isAutoCallable(propVType)) {
          const ret: Type | undefined = propVType.call()?.returns;
          current = ret ?? engine.registry.any();
          i++;
          continue;
        }
        if (mode === 'set' && isLast) {
          // Writing to a prop is allowed unless it's genuinely
          // impossible. The only impossible case is a computed
          // VALUE prop — `get` Expr present, no `set` Expr, and the
          // prop's type is NOT callable. For those, the read is
          // derived from `this` (no underlying slot to write into).
          //
          // Method-typed props (`propV.type.call()`) are NOT flagged
          // here even if `propV.set` is missing — `propV.type.call()
          // .set` could route the assignment through the call's own
          // setter, or an extension could add a custom `propV.set`,
          // or the runtime can fall through to a raw assignment.
          // The validator doesn't have enough information at this
          // step to decide; the runtime surfaces a clear error if
          // the assignment is genuinely impossible.
          if (!propV.set && propV.get && !propVType.call()) {
            p.at(['path', i], () => p.error('set.prop.computed',
              `prop '${step.prop}' is computed (read-only); cannot assign to it`));
          }
        }
        // A method (callable with required args) read WITHOUT a following
        // `{args:…}` call step silently degrades at runtime — its params bind
        // to nothing. Require the call so the retry loop can catch it. (Set
        // mode may legitimately route a bare method through its `call.set`.)
        const bareCall: Call | undefined = mode === 'get' ? propVType.call() : undefined;
        if (bareCall && !isAutoCallable(propVType)) {
          p.at(['path', i], () => p.error('call.uncalled',
            `method '${step.prop}' needs arguments — add an {args:{…}} step to call it`));
          current = bareCall.returns ?? engine.registry.any();
          i++;
          continue;
        }
        current = propVType;
        i++;
        continue;
      }

      if (step instanceof IndexStep) {
        p.at(['path', i, 'key'], () => step.key.validateWalk(engine, scope, p, ctx));
        const gs: GetSet | undefined = current?.get();
        if (mode === 'set' && isLast) {
          if (!gs?.set) {
            p.at(['path', i], () => p.error('set.index.no-set', `type '${current?.name ?? '?'}' has no index set`));
          }
        } else if (!gs?.get) {
          p.at(['path', i], () => p.error('index.unsupported', `type '${current?.name ?? '?'}' has no indexed access`));
        }
        current = gs?.value ?? engine.registry.any();
        i++;
        continue;
      }

      if (step instanceof CallStep) {
        for (const [name, argExpr] of Object.entries(step.args)) {
          p.at(['path', i, 'args', name], () => argExpr.validateWalk(engine, scope, p, ctx));
        }
        if (current) {
          const callScope: TypeScope = step.callSiteScope(current);
          const callable: Call | undefined = current.call(callScope);
          reportMissingArgs(callable, step.args, p, ['path', i]);
          if (mode === 'set' && isLast) {
            if (!callable?.set) {
              p.at(['path', i], () => p.error('set.call.no-set', `call on type '${current?.name ?? '?'}' has no call.set`));
            }
          }
          step.resolvedEffects = callable?.effects() ?? 0;
          const ret: Type | undefined = callable?.returns;
          current = ret?.simplify(callScope) ?? ret ?? engine.registry.any();
        } else {
          step.resolvedEffects = 0;
          current = engine.registry.any();
        }
        i++;
        continue;
      }
      i++;
    }

    return current ?? engine.registry.any();
  }
}

function isEmpty(v: Value): boolean {
  return v.raw === null || v.raw === undefined;
}

// ─── walkPath helper ────────────────────────────────────────────────────────

/**
 * Convenience: accepts a raw PathDef JSON or an already-parsed `Path`,
 * parses if needed, and walks it.
 */
export async function walkPath(
  path: PathDef | Path,
  scope: Scope,
  engine: Engine,
  mode: PathMode = { mode: 'get' },
): Promise<Value> {
  const p = path instanceof Path ? path : Path.from(path, engine.registry);
  return p.walk(scope, engine, mode);
}

/**
 * Render a single `PathStep` as a JSON object Code. Each step has its
 * own JSON shape:
 *   - PropStep   → `{ "prop": "<name>" }`
 *   - CallStep   → `{ "args": { ... } [, "generic": ...] [, "catch": ...] }`
 *   - IndexStep  → `{ "key": <ExprDef> }`
 *
 * Sub-Exprs (args, catch, key) recurse into their own `toJSONCode`
 * with appropriate path suffixes so a `template.placeholder.unresolved`
 * inside a `catch` block, for example, resolves to the right span.
 */
function renderPathStepJSON(
  step: PathStep,
  stepPath: ReadonlyArray<string | number>,
  indent: number,
  level: number,
): Code {
  if (step instanceof PropStep) {
    return Code.jsonObject(
      [{ key: 'prop', value: Code.jsonString(step.prop) }],
      { path: stepPath },
      level,
      indent,
    );
  }
  if (step instanceof CallStep) {
    const argEntries = Object.entries(step.args).map(([k, expr]) => ({
      key: k,
      value: expr.toJSONCode([...stepPath, 'args', k], indent, level + 2),
    }));
    const argsObj = Code.jsonObject(argEntries, { path: [...stepPath, 'args'] }, level + 1, indent);
    const entries: Array<{ key: string; value: Code | string | undefined }> = [
      { key: 'args', value: argsObj },
    ];
    if (step.generic) {
      // `generic` is a Record<string, TypeDef>. We don't span-track
      // individual TypeDef positions here — the validator currently
      // emits errors at the call-step level, not into individual
      // generic bindings. Inline as plain JSON; coarse-span fallback.
      entries.push({
        key: 'generic',
        value: JSON.stringify(step.generic, null, indent)
          .replace(/\n/g, '\n' + ' '.repeat(level * indent)),
      });
    }
    if (step.catch_) {
      entries.push({
        key: 'catch',
        value: step.catch_.toJSONCode([...stepPath, 'catch'], indent, level + 1),
      });
    }
    return Code.jsonObject(entries, { path: stepPath }, level, indent);
  }
  if (step instanceof IndexStep) {
    return Code.jsonObject(
      [{ key: 'key', value: step.key.toJSONCode([...stepPath, 'key'], indent, level + 1) }],
      { path: stepPath },
      level,
      indent,
    );
  }
  // Unknown step kind — fall back to generic JSON.stringify.
  return new Code(JSON.stringify(step.toJSON(), null, indent));
}
