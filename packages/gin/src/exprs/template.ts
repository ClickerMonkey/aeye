import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { TemplateExprDef, NewExprDef, ExprDef } from '../schema';
import { Value, val } from '../value';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { TypeScope } from '../analysis';
import { walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { NewExpr } from './new';
import { z } from 'zod';
import { baseExprFields } from '../schemas';

/**
 * TemplateExpr — string interpolation.
 */
export class TemplateExpr extends Expr {
  static readonly KIND = 'template';
  readonly kind = TemplateExpr.KIND;

  constructor(readonly template: Expr, readonly params: Expr) {
    super();
  }

  static from(json: TemplateExprDef, registry: Registry): TemplateExpr {
    // template is declared `string` in schema but historically evaluated as ExprDef.
    const t = json.template as unknown;
    const templateExpr =
      t && typeof t === 'object' && 'kind' in (t as ExprDef)
        ? registry.parseExpr(t as ExprDef)
        : registry.parseExpr({
            kind: 'new',
            type: { name: 'text' },
            value: String(t),
          } as NewExprDef);
    return new TemplateExpr(templateExpr, registry.parseExpr(json.params))
      .withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('template'),
      ...baseExprFields,
      template: z.union([opts.Expr, z.string()]),
      params: opts.Expr,
    });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    const tmplValue = await this.template.evaluate(engine, scope);
    const paramsValue = await this.params.evaluate(engine, scope);
    const tmpl = String(tmplValue.raw);
    const params = paramsValue.raw as Record<string, Value | unknown>;

    const out = tmpl.replace(/\{(\w+)\}/g, (_, name) => {
      const field = params?.[name];
      if (field === undefined || field === null) return '';
      if (field instanceof Value) return String((field as Value).raw ?? '');
      return String(field);
    });
    return val(engine.registry.text(), out);
  }

  typeOf(_engine: Engine, _scope: TypeScope): Type {
    return _engine.registry.text();
  }

  validateWalk(engine: Engine, scope: TypeScope, p: Problems, ctx: ValidateContext): Type {
    const text = engine.registry.text();
    const tmplT = p.at('template', () => walkValidate(engine, this.template, scope, p, ctx));
    if (!text.compatible(tmplT)) {
      p.at('template', () => p.warn('template.template.type',
        `template should resolve to text, got '${tmplT.name}'`));
    }

    const paramsT = p.at('params', () => walkValidate(engine, this.params, scope, p, ctx));
    // params must be an object-shaped type so that `{name}` placeholders
    // can be looked up.
    if (paramsT.name !== 'object' && paramsT.name !== 'any') {
      p.at('params', () => p.warn('template.params.type',
        `template params should be an object, got '${paramsT.name}'`));
    }
    return engine.registry.text();
  }

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    const raw = this.template instanceof NewExpr && typeof this.template.value === 'string'
      ? (this.template.value as string)
      : undefined;
    const prefix = this.commentPrefix(options);
    if (raw === undefined) {
      return prefix + `template(${registry!.toCode(this.template)}, ${registry!.toCode(this.params)})`;
    }
    const inline = tryInlineTemplateParams(this.params, registry!);
    const converted = raw.replace(/\{(\w+)\}/g, (_, name) =>
      inline && name in inline ? '${' + inline[name]! + '}' : '${params.' + name + '}'
    );
    return prefix + `\`${converted.replace(/`/g, '\\`')}\``;
  }

  toJSON(): TemplateExprDef {
    return this.withCommentOn({
      kind: 'template',
      template: this.template.toJSON() as unknown as string,
      params: this.params.toJSON(),
    });
  }

  clone(): TemplateExpr {
    return new TemplateExpr(this.template.clone(), this.params.clone()).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    visit(this.template, 'inherit');
    visit(this.params, 'inherit');
  }
}

function tryInlineTemplateParams(params: Expr, _registry: Registry): Record<string, string> | undefined {
  if (!(params instanceof NewExpr)) return undefined;
  const value = params.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = JSON.stringify(v);
    else out[k] = String(v);
  }
  return out;
}
