import type { Engine } from './engine';
import type { Scope } from './scope';
import type {
  ExprDef, PathDef, PathStepDef, PathPropDef, PathCallDef, PathIndexDef,
  TypeDef,
} from './schema';
import { Value, val } from './value';
import { ReturnSignal, ThrowSignal } from './flow-control';
import type { GetSet, Type } from './type';
import { Expr } from './expr';
import type { Registry } from './registry';
import type { Locals } from './analysis';
import type { Problems } from './problem';
import type { ValidateContext } from './expr';
import { LocalScope, type TypeScope } from './type-scope';
import { joinAuto } from './type';
import { ObjType } from './types/obj';
import type { CodeOptions } from './node';

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

  static from(json: PathStepDef, scope: TypeScope): PathStep {
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
}

export class CallStep extends PathStep {
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

  clone(): Path {
    return new Path(this.steps.map((s) => s.clone()));
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
    if (this.steps.length === 0) return '';
    let out = '';
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]!;
      if (step instanceof PropStep) {
        out = i === 0 ? step.prop : `${out}.${step.prop}`;
      } else if (step instanceof CallStep) {
        const entries = Object.entries(step.args);
        if (entries.length === 0) {
          // No args — render as a bare `()`. Showing `({})` would be
          // accurate but visually noisier (the empty obj is implied).
          out += '()';
        } else {
          const parts = entries.map(([k, v]) => `${k}: ${v.toCode(registry, { ...options, expectsValue: true })}`);
          const joined = joinAuto(parts);
          // joinAuto returns `\n  …\n` for the wrapped form, plain
          // `a, b` for the compact form. Brace-spacing matches each.
          out += joined.startsWith('\n') ? `({${joined}})` : `({ ${joined} })`;
        }
        if (step.catch_) {
          // Render `catch:` as a JS-like `.catch(err => …)` chain so
          // it survives nested comments / complex catch bodies. The
          // call expects `error` in scope; the rendered handler
          // signature mirrors that.
          const handler = step.catch_.toCode(registry, { ...options, expectsValue: true });
          out += `.catch((error) => ${handler})`;
        }
      } else if (step instanceof IndexStep) {
        out += `[${step.key.toCode(registry, { ...options, expectsValue: true })}]`;
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
          if (v === undefined) throw new Error(`path: unknown variable '${step.prop}'`);
          current = v;
          i++;
          continue;
        }
        const prop = current.type.prop(step.prop);
        if (!prop) throw new Error(`path: no prop '${step.prop}' on type '${current.type.name}'`);

        const next = this.steps[i + 1];
        const nextIsCall = next instanceof CallStep;
        if (nextIsCall && prop.type.call()) {
          const argsValue = await (next as CallStep).buildArgsValue(prop.type, scope, engine);

          if (i + 1 === this.steps.length - 1 && mode.mode === 'set') {
            await prop.invokeMethodSet(current, step.prop, argsValue, mode.setValue!, scope, engine, prop.type);
            return okSet();
          }

          try {
            current = await prop.invokeMethod(current, step.prop, argsValue, scope, engine, prop.type);
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
        if (!nextIsCall && isAutoCallable(prop.type)) {
          const argsValue = await new CallStep({}, undefined, undefined).buildArgsValue(prop.type, scope, engine);
          if (isLast && mode.mode === 'set') {
            await prop.invokeMethodSet(current, step.prop, argsValue, mode.setValue!, scope, engine, prop.type);
            return okSet();
          }
          current = await prop.invokeMethod(current, step.prop, argsValue, scope, engine, prop.type);
          i++;
          continue;
        }

        if (isLast && mode.mode === 'set') {
          await prop.write(current, step.prop, mode.setValue!, scope, engine);
          return okSet();
        }

        current = await prop.read(current, step.prop, scope, engine);
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
          const setterCallable = async (newArgs: Value): Promise<Value> => {
            const recurseValue = new Value(callType, setterCallable);
            await engine.evaluate(callSpec.set!, scope.child({
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
            const getterCallable = async (newArgs: Value): Promise<Value> => {
              const recurseValue = new Value(callType, getterCallable);
              // Catch ReturnSignal so a saved fn body using `flow:'return'`
              // unwinds to its own call boundary (not all the way out
              // through the caller's enclosing lambda).
              try {
                return await engine.evaluate(callSpec.get!, scope.child({
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
        const propI: import('./type').Prop | undefined = current.prop(step.prop);
        if (!propI) return engine.registry.any();

        const next = this.steps[i + 1];
        if (next instanceof CallStep && propI.type.call()) {
          const callScope: TypeScope = next.callSiteScope(propI.type);
          const ret: Type | undefined = propI.type.call(callScope)?.returns;
          current = ret?.simplify(callScope) ?? ret ?? engine.registry.any();
          i += 2;
          continue;
        }
        // Auto-call zero-required-arg methods on prop access (see
        // `isAutoCallable` for the rule). Mirrors the runtime branch
        // in `evaluate` so static type inference matches what the
        // program will actually return.
        if (!(next instanceof CallStep) && isAutoCallable(propI.type)) {
          const ret: Type | undefined = propI.type.call()?.returns;
          current = ret ?? engine.registry.any();
          i++;
          continue;
        }
        current = propI.type;
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
            p.at(['path', i], () => p.error('var.unknown', `unknown variable '${step.prop}'`));
            current = engine.registry.any();
          } else {
            current = t;
          }
          i++;
          continue;
        }
        const propV: import('./type').Prop | undefined = current.prop(step.prop);
        if (!propV) {
          p.at(['path', i], () => p.error('prop.unknown', `no prop '${step.prop}' on type '${current!.name}'`));
          current = engine.registry.any();
          i++;
          continue;
        }
        const next = this.steps[i + 1];
        if (next instanceof CallStep && propV.type.call()) {
          for (const [name, argExpr] of Object.entries(next.args)) {
            p.at(['path', i + 1, 'args', name], () => argExpr.validateWalk(engine, scope, p, ctx));
          }
          if (next.catch_) {
            p.at(['path', i + 1, 'catch'], () => next.catch_!.validateWalk(engine, scope, p, ctx));
          }
          const callScope: TypeScope = next.callSiteScope(propV.type);
          const callable: import('./type').Call | undefined = propV.type.call(callScope);
          if (mode === 'set' && i + 1 === this.steps.length - 1) {
            if (!callable?.set) {
              p.at(['path', i + 1], () => p.error('set.call.no-set', `method '${step.prop}' has no call.set`));
            }
          }
          const ret: Type | undefined = callable?.returns;
          current = ret?.simplify(callScope) ?? ret ?? engine.registry.any();
          i += 2;
          continue;
        }
        // Auto-call zero-required-arg methods on prop access: mirrors
        // `evaluate` and `typeOf` so a program like `args.opt.has`
        // type-checks as bool (the call's return) instead of fn.
        if (!(next instanceof CallStep) && isAutoCallable(propV.type)) {
          const ret: Type | undefined = propV.type.call()?.returns;
          current = ret ?? engine.registry.any();
          i++;
          continue;
        }
        if (mode === 'set' && isLast) {
          if (!propV.set) {
            p.at(['path', i], () => p.error('set.prop.no-set', `prop '${step.prop}' has no set expression`));
          }
        }
        current = propV.type;
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
          const callable: import('./type').Call | undefined = current.call(callScope);
          if (mode === 'set' && isLast) {
            if (!callable?.set) {
              p.at(['path', i], () => p.error('set.call.no-set', `call on type '${current?.name ?? '?'}' has no call.set`));
            }
          }
          const ret: Type | undefined = callable?.returns;
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
