import type { Engine } from './engine';
import type { Scope } from './scope';
import type {
  ExprDef, PathDef, PathStepDef, PathPropDef, PathCallDef, PathIndexDef,
  TypeDef,
} from './schema';
import { Value, val } from './value';
import { ThrowSignal } from './flow-control';
import type { GetSet, Type } from './type';
import { Expr } from './expr';
import type { Registry } from './registry';
import type { TypeScope } from './analysis';
import type { Problems } from './problem';
import type { ValidateContext } from './expr';

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

  static from(json: PathStepDef, registry: Registry): PathStep {
    if ('prop' in json) return new PropStep(json.prop);
    if ('args' in json) {
      const args: Record<string, Expr> = {};
      for (const [k, v] of Object.entries(json.args ?? {})) {
        args[k] = registry.parseExpr(v);
      }
      return new CallStep(args, json.generic, json.catch ? registry.parseExpr(json.catch) : undefined);
    }
    if ('key' in json) return new IndexStep(registry.parseExpr((json as PathIndexDef).key));
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

  /** Apply this step's generic bindings to the given callable type. */
  bindGeneric(calledType: Type, engine: Engine): Type {
    if (!this.generic || Object.keys(this.generic).length === 0) return calledType;
    const bindings: Record<string, Type> = {};
    for (const [k, def] of Object.entries(this.generic)) {
      bindings[k] = engine.registry.parse(def);
    }
    return calledType.bind(bindings);
  }

  /** Evaluate all arg Exprs against `scope` and return a Value<args>. */
  async buildArgsValue(calledType: Type, scope: Scope, engine: Engine): Promise<Value> {
    const effectiveType = this.bindGeneric(calledType, engine);
    const callable = effectiveType.call?.();
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

  static from(json: PathDef, registry: Registry): Path {
    return new Path(json.map((s) => PathStep.from(s, registry)));
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

  toCode(registry: Registry): string {
    if (this.steps.length === 0) return '';
    let out = '';
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]!;
      if (step instanceof PropStep) {
        out = i === 0 ? step.prop : `${out}.${step.prop}`;
      } else if (step instanceof CallStep) {
        const entries = Object.entries(step.args);
        const body = entries.length === 0
          ? '{}'
          : `{ ${entries.map(([k, v]) => `${k}: ${v.toCode(registry)}`).join(', ')} }`;
        out += `(${body})`;
        if (step.catch_) {
          out += ` /* catch: ${step.catch_.toCode(registry).replace(/\*\//g, '*_/')} */`;
        }
      } else if (step instanceof IndexStep) {
        out += `[${step.key.toCode(registry)}]`;
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
          const effectiveFnType = (next as CallStep).bindGeneric(prop.type, engine);
          const argsValue = await (next as CallStep).buildArgsValue(prop.type, scope, engine);

          if (i + 1 === this.steps.length - 1 && mode.mode === 'set') {
            await prop.invokeMethodSet(current, step.prop, argsValue, mode.setValue!, scope, engine, effectiveFnType);
            return okSet();
          }

          try {
            current = await prop.invokeMethod(current, step.prop, argsValue, scope, engine, effectiveFnType);
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
              return engine.evaluate(callSpec.get!, scope.child({
                args: newArgs, recurse: recurseValue,
              }));
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

  typeOf(engine: Engine, scope: TypeScope): Type {
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
        const p = current.prop(step.prop);
        if (!p) return engine.registry.any();

        const next = this.steps[i + 1];
        if (next instanceof CallStep && p.type.call()) {
          const effective = next.bindGeneric(p.type, engine);
          current = effective.call()?.returns ?? engine.registry.any();
          i += 2;
          continue;
        }
        current = p.type;
        i++;
        continue;
      }

      if (step instanceof IndexStep) {
        current = current?.get()?.value ?? engine.registry.any();
        i++;
        continue;
      }

      if (step instanceof CallStep) {
        const effective: Type | undefined = current ? step.bindGeneric(current, engine) : undefined;
        current = effective?.call()?.returns ?? engine.registry.any();
        i++;
        continue;
      }
      i++;
    }

    return current ?? engine.registry.any();
  }

  validateWalk(
    engine: Engine,
    scope: TypeScope,
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
        const pp = current.prop(step.prop);
        if (!pp) {
          p.at(['path', i], () => p.error('prop.unknown', `no prop '${step.prop}' on type '${current!.name}'`));
          current = engine.registry.any();
          i++;
          continue;
        }
        const next = this.steps[i + 1];
        if (next instanceof CallStep && pp.type.call()) {
          for (const [name, argExpr] of Object.entries(next.args)) {
            p.at(['path', i + 1, 'args', name], () => argExpr.validateWalk(engine, scope, p, ctx));
          }
          if (next.catch_) {
            p.at(['path', i + 1, 'catch'], () => next.catch_!.validateWalk(engine, scope, p, ctx));
          }
          const effective = next.bindGeneric(pp.type, engine);
          if (mode === 'set' && i + 1 === this.steps.length - 1) {
            if (!effective.call()?.set) {
              p.at(['path', i + 1], () => p.error('set.call.no-set', `method '${step.prop}' has no call.set`));
            }
          }
          current = effective.call()?.returns ?? engine.registry.any();
          i += 2;
          continue;
        }
        if (mode === 'set' && isLast) {
          if (!pp.set) {
            p.at(['path', i], () => p.error('set.prop.no-set', `prop '${step.prop}' has no set expression`));
          }
        }
        current = pp.type;
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
        const effective: Type | undefined = current ? step.bindGeneric(current, engine) : undefined;
        if (mode === 'set' && isLast) {
          if (!effective?.call()?.set) {
            p.at(['path', i], () => p.error('set.call.no-set', `call on type '${current?.name ?? '?'}' has no call.set`));
          }
        }
        current = effective?.call()?.returns ?? engine.registry.any();
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

// ─── legacy walkPath wrapper ────────────────────────────────────────────────

/**
 * Backwards-compat: accepts a raw PathDef JSON and walks it.
 * Parses through Path.from for structured traversal.
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
