/**
 * `@aeye/query/conformance` — the harness a CONSUMER runs against its own
 * declaration.
 *
 * Two things have to be true for that export to be worth anything, and this file
 * is about both:
 *
 *  1. **It finds real defects.** A harness that reports `ok` for everything is
 *     worse than none, because it is a claim nobody re-checks. Every law here is
 *     shown to FAIL on a set that genuinely breaks it — a positive control per
 *     law, built by hand, because the shipped types deliberately break none of
 *     them.
 *  2. **It is the same code the builtins are held to.** `param-meet.test.ts`
 *     runs `checkLatticeLaws` over the widest type set in this package, so the
 *     harness is exercised against a correct implementation on every run, and a
 *     regression in it fails there before a consumer ever sees it.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_SAMPLES,
  checkFieldType,
  checkLatticeLaws,
  topsByKind,
} from '../conformance';
import { FieldType } from '../field-type';
import { NumberFieldType, TextFieldType } from '../field-types/index';
import { createRegistry } from '../registry';
import type { FieldTypeRefinementDef } from '../refinement';
import type { FieldTypeDef, JsonValue } from '../schema';
import type { ValueSchemaOptions } from '../node';
import type { ScalarKind } from '../field-type';

// ─── The worked declaration ──────────────────────────────────────────────────

const geometryDecl: FieldTypeRefinementDef = {
  name: 'Geometry',
  base: 'json',
  instructions: 'A PostGIS geometry as GeoJSON. Compare with ST_Contains; order by ST_Distance.',
  ownOptions: {
    subtype: { type: { kind: 'text', values: [{ value: 'Point' }, { value: 'Polygon' }] }, default: 'Point' },
    srid: { type: { kind: 'number', whole: true }, default: 4326 },
  },
  sql: { postgres: 'geometry({subtype},{srid})' },
  compare: { equality: true, ordering: false, textMatch: false },
  avgBytes: 96,
};

/** A GeoJSON-ish gate: an object with a `type` this package knows nothing about. */
const geoJson = z.object({ type: z.enum(['Point', 'Polygon']) });

/** A well-formed value of the type, for the corpus — nothing in the library can guess one. */
const A_POINT: JsonValue = { type: 'Point' };

describe('checkFieldType — one declaration, held to the builtins’ own properties', () => {
  it('PASSES a sound declaration, and proves every law over a set it built itself', () => {
    const report = checkFieldType(geometryDecl, { value: geoJson, samples: [A_POINT] });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    // The laws really ran — an `ok` from an empty law list would be vacuous.
    expect(report.lattice!.laws.map((l) => l.law).sort()).toEqual([
      'associative', 'commutative', 'idempotent', 'meet-implies-comparable',
      'refinement-base', 'refinement-instance', 'round-trip', 'sound', 'top-identity', 'total',
    ]);
    expect(report.lattice!.ok).toBe(true);
  });

  it('works with NO impl at all — the declaration alone is the common case', () => {
    expect(checkFieldType({
      name: 'uuid', base: 'text',
      instructions: 'A UUID (RFC 4122).',
      options: { minLength: 36, maxLength: 36, casing: 'exact' },
      sql: { postgres: 'uuid' },
      avgBytes: 16,
    }).problems).toEqual([]);
  });

  it('reports a REGISTRATION defect as the registry’s own problem, verbatim', () => {
    // Not re-worded: the registration check already produces the message a
    // declarer needs, and a harness that paraphrased it would drift from it.
    const report = checkFieldType({ name: 'Geometry', base: 'json', instructions: '' });
    expect(report.ok).toBe(false);
    expect(report.problems[0]!.code).toBe('field-type.bad-refinement');
    expect(report.problems[0]!.message).toContain('`instructions` is required');
    // Nothing was provable, so no lattice verdict is invented.
    expect(report.lattice).toBeUndefined();
  });

  it('reports a gate that ACCEPTS what the declared base refuses', () => {
    // The cross-library check (`shared-types` D5): the gate is CODE, so it never
    // rides the wire and nothing downstream can check it. A gate admitting a
    // value the base bucket cannot hold means the declared bucket and the
    // declared contract describe two different types — and the bucket is what
    // decides the SQL type, the comparability and the cost.
    const report = checkFieldType(
      { name: 'Digits', base: 'number', instructions: 'A number.' },
      { value: z.union([z.number(), z.string()]) },
    );
    const problem = report.problems.find((p) => p.code === 'conformance.gate-disagrees-with-base');
    expect(problem).toBeDefined();
    expect(problem!.severity).toBe('error');
    expect(problem!.message).toContain('a bare `number` refuses');
  });

  it('WARNS about a gate that refuses nothing at all', () => {
    // `z.any()` is what an unresolved schema degrades to, and it degrades
    // SILENTLY. A gate that accepts every sample is that gate whether or not
    // anyone meant it to be.
    const report = checkFieldType(
      { name: 'Anything', base: 'json', instructions: 'A document.' },
      { value: z.any() },
    );
    const problem = report.problems.find((p) => p.code === 'conformance.gate-vacuous');
    expect(problem!.severity).toBe('warning');
    expect(problem!.message).toContain('refuses nothing');
  });

  it('takes the caller’s SAMPLES — the default corpus cannot guess a real value', () => {
    // Without a real `Point` in the corpus, `geoJson` refuses everything, which
    // is indistinguishable from a gate that is wrong in the other direction.
    // Supplying one is what makes both checks mean something.
    const withValue = checkFieldType(geometryDecl, { value: geoJson, samples: [A_POINT] });
    expect(withValue.problems).toEqual([]);
    expect(DEFAULT_SAMPLES.some((v) => geoJson.safeParse(v).success)).toBe(false);
  });

  it('REPORTS a value gate that THROWS on a sample, rather than crashing', () => {
    // The measured regression this check exists for, and it is the shape the
    // module's own docs recommend: `FieldTypeDef` has no record branch, so a
    // struct-valued refinement's contract lives in `impl.value` — and the
    // obvious gate for one parses its input. `DEFAULT_SAMPLES` opens with `'a'`,
    // so the FIRST thing a geometry declarer did threw `SyntaxError: Unexpected
    // token 'a'` straight out of `checkFieldType`. The first pass guarded schema
    // CONSTRUCTION and not schema USE.
    const parsing = z.string().refine((raw) => {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && 'type' in parsed;
    });
    const report = checkFieldType({ name: 'Geo', base: 'text', instructions: 'A geometry as text.' }, { value: parsing });
    const problem = report.problems.find((p) => p.code === 'conformance.gate-throws');
    expect(problem).toBeDefined();
    expect(problem!.message).toContain('THREW on a sample rather than refusing it');
    // …and the run CONTINUED rather than stopping at the throw. Asserted on what
    // the laws SAID, not on `laws.length` — that is populated unconditionally
    // (even `checkLatticeLaws({})` returns all nine), so a length assertion
    // could not fail and proved nothing.
    //
    // Every LATTICE law is clean: the meet is fine, it is the gate that is not.
    for (const law of ['commutative', 'associative', 'idempotent', 'top-identity', 'sound', 'round-trip']) {
      expect(report.lattice!.laws.find((l) => l.law === law)!.violations, law).toEqual([]);
    }
    // `total` names the STAGE, so the report says WHERE it threw and not only
    // that something did — and it is reported twice on purpose, once as a
    // property of the run and once as `gate-throws`, the declaration-level fact.
    const total = report.lattice!.laws.find((l) => l.law === 'total')!;
    expect(total.violations.every((v) => v.startsWith('ZodType.safeParse(sample)'))).toBe(true);
  });

  it('REPORTS a non-array `samples` rather than throwing at the spread', () => {
    const report = checkFieldType(
      { name: 'Geo', base: 'text', instructions: 'A geometry as text.' },
      { samples: 'not an array' } as unknown as { samples?: readonly JsonValue[] },
    );
    expect(report.problems.map((p) => p.code)).toContain('conformance.bad-samples');
  });

  it('builds a column per value of each declared option — the arm the flat lattice must get right', () => {
    // Visible through the round-trip law having something to round-trip: the
    // set holds `Geometry` unset, one column per `subtype` member, one per
    // `srid` (its default, since a whole number is not enumerable), the peer,
    // and every unrefined top.
    const report = checkFieldType(geometryDecl);
    expect(report.lattice!.laws.find((l) => l.law === 'round-trip')!.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

// ─── The positive controls: each law, shown to fail ──────────────────────────

describe('checkLatticeLaws finds a law that is actually broken', () => {
  /**
   * A field type whose meet is deliberately WRONG, in one named way.
   *
   * Built by subclassing rather than by declaring, because a DECLARATION cannot
   * break these laws — the library computes the meet from it, which is the whole
   * safety argument for the mechanism. The only way to produce a counterexample
   * is to reach past the declaration road, and that is exactly what a consumer
   * doing something exotic with `defineFieldType` would be doing.
   */
  class BrokenFieldType extends FieldType {
    readonly kind = 'text' as const;
    constructor(
      private readonly label: string,
      private readonly how: 'asymmetric' | 'unsound' | 'narrows-top',
    ) {
      super();
    }
    resolve(): ScalarKind {
      return 'text';
    }
    toSQLType(): string {
      return 'text';
    }
    protected builtinJSON(): FieldTypeDef {
      return { kind: 'text', pattern: this.label };
    }
    protected builtinClone(): FieldType {
      return new BrokenFieldType(this.label, this.how);
    }
    protected builtinValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
      // `unsound` admits nothing on its own, so any meet that admits something
      // is a value neither operand accepts.
      return this.how === 'unsound' ? z.never() : z.string();
    }
    protected builtinAvgBytes(): number {
      return 4;
    }
    protected override meetWith(other: FieldType): FieldType | undefined {
      switch (this.how) {
        // "the LEFT one wins" — the order-dependence the whole mechanism exists
        // to remove, and the tempting default this package deliberately refuses.
        case 'asymmetric':
          return this;
        // Answers with a plain `text`, which admits strings neither operand does.
        case 'unsound':
          return new TextFieldType();
        // Narrows against the unconstrained type of its own kind.
        case 'narrows-top':
          return other instanceof TextFieldType ? new TextFieldType({ minLength: 99 }) : undefined;
      }
    }
  }

  const failed = (types: Record<string, FieldType>): string[] =>
    checkLatticeLaws(types, { tops: topsByKind() }).failed.map((l) => l.law);

  it('catches a meet that picks the LEFT operand', () => {
    const laws = failed({
      a: new BrokenFieldType('a', 'asymmetric'),
      b: new BrokenFieldType('b', 'asymmetric'),
      text: new TextFieldType(),
    });
    expect(laws).toContain('commutative');
  });

  it('catches a meet that admits a value neither operand does', () => {
    const laws = failed({
      a: new BrokenFieldType('a', 'unsound'),
      b: new BrokenFieldType('b', 'unsound'),
    });
    expect(laws).toContain('sound');
  });

  it('catches a meet that narrows against its own TOP', () => {
    const laws = failed({
      a: new BrokenFieldType('a', 'narrows-top'),
      text: new TextFieldType(),
    });
    expect(laws).toContain('top-identity');
  });

  it('catches a def the producing registry cannot re-parse — and REPORTS rather than throws', () => {
    // Two facts in one type, and the second is about the harness itself. A
    // `pattern` that is not a compilable regex is refused at parse since
    // `0.6.6`, so a hand-built type carrying one produces a def its own registry
    // throws on — AND its `toValueSchema()` throws a raw `SyntaxError` out of
    // zod's internals. A harness is handed types that may be wrong; one that
    // propagates the second failure never reports the first.
    const registry = createRegistry();
    const report = checkLatticeLaws({ bad: new TextFieldType({ pattern: '([' }) }, { registry });
    const laws = report.failed.map((l) => l.law);
    expect(laws).toContain('round-trip');
    expect(laws).toContain('total');
    expect(report.failed.find((l) => l.law === 'round-trip')!.violations[0]).toContain('does not re-parse');
    expect(report.failed.find((l) => l.law === 'total')!.violations[0]).toContain('Invalid regular expression');
  });

  it('catches a subclass whose members THROW — from every law, not just the guarded ones', () => {
    // `toJSON`, `clone`, `comparableWith` and `meetWith` are all members a
    // subclass supplies, and the first pass guarded only the meet. `toJSON` in
    // particular sat OUTSIDE the round-trip law's own try, so a throwing one took
    // the whole run rather than being reported.
    class Exploding extends FieldType {
      readonly kind = 'text' as const;
      constructor(private readonly where: 'toJSON' | 'clone' | 'comparableWith') {
        super();
      }
      resolve(): ScalarKind {
        return 'text';
      }
      toSQLType(): string {
        return 'text';
      }
      protected builtinJSON(): FieldTypeDef {
        if (this.where === 'toJSON') throw new Error('toJSON blew up');
        return { kind: 'text' };
      }
      protected builtinClone(): FieldType {
        if (this.where === 'clone') throw new Error('clone blew up');
        return new Exploding(this.where);
      }
      protected override builtinComparableWith(): boolean {
        if (this.where === 'comparableWith') throw new Error('comparableWith blew up');
        return true;
      }
      protected builtinValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
        return z.string();
      }
      protected builtinAvgBytes(): number {
        return 4;
      }
    }
    for (const where of ['toJSON', 'clone', 'comparableWith'] as const) {
      const report = checkLatticeLaws({ boom: new Exploding(where), text: new TextFieldType() });
      const total = report.failed.find((l) => l.law === 'total');
      expect(total, `no \`total\` violation for a throwing ${where}`).toBeDefined();
      expect(total!.violations.join(' ')).toContain(`${where} blew up`);
    }
  });

  it('REPORTS a `toJSON` that RETURNS something unserializable, not only one that throws', () => {
    // The guard went on the CALL and the serialization sat outside it. A
    // subclass may return a def that `JSON.stringify` refuses — a cyclic
    // structure, or one carrying a BigInt — and both throw from the SERIALIZER,
    // so both escaped a wrapper that only covered `toJSON()` itself.
    class BadJson extends FieldType {
      readonly kind = 'text' as const;
      constructor(private readonly how: 'cyclic' | 'bigint') {
        super();
      }
      resolve(): ScalarKind {
        return 'text';
      }
      toSQLType(): string {
        return 'text';
      }
      protected builtinJSON(): FieldTypeDef {
        if (this.how === 'bigint') {
          return { kind: 'text', pattern: 1n } as unknown as FieldTypeDef;
        }
        const cyclic: Record<string, unknown> = { kind: 'text' };
        cyclic['self'] = cyclic;
        return cyclic as unknown as FieldTypeDef;
      }
      protected builtinClone(): FieldType {
        return new BadJson(this.how);
      }
      protected builtinValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
        return z.string();
      }
      protected builtinAvgBytes(): number {
        return 1;
      }
    }
    for (const how of ['cyclic', 'bigint'] as const) {
      const report = checkLatticeLaws({ bad: new BadJson(how), text: new TextFieldType() });
      const total = report.failed.find((l) => l.law === 'total');
      expect(total, `no \`total\` violation for a ${how} def`).toBeDefined();
      expect(total!.violations.join(' ')).toContain('JSON.stringify(FieldType.toJSON())');
    }
  });

  it('REPORTS a throwing `refinement` or `kind` ACCESSOR', () => {
    // Both are getters on the base class that a subclass can shadow, and both
    // were read bare — `tops[at(x).kind]` in the top-identity law and
    // `m?.refinement` in the two tag laws.
    class BadAccessor extends FieldType {
      constructor(private readonly which: 'kind' | 'refinement') {
        super();
      }
      override get kind(): 'text' {
        if (this.which === 'kind') throw new Error('kind blew up');
        return 'text';
      }
      override get refinement(): undefined {
        if (this.which === 'refinement') throw new Error('refinement blew up');
        return undefined;
      }
      resolve(): ScalarKind {
        return 'text';
      }
      toSQLType(): string {
        return 'text';
      }
      protected builtinJSON(): FieldTypeDef {
        return { kind: 'text' };
      }
      protected builtinClone(): FieldType {
        return new BadAccessor(this.which);
      }
      protected builtinValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
        return z.string();
      }
      protected builtinAvgBytes(): number {
        return 1;
      }
    }
    for (const which of ['kind', 'refinement'] as const) {
      const report = checkLatticeLaws({ bad: new BadAccessor(which), text: new TextFieldType() });
      const total = report.failed.find((l) => l.law === 'total');
      expect(total, `no \`total\` violation for a throwing ${which}`).toBeDefined();
      expect(total!.violations.join(' ')).toContain(`${which} blew up`);
    }
  });

  it('DEDUPES what it reports — one broken method throws once per pair', () => {
    class AlwaysThrows extends FieldType {
      readonly kind = 'text' as const;
      resolve(): ScalarKind {
        return 'text';
      }
      toSQLType(): string {
        return 'text';
      }
      protected builtinJSON(): FieldTypeDef {
        throw new Error('nope');
      }
      protected builtinClone(): FieldType {
        return new AlwaysThrows();
      }
      protected builtinValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
        return z.string();
      }
      protected builtinAvgBytes(): number {
        return 1;
      }
    }
    const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`t${i}`, new AlwaysThrows()]));
    const total = checkLatticeLaws(many).failed.find((l) => l.law === 'total');
    // 64 pairs, one `toJSON` that always throws, ONE reported line per STAGE.
    // Deduping the whole LINE would collapse nothing (the labels differ every
    // time), so a 50-type set would report one defect 2,500 times.
    expect(total!.violations.filter((v) => v.startsWith('FieldType.toJSON()'))).toHaveLength(1);
    expect(total!.violations.every((v) => v.includes('nope'))).toBe(true);
    // …and the kept line still POINTS somewhere: the stage, plus the first site.
    expect(total!.violations[0]).toMatch(/^FieldType\.\w+\(\)( at .+)?: nope$/);
  });

  it('…but does NOT collapse two different STAGES that share a message', () => {
    // The over-collapse the message-only key caused: two types failing at two
    // different stages with the same message became ONE line, labelled with a
    // meet-pair naming neither of them. The stage is part of the key now.
    class ThrowsIn extends FieldType {
      readonly kind = 'text' as const;
      constructor(private readonly stage: 'toJSON' | 'valueSchema') {
        super();
      }
      resolve(): ScalarKind {
        return 'text';
      }
      toSQLType(): string {
        return 'text';
      }
      protected builtinJSON(): FieldTypeDef {
        if (this.stage === 'toJSON') throw new Error('same message');
        return { kind: 'text', pattern: 'b' };
      }
      protected builtinClone(): FieldType {
        return new ThrowsIn(this.stage);
      }
      protected builtinValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
        if (this.stage === 'valueSchema') throw new Error('same message');
        return z.string();
      }
      protected builtinAvgBytes(): number {
        return 1;
      }
    }
    const total = checkLatticeLaws({ alpha: new ThrowsIn('toJSON'), beta: new ThrowsIn('valueSchema') })
      .failed.find((l) => l.law === 'total');
    const stages = total!.violations.map((v) => v.split(/[: ]/)[0]);
    expect(stages).toContain('FieldType.toJSON()');
    expect(stages).toContain('FieldType.toValueSchema()');
  });

  it('is otherwise SILENT — the builtins pass it with nothing declared', () => {
    // The control for all four above: the same harness over ordinary builtins
    // reports nothing, so the failures it found were the defects and not itself.
    const report = checkLatticeLaws({
      text: new TextFieldType(),
      bounded: new TextFieldType({ minLength: 2 }),
      number: new NumberFieldType(),
      whole: new NumberFieldType({ whole: true }),
    }, { registry: createRegistry() });
    expect(report.failed).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
