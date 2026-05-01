import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { LoopExprDef, ExprDef } from '../schema';
import { Value, val } from '../value';
import { BreakSignal, ContinueSignal } from '../flow-control';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Locals } from '../analysis';
import { checkBindingName, walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { indentCode } from './code';
import { z } from 'zod';
import { baseExprFields } from '../schemas';
import type { TypeScope } from '../type-scope';

export interface LoopParallel {
  concurrent?: Expr;
  rate?: Expr;
}

/**
 * LoopExpr — iterate any type that defines `get().loop`.
 */
export class LoopExpr extends Expr {
  static readonly KIND = 'loop';
  readonly kind = LoopExpr.KIND;

  constructor(
    readonly over: Expr,
    readonly body: Expr,
    readonly keyName?: string,
    readonly valueName?: string,
    readonly parallel?: LoopParallel,
  ) {
    super();
  }

  protected useLineComment(options: CodeOptions = {}): boolean { return !options.expectsValue; }

  static from(json: LoopExprDef, scope: TypeScope): LoopExpr {
    const r = scope.registry;
    const parallel = json.parallel ? {
      concurrent: json.parallel.concurrent ? r.parseExpr(json.parallel.concurrent, scope) : undefined,
      rate: json.parallel.rate ? r.parseExpr(json.parallel.rate, scope) : undefined,
    } : undefined;
    return new LoopExpr(
      r.parseExpr(json.over, scope),
      r.parseExpr(json.body, scope),
      json.key,
      json.value,
      parallel,
    ).withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('loop'),
      ...baseExprFields,
      over: opts.Expr.describe(
        'The iterable expression. Two evaluation modes: ' +
        '(1) iterable types (list, map, etc. — anything whose `get().loop` is defined) iterate once; the expression is evaluated ONCE at the start. ' +
        '(2) bool — while-loop semantics: the expression is RE-EVALUATED each iteration; the loop continues while the value is `true` and exits the moment it becomes `false`. ' +
        'Use `flow:break` / `flow:continue` inside the body to control iteration regardless of mode.',
      ),
      body: opts.Expr.describe(
        "Evaluated once per iteration with the current `key` and `value` bound in scope. Use `{kind:'flow', action:'break'}` or `'continue'` for early-exit. The loop expression itself returns void.",
      ),
      key: z.string().optional().describe(
        'Override the scope-variable name the iteration index/key is bound under (default: `key`). Must NOT be reserved or shadow an outer scope var. Use to disambiguate when looping inside another loop.',
      ),
      value: z.string().optional().describe(
        'Override the scope-variable name the iteration value is bound under (default: `value`). Same rules as `key`.',
      ),
      parallel: z
        .object({
          concurrent: opts.Expr.optional().describe(
            'Max in-flight iterations as a num (omit / 1 → strictly sequential). Use when iterations are independent I/O — e.g. fetching N URLs concurrently.',
          ),
          rate: opts.Expr.optional().describe(
            'Minimum interval between iteration starts. Accepts a num (milliseconds) or a duration. Use to rate-limit fan-out (e.g. avoid hammering an API).',
          ),
        })
        .optional()
        .describe(
          'Opt-in parallelism. Both fields are optional and independent: `concurrent` caps fan-out width, `rate` paces start times. Iterations may finish out of order; the body should not assume sequential ordering.',
        ),
    }).meta({ aid: 'Expr_loop' });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    const over = await this.over.evaluate(engine, scope);
    const gs = over.type.get();
    // A type is iterable iff its GetSet declares EITHER a `loop`
    // ExprDef (static — e.g. list/map iterate via the native) OR
    // `loopDynamic: true` (dynamic — e.g. bool while-loop).
    const iterable = !!(gs?.loop || gs?.loopDynamic);
    if (!iterable) {
      throw new Error(`loop: type '${over.type.name}' has no loop or loopDynamic defined on its GetSet`);
    }

    const keyName = this.keyName ?? 'key';
    const valueName = this.valueName ?? 'value';

    // Dynamic mode: re-evaluate `over` against the OUTER scope each
    // iteration; continue while the value's `raw` is truthy. Body
    // mutations (via `set`) on vars the expression reads drive the
    // exit condition. `key` is the iteration index, `value` is the
    // current re-evaluated value. Bool's GetSet sets this flag for
    // while-loop semantics; other types can opt in similarly. Parallel
    // options aren't meaningful in this mode (analyzer warns).
    if (gs.loopDynamic) {
      let current: Value = over;
      let iteration = 0;
      while (current.raw) {
        const iter = scope.child({
          [keyName]: val(engine.registry.num({ whole: true, min: 0 }), iteration),
          [valueName]: current,
        });
        try {
          await this.body.evaluate(engine, iter);
        } catch (sig) {
          if (sig instanceof BreakSignal) break;
          if (!(sig instanceof ContinueSignal)) throw sig;
        }
        iteration++;
        current = await this.over.evaluate(engine, scope);
      }
      return val(engine.registry.void(), undefined);
    }

    // Static (iterable) path — gs.loop is required here. The check
    // at the top rules out the (no loop AND no loopDynamic) case, but
    // TS can't narrow through the OR so we re-assert.
    const loopExpr = gs.loop;
    if (!loopExpr) {
      throw new Error(`loop: type '${over.type.name}' has no loop ExprDef on its GetSet`);
    }

    const concurrent = this.parallel?.concurrent
      ? Number((await this.parallel.concurrent.evaluate(engine, scope)).raw)
      : undefined;
    const rateMs = this.parallel?.rate
      ? Number((await this.parallel.rate.evaluate(engine, scope)).raw)
      : undefined;

    const parallel = concurrent !== undefined || rateMs !== undefined;

    if (!parallel) {
      const yieldFn = async (keyVal: Value, valueVal: Value): Promise<Value> => {
        const iter = scope.child({ [keyName]: keyVal, [valueName]: valueVal });
        try {
          return await this.body.evaluate(engine, iter);
        } catch (sig) {
          if (sig instanceof ContinueSignal) return val(engine.registry.void(), undefined);
          throw sig;
        }
      };
      await runLoop(loopExpr, scope, engine, over, yieldFn);
      return val(engine.registry.void(), undefined);
    }

    const pool: Set<Promise<void>> = new Set();
    const maxConcurrent = concurrent ?? Infinity;
    let broken = false;
    let lastStart = 0;

    const yieldFn = async (keyVal: Value, valueVal: Value): Promise<Value> => {
      if (broken) return val(engine.registry.void(), undefined);
      if (rateMs && rateMs > 0) {
        const now = Date.now();
        const delta = now - lastStart;
        if (delta < rateMs) await new Promise((r) => setTimeout(r, rateMs - delta));
        lastStart = Date.now();
      }
      while (pool.size >= maxConcurrent) {
        await Promise.race(pool);
      }
      const iter = scope.child({ [keyName]: keyVal, [valueName]: valueVal });
      const task = (async () => {
        try {
          await this.body.evaluate(engine, iter);
        } catch (sig) {
          if (sig instanceof ContinueSignal) return;
          if (sig instanceof BreakSignal) { broken = true; return; }
          throw sig;
        }
      })();
      const wrapped = task.finally(() => pool.delete(wrapped));
      pool.add(wrapped);
      return val(engine.registry.void(), undefined);
    };

    await runLoop(gs.loop, scope, engine, over, yieldFn);
    await Promise.all(pool);
    return val(engine.registry.void(), undefined);
  }

  typeOf(engine: Engine, _scope: Locals): Type {
    return engine.registry.void();
  }

  validateWalk(engine: Engine, scope: Locals, p: Problems, ctx: ValidateContext): Type {
    const overT = p.at('over', () => walkValidate(engine, this.over, scope, p, ctx));
    const gs = overT.get();
    // Iterable: type's GetSet defines either a `loop` ExprDef
    // (static — iterated once) or `loopDynamic: true` (re-evaluated
    // per iteration; bool uses this for while-loop semantics).
    const iterable = !!(gs?.loop || gs?.loopDynamic);
    if (!iterable) {
      p.error('loop.not-iterable', `type '${overT.name}' has no loop defined`);
    }
    if (gs?.loopDynamic && this.parallel) {
      p.error('loop.parallel.dynamic', 'parallel options (concurrent / rate) are not meaningful for a dynamic (re-evaluated) loop');
    }

    // parallel.concurrent must be num; parallel.rate must be num or duration.
    if (this.parallel?.concurrent) {
      const t = p.at(['parallel', 'concurrent'], () =>
        walkValidate(engine, this.parallel!.concurrent!, scope, p, ctx));
      if (!engine.registry.num().compatible(t)) {
        p.at(['parallel', 'concurrent'], () =>
          p.error('loop.parallel.concurrent.type',
            `parallel.concurrent must be a number, got '${t.name}'`));
      }
    }
    if (this.parallel?.rate) {
      const t = p.at(['parallel', 'rate'], () =>
        walkValidate(engine, this.parallel!.rate!, scope, p, ctx));
      const isNum = engine.registry.num().compatible(t);
      const isDur = engine.registry.duration().compatible(t);
      if (!isNum && !isDur) {
        p.at(['parallel', 'rate'], () =>
          p.error('loop.parallel.rate.type',
            `parallel.rate must be a number or duration, got '${t.name}'`));
      }
    }

    // If the loop overrides keyName / valueName, the user-chosen names
    // must follow the same rules as define vars: not reserved, not
    // already in scope. The default `key` / `value` names are reserved
    // by gin precisely because loops bind them, so we don't check the
    // defaults — only explicit overrides.
    if (this.keyName !== undefined) {
      p.at('key', () => checkBindingName(this.keyName!, scope, p));
    }
    if (this.valueName !== undefined) {
      p.at('value', () => checkBindingName(this.valueName!, scope, p));
    }

    // Bind key/value from the iterable's GetSet. Both static and
    // dynamic modes share the same `gs.key` / `gs.value` types — for
    // bool that's `num{whole,min:0}` / `bool`; for list it's
    // `num{whole,min:0}` / `<element>`. Fall back to `any` only when
    // the iterable surface was missing (already errored above).
    const keyType = gs?.key ?? engine.registry.any();
    const valueType = gs?.value ?? engine.registry.any();
    const child: Locals = new Map(scope);
    child.set(this.keyName ?? 'key', keyType);
    child.set(this.valueName ?? 'value', valueType);
    p.at('body', () => walkValidate(engine, this.body, child, p, { ...ctx, inLoop: true }));
    return engine.registry.void();
  }

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    const expectsValue = options.expectsValue ?? false;
    const valueOpts = { ...options, expectsValue: true };
    const stmtOpts = { ...options, expectsValue: false };
    const over = this.over.toCode(registry, valueOpts);
    const key = this.keyName ?? 'key';
    const value = this.valueName ?? 'value';

    let prefix = '';
    if (options.includeComments !== false) {
      if (this.parallel?.concurrent) {
        prefix += `/* parallel.concurrent: ${this.parallel.concurrent.toCode(registry, valueOpts)} */ `;
      }
      if (this.parallel?.rate) {
        prefix += `/* parallel.rate: ${this.parallel.rate.toCode(registry, valueOpts)} */ `;
      }
    }

    // Body in statement context — uses bare statements / flow / nested control.
    const bodyStmt = (() => {
      const kind = (this.body as { kind: string }).kind;
      if (kind === 'flow') return `${this.body.toCode(registry, stmtOpts)};`;
      if (kind === 'block') {
        const code = this.body.toCode(registry, stmtOpts);
        return code.startsWith('{') ? code.slice(1, -1).trim() : code;
      }
      if (kind === 'if' || kind === 'switch' || kind === 'loop') {
        return this.body.toCode(registry, stmtOpts);
      }
      return `${this.body.toCode(registry, stmtOpts)};`;
    })();

    const forStmt = `${prefix}for (const [${key}, ${value}] of ${over}) {\n  ${indentCode(bodyStmt)}\n}`;
    const commentP = this.commentPrefix(options);

    // Loop returns void. If caller insists on a value, wrap in an IIFE.
    if (expectsValue) {
      return commentP + `(() => { ${forStmt}; return undefined; })()`;
    }
    return commentP + forStmt;
  }

  toJSON(): LoopExprDef {
    const out: LoopExprDef = {
      kind: 'loop',
      over: this.over.toJSON(),
      body: this.body.toJSON(),
    };
    if (this.keyName !== undefined) out.key = this.keyName;
    if (this.valueName !== undefined) out.value = this.valueName;
    if (this.parallel) {
      out.parallel = {
        concurrent: this.parallel.concurrent?.toJSON(),
        rate: this.parallel.rate?.toJSON(),
      };
    }
    return this.withCommentOn(out);
  }

  clone(): LoopExpr {
    return new LoopExpr(
      this.over.clone(),
      this.body.clone(),
      this.keyName,
      this.valueName,
      this.parallel ? {
        concurrent: this.parallel.concurrent?.clone(),
        rate: this.parallel.rate?.clone(),
      } : undefined,
    ).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    visit(this.over, 'inherit');
    visit(this.body, 'loop');
    if (this.parallel?.concurrent) visit(this.parallel.concurrent, 'inherit');
    if (this.parallel?.rate) visit(this.parallel.rate, 'inherit');
  }
}

async function runLoop(
  loopExpr: ExprDef,
  scope: Scope,
  engine: Engine,
  over: Value,
  yieldFn: (k: Value, v: Value) => Promise<Value>,
): Promise<void> {
  // `yield` in the loop scope is a callable Value with args
  // `obj({key, value})` and void return. The Value form is what makes
  // it usable from a CUSTOM loop ExprDef (e.g. a `block`/`lambda`
  // written by a dev that augments a type with their own iteration
  // shape) — path-walker call sites pass a single args-obj Value, so
  // yield's signature has to match. Native loop impls receive the
  // same Value via `scope.get('yield')` and unwrap the two fields.
  const r = engine.registry;
  const yieldType = r.fn(
    r.obj({ key: { type: r.any() }, value: { type: r.any() } }),
    r.void(),
  );
  const wrappedYield = async (argsValue: Value): Promise<Value> => {
    const fields = argsValue.raw as Record<string, Value> | null | undefined;
    if (!fields) throw new Error('yield: missing args');
    return yieldFn(fields['key']!, fields['value']!);
  };
  const yieldValue = new Value(yieldType, wrappedYield);
  const loopScope = scope.child({ this: over, yield: yieldValue });
  try {
    await engine.evaluate(loopExpr, loopScope);
  } catch (sig) {
    if (!(sig instanceof BreakSignal)) throw sig;
  }
}
