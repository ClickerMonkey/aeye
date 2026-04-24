import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, Init, type Prop, type Rnd, Type, optionsCode } from '../type';
import type { ColorOptions } from '../builder';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';


/**
 * ColorType — RGBA color stored as a 32-bit integer (0xRRGGBBAA).
 * Serialized as the integer; formatting helpers come via toHex/toRgb/toHsl
 * native methods.
 */
export class ColorType extends Type<number, ColorOptions> {
  static readonly NAME = 'color';
  readonly name = ColorType.NAME;

  static from(json: TypeDef, registry: Registry): ColorType {
    return new ColorType(registry, (json.options ?? {}) as ColorOptions);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('color'),
      options: z.object({ hasAlpha: z.boolean().optional() }).optional(),
    }).meta({ aid: 'Type_color' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny {
    return z.number().int().min(0).max(0xffffffff);
  }

  valid(raw: unknown): raw is number {
    return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 0xffffffff;
  }

  parse(json: unknown): Value<number> {
    const n = typeof json === 'number' ? json : Number(json);
    if (!this.valid(n)) {
      throw new TypeError({
        path: [], code: 'color.invalid',
        message: `color.parse: not a valid 32-bit color int: ${String(json)}`, severity: 'error',
      });
    }
    return new Value(this, n);
  }

  encode(raw: number): number {
    return raw;
  }

  create(): number {
    return 0x000000ff; // opaque black
  }

  random(rnd: Rnd): number {
    return rnd(0, 0xffffffff, true);
  }

  compatible(other: Type, _opts?: CompatOptions): boolean {
    return other instanceof ColorType;
  }

  or(other: Type<number>): Type<number> {
    if (!(other instanceof ColorType)) return this;
    return new ColorType(this.registry, {
      hasAlpha: this.options.hasAlpha === other.options.hasAlpha
        ? this.options.hasAlpha
        : undefined,
    });
  }

  narrow(local: Partial<ColorOptions>): ColorOptions {
    return { ...this.options, ...local };
  }

  init(): Init {
    const r = this.registry;
    const byte = r.num({ whole: true, min: 0, max: 255 });
    const alpha = r.optional(r.num({ min: 0, max: 1 }));
    return new Init({
      args: r.obj({ r: { type: byte }, g: { type: byte }, b: { type: byte }, a: { type: alpha } }) as Type<any>,
      run: { kind: 'native', id: 'color.init' },
    });
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const num = r.num(), bool = r.bool(), text = r.text(), color = r.color();
    return {
      ...super.props(),
      r: r.prop(num, 'color.r'),
      g: r.prop(num, 'color.g'),
      b: r.prop(num, 'color.b'),
      a: r.prop(num, 'color.a'),

      hue:        r.prop(num, 'color.hue'),
      saturation: r.prop(num, 'color.saturation'),
      lightness:  r.prop(num, 'color.lightness'),

      eq:  r.method({ other: color }, bool, 'color.eq'),
      neq: r.method({ other: color }, bool, 'color.neq'),

      lighten:    r.method({ amount: num }, color, 'color.lighten'),
      darken:     r.method({ amount: num }, color, 'color.darken'),
      saturate:   r.method({ amount: num }, color, 'color.saturate'),
      desaturate: r.method({ amount: num }, color, 'color.desaturate'),
      opacity:    r.method({ alpha: num },  color, 'color.opacity'),
      invert:     r.method({},              color, 'color.invert'),
      mix:        r.method({ other: color, weight: r.optional(num) }, color, 'color.mix'),
      complement: r.method({}, color, 'color.complement'),

      toHex:  r.method({}, text, 'color.toHex'),
      toRgb:  r.method({}, text, 'color.toRgb'),
      toHsl:  r.method({}, text, 'color.toHsl'),
      toText: r.method({}, text, 'color.toText'),
    };
  }

  toJSON(): TypeDef {
    return {
      name: ColorType.NAME,
      options: Object.keys(this.options).length > 0 ? { ...this.options } : undefined,
    };
  }

  clone(): ColorType {
    return new ColorType(this.registry, { ...this.options });
  }

  toCode(): string { return this.docsPrefix() + 'color' + optionsCode(this.options); }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    // Dump form is a 32-bit integer (0xRRGGBBAA or 0xRRGGBB depending on hasAlpha).
    return this.describeType(z.number().int().min(0).max(0xffffffff), opts);
  }
}
