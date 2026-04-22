import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, GetSet, type Prop, type Rnd, Type } from '../type';
import type { TextOptions } from '../builder';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';
import { baseTypeFields } from '../schemas';

/**
 * TextType — string primitive with optional length bounds and regex pattern.
 *
 * narrow() enforces:
 *   minLength must not decrease; maxLength must not increase.
 *   A new pattern is accepted only if it's a pure restriction — since
 *   arbitrary regex subset is undecidable, we require either (a) base
 *   has no pattern, or (b) local.pattern === base.pattern + base.flags.
 */
export class TextType extends Type<string, TextOptions> {
  static readonly NAME = 'text';
  readonly name = TextType.NAME;

  private _regex?: RegExp;

  static from(json: TypeDef, registry: Registry): TextType {
    return new TextType(registry, (json.options ?? {}) as TextOptions);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('text'),
      ...baseTypeFields(opts),
      options: z.object({
        minLength: z.number().optional(),
        maxLength: z.number().optional(),
        pattern: z.string().optional(),
        flags: z.string().optional(),
      }).optional(),
    }).meta({ aid: 'Type_text' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny { return z.string(); }

  private regex(): RegExp | undefined {
    if (this._regex) return this._regex;
    if (!this.options.pattern) return undefined;
    this._regex = new RegExp(this.options.pattern, this.options.flags);
    return this._regex;
  }

  valid(raw: unknown): raw is string {
    if (typeof raw !== 'string') return false;
    const { minLength, maxLength } = this.options;
    if (minLength !== undefined && raw.length < minLength) return false;
    if (maxLength !== undefined && raw.length > maxLength) return false;
    const rx = this.regex();
    if (rx && !rx.test(raw)) return false;
    return true;
  }

  parse(json: unknown): Value<string> {
    if (typeof json !== 'string') {
      throw new TypeError({
        path: [], code: 'text.invalid',
        message: `text.parse: expected string, got ${typeof json}`, severity: 'error',
      });
    }
    if (!this.valid(json)) {
      throw new TypeError({
        path: [], code: 'text.constraint',
        message: `text.parse: value violates constraints`, severity: 'error',
      });
    }
    return new Value(this, json);
  }

  encode(raw: string): string {
    return raw;
  }

  create(): string {
    return '';
  }

  random(rnd: Rnd): string {
    const min = this.options.minLength ?? 0;
    const max = this.options.maxLength ?? 16;
    const len = rnd(min, max, true);
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < len; i++) out += chars[rnd(0, chars.length - 1, true)];
    return out;
  }

  compatible(other: Type, opts?: CompatOptions): boolean {
    if (!(other instanceof TextType)) return false;
    if (!opts?.value) return true;
    const a = this.options, b = other.options;
    if (a.minLength !== undefined && (b.minLength === undefined || b.minLength < a.minLength)) return false;
    if (a.maxLength !== undefined && (b.maxLength === undefined || b.maxLength > a.maxLength)) return false;
    if (a.pattern && a.pattern !== b.pattern) return false;
    return true;
  }

  or(other: Type<string>): Type<string> {
    if (!(other instanceof TextType)) return this;
    const a = this.options, b = other.options;
    return new TextType(this.registry, {
      minLength: a.minLength !== undefined && b.minLength !== undefined
        ? Math.min(a.minLength, b.minLength) : undefined,
      maxLength: a.maxLength !== undefined && b.maxLength !== undefined
        ? Math.max(a.maxLength, b.maxLength) : undefined,
      pattern: a.pattern === b.pattern ? a.pattern : undefined,
      flags: a.pattern === b.pattern ? a.flags : undefined,
    });
  }

  narrow(local: Partial<TextOptions>): TextOptions {
    const base = this.options;
    const fail = (code: string, msg: string): never => {
      throw new TypeError({ path: [], code, message: msg, severity: 'error' });
    };
    const merged: TextOptions = { ...base };

    if (local.minLength !== undefined) {
      if (base.minLength !== undefined && local.minLength < base.minLength) {
        fail('text.widen.minLength', `local ${local.minLength} < base ${base.minLength}`);
      }
      merged.minLength = local.minLength;
    }
    if (local.maxLength !== undefined) {
      if (base.maxLength !== undefined && local.maxLength > base.maxLength) {
        fail('text.widen.maxLength', `local ${local.maxLength} > base ${base.maxLength}`);
      }
      merged.maxLength = local.maxLength;
    }
    if (local.pattern !== undefined) {
      if (base.pattern !== undefined && (local.pattern !== base.pattern || local.flags !== base.flags)) {
        fail('text.widen.pattern', 'pattern narrowing is only allowed when base has no pattern or matches exactly');
      }
      merged.pattern = local.pattern;
      merged.flags = local.flags;
    }
    return merged;
  }

  get(): GetSet {
    return new GetSet({
      key: this.registry.num(),
      value: this.registry.text({ minLength: 1, maxLength: 1 }),
      get: { kind: 'native', id: 'text.charAt' },
      loop: { kind: 'native', id: 'text.chars' },
    });
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const text = r.text();
    const num = r.num();
    const bool = r.bool();
    const optNum = r.optional(num);
    return {
      length: r.prop(num, 'text.length'),

      eq:         r.method({ other: text }, bool, 'text.eq'),
      neq:        r.method({ other: text }, bool, 'text.neq'),
      contains:   r.method({ search: text }, bool, 'text.contains'),
      startsWith: r.method({ prefix: text }, bool, 'text.startsWith'),
      endsWith:   r.method({ suffix: text }, bool, 'text.endsWith'),

      trim:      r.method({}, text, 'text.trim'),
      trimStart: r.method({}, text, 'text.trimStart'),
      trimEnd:   r.method({}, text, 'text.trimEnd'),
      upper:     r.method({}, text, 'text.upper'),
      lower:     r.method({}, text, 'text.lower'),

      slice:   r.method({ start: num, end: optNum }, text, 'text.slice'),
      replace: r.method({ search: text, replacement: text }, text, 'text.replace'),
      split:   r.method({ separator: text }, r.list(text), 'text.split'),
      concat:  r.method({ other: text }, text, 'text.concat'),
      repeat:  r.method({ count: num }, text, 'text.repeat'),

      indexOf:     r.method({ search: text, from: optNum }, num, 'text.indexOf'),
      lastIndexOf: r.method({ search: text, from: optNum }, num, 'text.lastIndexOf'),

      match: r.method({ pattern: text }, r.list(text), 'text.match'),
      test:  r.method({ pattern: text }, bool, 'text.test'),

      isEmpty:    r.method({}, bool, 'text.isEmpty'),
      isNotEmpty: r.method({}, bool, 'text.isNotEmpty'),

      toNumber:  r.method({}, num, 'text.toNumber'),
      toBoolean: r.method({}, bool, 'text.toBoolean'),
    };
  }

  toJSON(): TypeDef {
    return {
      name: TextType.NAME,
      options: Object.keys(this.options).length > 0 ? { ...this.options } : undefined,
    };
  }

  clone(): TextType {
    return new TextType(this.registry, { ...this.options });
  }

  toCode(): string { return 'string'; }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    let s = z.string();
    if (this.options.minLength !== undefined) s = s.min(this.options.minLength);
    if (this.options.maxLength !== undefined) s = s.max(this.options.maxLength);
    if (this.options.pattern) s = s.regex(new RegExp(this.options.pattern, this.options.flags));
    return this.describeType(s, opts);
  }

  describe(data: unknown): Type | undefined {
    return typeof data === 'string' ? this : undefined;
  }
}
