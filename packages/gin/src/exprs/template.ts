import type { Engine } from '../engine';
import type { Scope } from '../scope';
import type { TemplateExprDef, NewExprDef, ExprDef } from '../schema';
import { Value, val } from '../value';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { Locals } from '../analysis';
import { walkValidate } from '../analysis';
import type { Problems } from '../problem';
import { Expr, type ValidateContext, type ChildVisitor } from '../expr';
import type { CodeOptions, SchemaOptions } from '../node';
import { NewExpr } from './new';
import { z } from 'zod';
import type { TypeScope } from '../type-scope';

/**
 * TemplateExpr — string interpolation.
 */
export class TemplateExpr extends Expr {
  static readonly KIND = 'template';
  readonly kind = TemplateExpr.KIND;

  constructor(readonly template: Expr, readonly params?: Expr) {
    super();
  }

  static from(json: TemplateExprDef, scope: TypeScope): TemplateExpr {
    const r = scope.registry;
    // template is declared `string` in schema but historically evaluated as ExprDef.
    const t = json.template as unknown;
    const templateExpr =
      t && typeof t === 'object' && 'kind' in (t as ExprDef)
        ? r.parseExpr(t as ExprDef, scope)
        : r.parseExpr({
            kind: 'new',
            type: { name: 'text' },
            value: String(t),
          } as NewExprDef, scope);
    const paramsExpr = json.params ? r.parseExpr(json.params, scope) : undefined;
    return new TemplateExpr(templateExpr, paramsExpr).withComment(json.comment);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('template'),
      template: z.union([opts.Expr, z.string()]).describe(
        'The template string — either a literal string (auto-wrapped as `new text`) or an Expr that evaluates to text. Placeholders use `{name}` syntax; each `name` is looked up first in `params` (when supplied) and then in the surrounding scope.',
      ),
      params: opts.Expr.optional().describe(
        'Optional obj-typed expression supplying placeholder values. When omitted or when a key is missing, `{name}` falls back to a scope lookup of the same name — so a `${baseUrl}` placeholder resolves to a surrounding `define baseUrl = ...`. Provide `params` only when placeholders need values not already in scope (or to override scope values).',
      ),
    }).meta({ aid: 'Expr_template' });
  }

  async evaluate(engine: Engine, scope: Scope): Promise<Value> {
    const tmplValue = await this.template.evaluate(engine, scope);
    const tmpl = String(tmplValue.raw);

    // Evaluate `params` (if any) once up front — its fields take
    // precedence over scope lookups. Missing keys (or no params at
    // all) fall back to `scope.get(name)` so `${foo}` references the
    // same `foo` a sibling `get` would.
    let params: Record<string, Value | unknown> | undefined;
    if (this.params) {
      const paramsValue = await this.params.evaluate(engine, scope);
      params = paramsValue.raw as Record<string, Value | unknown>;
    }

    const out = tmpl.replace(/\{(\w+)\}/g, (_, name) => {
      if (params && Object.prototype.hasOwnProperty.call(params, name)) {
        const field = params[name];
        if (field === undefined || field === null) return '';
        if (field instanceof Value) return String(field.raw ?? '');
        return String(field);
      }
      const fromScope = scope.get(name);
      if (fromScope === undefined) return '';
      if (fromScope instanceof Value) return String(fromScope.raw ?? '');
      return String(fromScope);
    });
    return val(engine.registry.text(), out);
  }

  typeOf(_engine: Engine, _scope: Locals): Type {
    return _engine.registry.text();
  }

  validateWalk(engine: Engine, scope: Locals, p: Problems, ctx: ValidateContext): Type {
    const text = engine.registry.text();
    const tmplT = p.at('template', () => walkValidate(engine, this.template, scope, p, ctx));
    if (!text.compatible(tmplT)) {
      p.at('template', () => p.warn('template.template.type',
        `template should resolve to text, got '${tmplT.name}'`));
    }

    // Resolve the params type (when supplied) so we can use its
    // structural prop list to decide which placeholders it actually
    // exposes — not just the ones inlined in a `new obj` literal.
    // `args.config` (a `get` of a typed obj) participates here too.
    let paramsKeys: Set<string> | undefined;
    let paramsTypeUnknown = false;
    if (this.params) {
      const paramsT = p.at('params', () => walkValidate(engine, this.params!, scope, p, ctx));
      if (paramsT.name === 'any') {
        // `any` could carry any keys at runtime — defer the check.
        paramsTypeUnknown = true;
      } else if (paramsT.name === 'obj' || paramsT.name === 'iface') {
        // Use the structural fields' names. Methods declared on the
        // type via `props()` would muddy the check — `obj.fields`
        // is the data-slot list. For obj this is `(t as ObjType).
        // fields`; iface uses `_props`. Both are exposed via
        // `props()` filtered to non-callable types.
        const allProps = paramsT.props();
        const dataKeys = Object.entries(allProps)
          .filter(([, prop]) => !(prop as { type: Type }).type.call())
          .map(([k]) => k);
        paramsKeys = new Set(dataKeys);
      } else {
        // Not obj/iface/any — params can't supply placeholders even
        // if the type happens to have method-typed props. Flag and
        // skip the per-name check (already an error).
        p.at('params', () => p.warn('template.params.type',
          `template params should be an object, got '${paramsT.name}'`));
        paramsTypeUnknown = true;
      }
    }

    // Walk the template literal for placeholder names and ERROR on
    // any that won't resolve at runtime — neither in the params
    // type's props (when params is supplied with a knowable shape)
    // nor in the surrounding scope. Unresolved placeholders silently
    // become empty strings at runtime, which is almost always a bug
    // (the user's exchange showed the model debugging
    // `Failed to parse URL from ?access_key=` because both
    // placeholders quietly resolved to ''), so we promote it from
    // warn → error to force a fix before `test()`.
    const literalTpl = this.template instanceof NewExpr && typeof this.template.value === 'string'
      ? this.template.value as string
      : undefined;
    if (literalTpl !== undefined) {
      const seen = new Set<string>();
      const re = /\{(\w+)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(literalTpl)) !== null) {
        const name = m[1]!;
        if (seen.has(name)) continue;
        seen.add(name);
        const inParams = paramsKeys?.has(name) ?? false;
        const inScope = scope.has(name);
        // When the params type is an opaque `any` (or the params
        // type isn't object-shaped — already flagged above), we
        // can't statically check key membership; fall back to scope
        // alone. Otherwise the placeholder must be in EITHER the
        // params keys OR scope.
        if (paramsTypeUnknown) {
          if (!inScope) {
            p.error('template.placeholder.unresolved',
              `placeholder '{${name}}' isn't a scope variable; either define '${name}' in scope or pass a typed obj as \`params\` so it can be checked`);
          }
        } else if (!inParams && !inScope) {
          p.error('template.placeholder.unresolved',
            this.params
              ? `placeholder '{${name}}' is not a key of \`params\` (keys: [${[...(paramsKeys ?? [])].join(', ') || 'none'}]) and not a scope variable`
              : `placeholder '{${name}}' does not match any scope variable; either \`define ${name} = ...\` first or pass it via \`params\``);
        }
      }
    }
    return engine.registry.text();
  }

  toCode(registry?: Registry, options: CodeOptions = {}): string {
    const prefix = this.commentPrefix(options);
    const raw = this.template instanceof NewExpr && typeof this.template.value === 'string'
      ? (this.template.value as string)
      : undefined;

    if (raw === undefined) {
      // Non-literal template — fall back to the explicit form. The
      // params slot is rendered (or omitted) so the reader sees the
      // full picture.
      const tplCode = registry!.toCode(this.template, { ...options, expectsValue: true });
      if (this.params) {
        const paramsCode = registry!.toCode(this.params, { ...options, expectsValue: true });
        return `${prefix}template(${tplCode}, ${paramsCode})`;
      }
      return `${prefix}template(${tplCode})`;
    }

    // Literal template string. For each `{name}` placeholder:
    //   - If `params` is a `new obj` literal AND has a key matching
    //     the placeholder, render that field's Expr inline as
    //     `${<that code>}`. Long renders (>64 chars) get a multi-
    //     line `${\n  <code>\n}` form so the template doesn't sprawl
    //     across the page.
    //   - Otherwise emit a bare `${name}` — at runtime that resolves
    //     via the surrounding scope (the standard fallback behaviour
    //     in `evaluate`).
    //
    // No `with(<params>)` clause is emitted: every literal-inlinable
    // value is already substituted directly into the template string,
    // and bare names speak for themselves. When `params` ISN'T a
    // literal (e.g. `args.config` — an obj fetched from elsewhere),
    // we can't inline its field exprs at toCode time; the bare
    // `${name}` form still reads naturally and the runtime falls
    // through to scope.
    const inline = this.params ? tryInlineTemplateParams(this.params, registry!) : undefined;
    const WRAP_THRESHOLD = 64;
    const converted = raw.replace(/\{(\w+)\}/g, (_, name) => {
      if (inline && Object.prototype.hasOwnProperty.call(inline, name)) {
        const code = inline[name]!;
        return code.length > WRAP_THRESHOLD
          ? '${\n  ' + code + '\n}'
          : '${' + code + '}';
      }
      return '${' + name + '}';
    });

    const literal = `\`${converted.replace(/`/g, '\\`')}\``;
    return `${prefix}${literal}`;
  }

  toJSON(): TemplateExprDef {
    return this.withCommentOn({
      kind: 'template',
      template: this.template.toJSON() as unknown as string,
      ...(this.params ? { params: this.params.toJSON() } : {}),
    });
  }

  clone(): TemplateExpr {
    return new TemplateExpr(this.template.clone(), this.params?.clone()).withComment(this.comment);
  }

  forEachChild(visit: ChildVisitor): void {
    visit(this.template, 'inherit');
    if (this.params) visit(this.params, 'inherit');
  }
}

function tryInlineTemplateParams(params: Expr, registry: Registry): Record<string, string> | undefined {
  if (!(params instanceof NewExpr)) return undefined;
  const value = params.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = JSON.stringify(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    else if (v === null) out[k] = 'null';
    else if (v && typeof v === 'object' && 'kind' in (v as Record<string, unknown>)
             && typeof (v as { kind: unknown }).kind === 'string'
             && registry.exprClass((v as { kind: string }).kind)) {
      // ExprDef-shaped: render via the parsed Expr's toCode so a `get`
      // path appears as `args.text` instead of `[object Object]`.
      try {
        out[k] = registry.parseExpr(v as ExprDef).toCode(registry, { expectsValue: true });
      } catch { return undefined; }
    } else {
      // Unknown shape — bail out of inlining so the caller falls back
      // to the safe `template(<expr>, <expr>)` form.
      return undefined;
    }
  }
  return out;
}
