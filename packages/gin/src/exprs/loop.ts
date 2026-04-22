import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { LoopExprDef, ExprDef } from '../schema';
import { Value, val } from '../value';
import { BreakSignal, ContinueSignal } from '../flow-control';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { TypeScope } from '../analysis';
import { walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { indentCode } from './code';
import { z } from 'zod';
import { baseExprFields } from '../schemas';

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

  static from(json: LoopExprDef, registry: Registry): LoopExpr {
    const parallel = json.parallel ? {
      concurrent: json.parallel.concurrent ? registry.parseExpr(json.parallel.concurrent) : undefined,
      rate: json.parallel.rate ? registry.parseExpr(json.parallel.rate) : undefined,
    } : undefined;
    return new LoopExpr(
      registry.parseExpr(json.over),
      registry.parseExpr(json.body),
      json.key,
      json.value,
      parallel,
    ).withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('loop'),
      ...baseExprFields,
      over: opts.Expr,
      body: opts.Expr,
      key: z.string().optional(),
      value: z.string().optional(),
      parallel: z.object({
        concurrent: opts.Expr.optional(),
        rate: opts.Expr.optional(),
      }).optional(),
    }).meta({ aid: 'Expr_loop' });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    const over = await this.over.evaluate(engine, scope);
    const gs = over.type.get();
    if (!gs?.loop) {
      throw new Error(`loop: type '${over.type.name}' has no loop defined on its GetSet`);
    }

    const keyName = this.keyName ?? 'key';
    const valueName = this.valueName ?? 'value';

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
      await runLoop(gs.loop, scope, engine, over, yieldFn);
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

  typeOf(engine: Engine, _scope: TypeScope): Type {
    return engine.registry.void();
  }

  validateWalk(engine: Engine, scope: TypeScope, p: Problems, ctx: ValidateContext): Type {
    const overT = p.at('over', () => walkValidate(engine, this.over, scope, p, ctx));
    const gs = overT.get();
    if (!gs?.loop) {
      p.error('loop.not-iterable', `type '${overT.name}' has no loop defined`);
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

    // Bind key/value using the iterable's actual types (not any) so the
    // body validates against correct inner types. Fall back to any only
    // when the iterable surface was missing (already errored above).
    const keyType = gs?.key ?? engine.registry.any();
    const valueType = gs?.value ?? engine.registry.any();
    const child: TypeScope = new Map(scope);
    child.set(this.keyName ?? 'key', keyType);
    child.set(this.valueName ?? 'value', valueType);
    p.at('body', () => walkValidate(engine, this.body, child, p, { ...ctx, inLoop: true }));
    return engine.registry.void();
  }

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    const expectsValue = options.expectsValue ?? false;
    const over = this.over.toCode(registry, { expectsValue: true });
    const key = this.keyName ?? 'key';
    const value = this.valueName ?? 'value';

    let prefix = '';
    if (this.parallel?.concurrent) {
      prefix += `/* parallel.concurrent: ${this.parallel.concurrent.toCode(registry, { expectsValue: true })} */ `;
    }
    if (this.parallel?.rate) {
      prefix += `/* parallel.rate: ${this.parallel.rate.toCode(registry, { expectsValue: true })} */ `;
    }

    // Body in statement context — uses bare statements / flow / nested control.
    const bodyStmt = (() => {
      const kind = (this.body as { kind: string }).kind;
      if (kind === 'flow') return `${this.body.toCode(registry, { expectsValue: false })};`;
      if (kind === 'block') {
        const code = this.body.toCode(registry, { expectsValue: false });
        return code.startsWith('{') ? code.slice(1, -1).trim() : code;
      }
      if (kind === 'if' || kind === 'switch' || kind === 'loop') {
        return this.body.toCode(registry, { expectsValue: false });
      }
      return `${this.body.toCode(registry, { expectsValue: false })};`;
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
  const yieldType = engine.registry.fn(engine.registry.obj({}), engine.registry.void());
  const yieldValue = new Value(yieldType, yieldFn);
  const loopScope = scope.child({ this: over, yield: yieldValue });
  try {
    await engine.evaluate(loopExpr, loopScope);
  } catch (sig) {
    if (!(sig instanceof BreakSignal)) throw sig;
  }
}
