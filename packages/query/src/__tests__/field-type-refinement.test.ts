/**
 * FIELD-TYPE REFINEMENTS — `{ kind: <builtin base>, as: <registered name> }`.
 *
 * The assertion that pays for the feature is the boring one at the bottom of
 * "the measured win": **a `uuid` column's equality predicate emits a bare `=`
 * over the raw column, with no function call on it.** A catalog declaring
 * `id: { kind: 'text' }` at ~40 sites emits `LOWER("t"."id") = LOWER($1)` for
 * every id predicate — not sargable, and a hard `function lower(uuid) does not
 * exist` over a physical uuid column. One refinement declaring `casing: 'exact'`
 * fixes all forty, and only an assertion on the emitted SQL TEXT pins it.
 *
 * Everything else here defends the two properties that make the mechanism safe
 * rather than merely convenient:
 *
 *  - **narrowing only.** A use site stands on the refinement's declared options
 *    and may tighten them; a site that tries to loosen is absorbed by the meet,
 *    and a site that contradicts them has no meet and is refused. This is gin's
 *    `Extension.narrow` law, and it needs no new machinery here because the meet
 *    IS narrow — which the lattice laws in `param-meet.test.ts` now prove over
 *    refined shapes too.
 *  - **the vocabulary is real.** `as` renders as a `z.enum` of the names
 *    registered over that base, so a model cannot invent `as: 'uuid4'`, and it
 *    renders VERBATIM in the type tag so a model reading two type systems in one
 *    session sees one spelling.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createRegistry, type Registry } from '../registry';
import { QueryEngine } from '../engine';
import { QueryTypeError } from '../problem';
import { FieldType, SCALAR_KINDS, type ScalarKind } from '../field-type';
import { TextFieldType, fieldTypeDefSchema } from '../field-types/index';
import { Type } from '../type';
import { describeType } from '../llm/describe';
import { fieldMeta } from '../llm/describe-generate';
import { REFINABLE_BASES, type FieldTypeRefinementDef } from '../refinement';
import type { ExprDef, FieldTypeDef, FieldTypeKind, SelectDef, TypeDef } from '../schema';

// ─── Fixture ─────────────────────────────────────────────────────────────────

/**
 * The worked example. The DECLARATION is pure JSON; the stricter zod gate is the
 * CODE half and arrives through `registerFieldTypeImpl` — because a declaration
 * is what a consumer persists, and a zod schema does not fail a JSON round-trip,
 * it survives it as a husk (see "a declaration is safe to persist" below).
 */
const uuidDecl: FieldTypeRefinementDef = {
  name: 'uuid',
  base: 'text',
  instructions: 'A UUID (RFC 4122) — lower-case, hyphenated, 36 characters.',
  options: { minLength: 36, maxLength: 36, casing: 'exact' },
  sql: { postgres: 'uuid' },
  avgBytes: 16,
};

/**
 * A second, JSON-based refinement — the shape that exercises the parts a `text`
 * one cannot: a per-dialect `cast` template, and `{slot}` interpolation from the
 * declared options.
 */
const geoDecl: FieldTypeRefinementDef = {
  name: 'Geometry',
  base: 'json',
  instructions: 'A PostGIS geometry carried as GeoJSON. Order it by ST_Distance; `<` and LIKE are not defined.',
  sql: { postgres: 'geometry' },
  cast: { postgres: 'ST_GeomFromGeoJSON({value})::geometry' },
  avgBytes: 96,
};

const A_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const thingTypeDef: TypeDef = {
  name: 'thing',
  fields: [
    // The refined id — one declaration site, the whole catalog's worth of fix.
    { name: 'id', type: { kind: 'text', as: 'uuid' } },
    // The CONTROL: the same logical column, declared the way it is today.
    { name: 'plainId', type: { kind: 'text' } },
    { name: 'name', type: { kind: 'text' } },
    { name: 'shape', type: { kind: 'json', as: 'Geometry' }, nullable: true },
  ],
  count: 1000,
};

/** A registry with both refinements + the uuid impl, before any Type is parsed. */
function refinedRegistry(): Registry {
  const registry = createRegistry();
  registry.registerFieldType(uuidDecl);
  registry.registerFieldType(geoDecl);
  registry.registerFieldTypeImpl('uuid', { value: z.uuid() });
  return registry;
}

interface Fixture {
  registry: Registry;
  engine: QueryEngine;
}

function fixture(): Fixture {
  const registry = refinedRegistry();
  registry.registerType(registry.parseType(thingTypeDef));
  registry.finalize();
  return { registry, engine: new QueryEngine(registry) };
}

const uuidType = (registry: Registry = refinedRegistry()): FieldType =>
  registry.parseFieldType({ kind: 'text', as: 'uuid' });

/** A SELECT of `thing.name` filtered by `<field> = :p`. */
function whereEq(field: string): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'thing', field: 'name' }, as: 'name' }],
    from: { kind: 'type', type: 'thing' },
    where: [
      {
        kind: 'comparison',
        op: '=',
        left: { kind: 'field-ref', source: 'thing', field },
        right: { kind: 'param', name: 'p' },
      } satisfies ExprDef,
    ],
  };
}

/** The message of the `QueryTypeError` `fn` throws (fails the test when it throws nothing). */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(QueryTypeError);
    return err instanceof QueryTypeError ? err.problem.message : '';
  }
  throw new Error('expected a QueryTypeError, but the call returned');
}

/** The `code` of the `QueryTypeError` `fn` throws. */
function refusalCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof QueryTypeError ? err.problem.code : `not a QueryTypeError: ${String(err)}`;
  }
  throw new Error('expected a QueryTypeError, but the call returned');
}

// ─── The measured win ────────────────────────────────────────────────────────

describe('the measured win — an id predicate stops defeating its index', () => {
  it('emits a BARE `=` over the raw column, with no function call on it', () => {
    const { engine } = fixture();
    expect(engine.toSQL(whereEq('id'), 'postgres').sql).toContain('WHERE "thing"."id" = $1');
    expect(engine.toSQL(whereEq('id'), 'base').sql).toContain('WHERE "thing"."id" = ?');
    // The fact, stated as itself: NOTHING wraps the column, on either dialect.
    for (const dialect of ['base', 'postgres'] as const) {
      expect(engine.toSQL(whereEq('id'), dialect).sql).not.toMatch(/LOWER/i);
    }
  });

  it('…and the control — the SAME column declared `{kind:"text"}` — still emits `LOWER(…)`', () => {
    // Without this the assertion above could pass because the engine stopped
    // folding anything, rather than because the refinement narrowed the column.
    const { engine } = fixture();
    expect(engine.toSQL(whereEq('plainId'), 'postgres').sql)
      .toContain('WHERE LOWER("thing"."plainId") = LOWER($1)');
  });

  it('the narrowing arrives through the ordinary meet, not through a new rule', () => {
    // `casing: 'exact'` is on the DECLARATION; the field declared none. What the
    // column ends up with is the meet of the two.
    const registry = refinedRegistry();
    const site = registry.parseFieldType({ kind: 'text', as: 'uuid' });
    expect(site.textCasing()).toBe('exact');
    expect(registry.parseFieldType({ kind: 'text' }).textCasing()).toBeUndefined();
  });
});

// ─── The wire form ───────────────────────────────────────────────────────────

describe('the wire form stays a builtin', () => {
  it('parses to the BASE class, so every `instanceof` / `def.kind` narrowing still holds', () => {
    const ft = uuidType();
    expect(ft).toBeInstanceOf(TextFieldType);
    expect(ft.kind).toBe('text');
    expect(ft.resolve()).toBe('text');
  });

  it('round-trips through `toJSON`, carrying the declaration it stands on', () => {
    const json = uuidType().toJSON();
    expect(json).toEqual({ kind: 'text', minLength: 36, maxLength: 36, casing: 'exact', as: 'uuid' });
    // …and back again, to the same thing.
    expect(refinedRegistry().parseFieldType(json).toJSON()).toEqual(json);
  });

  it('survives a whole `TypeDef` round-trip', () => {
    const { registry } = fixture();
    const roundTripped = registry.parseType(registry.type('thing')!.toJSON());
    expect(roundTripped.field('id')!.fieldType.as).toBe('uuid');
    expect(roundTripped.field('shape')!.fieldType.as).toBe('Geometry');
  });

  it('`clone()` keeps the refinement — which is what makes the meet idempotent against a copy', () => {
    const ft = uuidType();
    expect(ft.clone().as).toBe('uuid');
    expect(ft.meet(ft.clone())?.toJSON()).toEqual(ft.toJSON());
  });

  it('an UNREFINED type serializes byte-for-byte as it always did', () => {
    expect(new TextFieldType({ minLength: 2 }).toJSON()).toEqual({ kind: 'text', minLength: 2 });
    expect(Object.keys(new TextFieldType().toJSON())).toEqual(['kind']);
  });
});

// ─── Narrowing, never widening ───────────────────────────────────────────────

describe('a use site may narrow the refinement, never widen it', () => {
  it('keeps the site\'s TIGHTER bound', () => {
    const ft = refinedRegistry().parseFieldType({ kind: 'text', as: 'uuid', pattern: '^f' });
    expect(ft.toJSON()).toEqual({
      kind: 'text', minLength: 36, maxLength: 36, pattern: '^f', casing: 'exact', as: 'uuid',
    });
  });

  it('ABSORBS a site that tries to loosen — the meet is a lower bound of both', () => {
    // `minLength: 2` is weaker than the declaration's 36, so the meet keeps 36.
    // The declaration is a FLOOR, and a site cannot lower it by naming a number.
    const ft = refinedRegistry().parseFieldType({ kind: 'text', as: 'uuid', minLength: 2 });
    expect(ft.toJSON()).toMatchObject({ minLength: 36 });
  });

  it('REFUSES a site whose narrowing no value could satisfy', () => {
    const message = refusal(() =>
      refinedRegistry().parseFieldType({ kind: 'text', as: 'uuid', maxLength: 10 }));
    expect(message).toContain('no value satisfies');
    expect(refusalCode(() => refinedRegistry().parseFieldType({ kind: 'text', as: 'uuid', maxLength: 10 })))
      .toBe('field-type.refinement-conflict');
  });

  it('REFUSES a refinement declared on the wrong base', () => {
    const message = refusal(() => refinedRegistry().parseFieldType({ kind: 'number', as: 'uuid' }));
    expect(message).toContain("refines a `text`");
    expect(refusalCode(() => refinedRegistry().parseFieldType({ kind: 'number', as: 'uuid' })))
      .toBe('field-type.refinement-base');
  });

  it('REFUSES an unregistered name, with a suggestion — never degrading to the bare base', () => {
    // Degrading silently is the expensive answer: it would take `casing: 'exact'`
    // with it and put the `LOWER()` back on every predicate over the column.
    const message = refusal(() => refinedRegistry().parseFieldType({ kind: 'text', as: 'uuidd' }));
    expect(message).toContain('Unknown field-type refinement');
    expect(message).toContain('did you mean `uuid`?');
    expect(refusalCode(() => refinedRegistry().parseFieldType({ kind: 'text', as: 'uuidd' })))
      .toBe('field-type.unknown-refinement');
  });
});

// ─── What the declaration decides ────────────────────────────────────────────

describe('what a refinement decides for its columns', () => {
  it('the VALUE gate is the conjunction of the declaration and the field\'s own options', () => {
    const ft = uuidType();
    expect(ft.validValue(A_UUID)).toBe(true);
    // Refused by `z.uuid()` though it satisfies every declared text bound.
    expect(ft.validValue('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaZZ')).toBe(false);

    // …and a site that narrows FURTHER still binds. Answering with the
    // declaration's schema alone would admit a uuid this field refuses, i.e.
    // break the soundness law the meet is property-tested against.
    const narrowed = refinedRegistry().parseFieldType({ kind: 'text', as: 'uuid', pattern: '^0' });
    expect(narrowed.validValue(A_UUID)).toBe(false);
    expect(narrowed.validValue('01234567-89ab-4cde-8f01-23456789abcd')).toBe(true);
  });

  it('the declared `avgBytes` replaces the base\'s guess', () => {
    expect(uuidType().avgBytes()).toBe(16);
    // The base would have said 18 for a 36-char bounded text — half the max.
    expect(new TextFieldType({ minLength: 36, maxLength: 36 }).avgBytes()).toBe(18);
  });

  it('the declared per-dialect SQL type is the cast target; a dialect with no entry falls back', () => {
    const registry = refinedRegistry();
    const ft = uuidType(registry);
    expect(registry.dialect('postgres')!.sqlTypeFor(ft)).toBe('uuid');
    // No `base` entry was declared, so the base dialect answers for the BASE
    // KIND — a real answer for a value of that type, not a degrade.
    expect(registry.dialect('base')!.sqlTypeFor(ft)).toBe('varchar(36)');
  });

  it('the declared `cast` wraps a bound document, and its absence falls back to the base cast', () => {
    const registry = refinedRegistry();
    const geo = registry.parseFieldType({ kind: 'json', as: 'Geometry' });
    const pg = registry.dialect('postgres')!;
    const rendered = pg.jsonValue({ type: 'Point' }, geo).render(pg);
    expect(rendered.sql).toBe('ST_GeomFromGeoJSON($1)::geometry');
    expect(rendered.params).toEqual(['{"type":"Point"}']);

    // The base dialect declares no cast ⇒ the ordinary `CAST(… AS …)`, over the
    // base kind's own SQL type.
    const base = registry.dialect('base')!;
    expect(base.jsonValue({ type: 'Point' }, geo).render(base).sql).toBe('CAST(? AS json)');
  });
});

// ─── What the model sees ─────────────────────────────────────────────────────

describe('what the model is told', () => {
  it('renders the NAME in the type tag and the declaration\'s instructions as the description', () => {
    const { registry } = fixture();
    const described = describeType(registry.type('thing')!);
    expect(described).toContain(
      '- id: text(as uuid) — Id: A UUID (RFC 4122) — lower-case, hyphenated, 36 characters.',
    );
    expect(described).toContain('- shape: json(as Geometry) (nullable) — Shape: A PostGIS geometry');
    // The control: an unrefined text column reads exactly as before.
    expect(described).toContain('- plainId: text — Plain: Text.');
  });

  it('renders the name VERBATIM — never lower-cased, never decorated', () => {
    const { registry } = fixture();
    // `Geometry` is capitalised deliberately (see D1 / `REFINEMENT_NAME_PATTERN`):
    // a sibling type system refuses a lower-case package type name, so the two
    // surfaces a model reads in one session must be free to agree on ONE word.
    expect(describeType(registry.type('thing')!)).toContain('json(as Geometry)');
  });

  it('puts the refinement FIRST, and prefixes it `as ` so it cannot be read as a flag', () => {
    const registry = refinedRegistry();
    const doc = registry.parseType({
      name: 'doc',
      fields: [{ name: 'ref', type: { kind: 'text', as: 'uuid', search: true } }],
      count: 1,
    });
    expect(describeType(doc)).toContain('- ref: text(as uuid,search)');
  });

  it('disambiguates the refinement from a kind\'s OWN non-flag qualifier', () => {
    // `money(Usd,USD)` gives a model no way to tell which token is the
    // refinement and which the currency; `money(as Usd,USD)` does, and the
    // prefix is also the key the model has to write.
    const registry = createRegistry();
    registry.registerFieldType({ name: 'Usd', base: 'money', instructions: 'US dollars.' });
    const acct = registry.parseType({
      name: 'acct',
      fields: [{ name: 'fee', type: { kind: 'money', as: 'Usd', currency: 'USD' } }],
      count: 1,
    });
    expect(describeType(acct)).toContain('- fee: money(as Usd,USD)');
  });

  it('offers `as` as an ENUM of the names registered over THAT base', () => {
    const registry = refinedRegistry();
    const schema = fieldTypeDefSchema({ registry });
    expect(schema.safeParse({ kind: 'text', as: 'uuid' }).success).toBe(true);
    expect(schema.safeParse({ kind: 'json', as: 'Geometry' }).success).toBe(true);
    // The whole point: an invented name is not writable.
    expect(schema.safeParse({ kind: 'text', as: 'uuid4' }).success).toBe(false);
  });

  it('REFUSES an `as` on a base with no registrations, rather than stripping it', () => {
    // Stripping was silent in the one pipeline that matters: `Tool.parse` →
    // `engine.parseType(result)` hands `parseType` the STRIPPED def, so the loud
    // `field-type.unknown-refinement` never fires. The identical mistake was
    // caught on `text` (an enum) and discarded on `number` (no key at all).
    const registry = refinedRegistry();
    expect(fieldTypeDefSchema({ registry }).safeParse({ kind: 'number', as: 'uuid' }).success).toBe(false);
    // …and the parse road is loud about WHY, for anyone who reaches it directly.
    expect(refusalCode(() => registry.parseFieldType({ kind: 'number', as: 'uuid' })))
      .toBe('field-type.refinement-base');
  });

  it('refuses an `as` on a registry with no refinements at all, and still accepts a bare def', () => {
    for (const schema of [fieldTypeDefSchema({ registry: createRegistry() }), fieldTypeDefSchema()]) {
      expect(schema.safeParse({ kind: 'text', as: 'uuid' }).success).toBe(false);
      expect(schema.safeParse({ kind: 'text' }).data).toEqual({ kind: 'text' });
      expect(schema.safeParse({ kind: 'text', minLength: 2 }).data).toEqual({ kind: 'text', minLength: 2 });
    }
  });

  it('the refusing `as` key is still representable as JSON Schema', () => {
    // `z.never()` renders as `{"not":{}}`; `z.undefined()` is UNREPRESENTABLE and
    // throws, which would break every tool schema built off a field type. Asked
    // of one branch rather than the whole union, which is recursive through
    // `array.item` and blows the stack for reasons that predate this key.
    const empty = z.toJSONSchema(TextFieldType.toSchema({ registry: createRegistry() }));
    expect(JSON.stringify(empty)).toContain('"not"');
    const populated = z.toJSONSchema(TextFieldType.toSchema({ registry: refinedRegistry() }));
    expect(JSON.stringify(populated)).toContain('"uuid"');
  });

  it('a Type\'s own generated schema carries the vocabulary — that is where a model authors one', () => {
    const registry = refinedRegistry();
    const typeSchema = Type.toSchema({ registry });
    const withRefinement = {
      name: 'thing', count: 1,
      fields: [{ name: 'id', type: { kind: 'text', as: 'uuid' } }],
    };
    expect(typeSchema.safeParse(withRefinement).data).toEqual(withRefinement);
    // Without the registry the `as` is not part of the vocabulary, so the def is
    // REFUSED rather than quietly stripped down to a bare `text` — which is
    // exactly why `Type.toSchema` threads `opts` down.
    expect(Type.toSchema().safeParse(withRefinement).success).toBe(false);
    expect(Type.toSchema().safeParse({
      name: 'thing', count: 1, fields: [{ name: 'id', type: { kind: 'text' } }],
    }).success).toBe(true);
  });

  it('a field with an authored description keeps it — a refinement never overrides the dev', () => {
    const registry = refinedRegistry();
    const type = registry.parseType({
      name: 'doc',
      fields: [{ name: 'id', type: { kind: 'text', as: 'uuid' }, description: 'The row key.' }],
      count: 1,
    });
    expect(fieldMeta(type.field('id')!).description).toBe('The row key.');
  });
});

// ─── Registration-time checks ────────────────────────────────────────────────

describe('registration refuses a declaration that would be wrong on every column naming it', () => {
  /** `uuidDecl` with one key replaced — so each case differs in exactly one thing. */
  const variant = (over: Partial<FieldTypeRefinementDef>): FieldTypeRefinementDef =>
    ({ ...uuidDecl, ...over }) as FieldTypeRefinementDef;

  const register = (decl: FieldTypeRefinementDef, into: Registry = createRegistry()): void => {
    into.registerFieldType(decl);
  };

  it('ACCEPTS a capitalised name — the cross-library constraint, and it is not optional', () => {
    // Measured: a sibling type system REQUIRES a leading capital on a package
    // type name (defending a real shadowing incident), so a lower-case-only rule
    // here would leave the owner's own examples unspellable in one library or
    // the other. This package's shipped `FUNCTION_NAME_PATTERN` already allows
    // capitals — that is how `ST_Contains` registers.
    expect(() => register(variant({ name: 'LatLng' }))).not.toThrow();
    expect(() => register(variant({ name: 'latlng' }))).not.toThrow();
    expect(() => register(variant({ name: 'uuid_v4' }))).not.toThrow();
  });

  it('refuses a name that is not an identifier', () => {
    for (const name of ['4uuid', 'uuid-v4', 'my.uuid', '_uuid', '', 'uuid v4']) {
      expect(refusal(() => register(variant({ name }))))
        .toContain('must match ^[A-Za-z][A-Za-z0-9_]*$');
    }
  });

  it('refuses a name that is a builtin KIND — one word cannot mean two things', () => {
    for (const kind of SCALAR_KINDS) {
      expect(refusal(() => register(variant({ name: kind }))))
        .toContain('is a builtin field-type kind');
    }
  });

  it('refuses a SECOND declarer of a name, and says who holds it', () => {
    const registry = createRegistry();
    register({ ...uuidDecl, declaredBy: 'the core catalog' }, registry);
    const message = refusal(() => register(variant({ instructions: 'Something else.' }), registry));
    expect(message).toContain('already registered as a refinement of `text` by the core catalog');
  });

  it('refuses an empty or missing `instructions` — the one place this is stricter than a function', () => {
    for (const instructions of ['', '   ']) {
      expect(refusal(() => register(variant({ instructions })))).toContain('`instructions` is required');
    }
  });

  it('refuses a non-positive `avgBytes`', () => {
    for (const avgBytes of [0, -1, Number.NaN]) {
      expect(refusal(() => register(variant({ avgBytes })))).toContain('greater than 0');
    }
    expect(() => register(variant({ avgBytes: undefined }))).not.toThrow();
  });

  it('refuses options the base itself would refuse, with the base\'s own message', () => {
    const message = refusal(() => register(variant({ base: 'text', options: { pattern: '([' } })));
    expect(message).toContain('not a valid `text` declaration');
    expect(message).toContain('field-type.bad-pattern');
  });

  it('refuses a `relation` BASE outright — nothing about a relation is narrowable', () => {
    // Its `to` is an identity and its `count` an estimate. Allowing it made a
    // site restate both verbatim (the duplication a refinement removes), and a
    // declaration naming only `count` registered cleanly and then refused every
    // column that used it, blaming the column.
    //
    // `relation` is not a member of `FieldTypeRefinementDef`, so each of these
    // is already a COMPILE error — the escape is what lets the RUNTIME half be
    // tested, which is the half an untyped caller reaches.
    for (const options of [undefined, { to: 'user', count: 1 }, { count: 1 }] as const) {
      const decl = { name: 'Owner', base: 'relation', instructions: 'x.', options };
      expect(refusal(() => register(decl as unknown as FieldTypeRefinementDef)))
        .toContain('A `relation` cannot be refined');
    }
    expect(REFINABLE_BASES).not.toContain('relation');
    expect([...REFINABLE_BASES].sort()).toEqual(SCALAR_KINDS.filter((k) => k !== 'relation').sort());
  });

  it('refuses a `cast` on a base whose values never reach a cast template', () => {
    // Measured on the doc's own uuid example: `cast: {postgres:'CAST({value} AS
    // uuid)'}` validated at registration and the predicate stayed
    // `WHERE "thing"."id" = $1`. Accepted-and-inert is the worst answer, so it
    // is refused with the alternative named.
    for (const base of ['text', 'number', 'bool', 'date', 'timestamp', 'money'] as const) {
      expect(refusal(() => register({
        name: 'Casty', base, instructions: 'x.',
        cast: { postgres: 'CAST({value} AS whatever)' },
      }))).toContain('cannot declare a `cast`');
    }
    // …and it is accepted on the two bases that DO route through `jsonValue`.
    expect(() => register({ name: 'J', base: 'json', instructions: 'x.', cast: { postgres: '{value}::jsonb' } }))
      .not.toThrow();
    expect(() => register({ name: 'A', base: 'array', instructions: 'x.', cast: { postgres: '{value}::text[]' } }))
      .not.toThrow();
  });

  it('refuses a SQL template naming a slot that is not an interpolable option, with a suggestion', () => {
    const message = refusal(() => register({
      name: 'Bounded', base: 'text', instructions: 'A bounded string.',
      options: { maxLength: 36 },
      sql: { postgres: 'varchar({maxLenght})' },
    }));
    expect(message).toContain('did you mean `maxLength`?');
    expect(message).toContain('interpolable: `{maxLength}`');
  });

  it('INTERPOLATES a declared option into the SQL type', () => {
    const registry = createRegistry();
    registry.registerFieldType({
      name: 'Sha', base: 'text', instructions: 'A hex digest.',
      options: { minLength: 64, maxLength: 64 },
      sql: { postgres: 'char({maxLength})' },
    });
    expect(registry.dialect('postgres')!.sqlTypeFor(registry.parseFieldType({ kind: 'text', as: 'Sha' })))
      .toBe('char(64)');
  });

  it('refuses interpolating an option whose value is not a bare token', () => {
    // Templates are raw-interpolated, so what goes INTO one is the injection
    // surface. A closed-set option has no token form and reads as unknown.
    expect(refusal(() => register({
      name: 'Coded', base: 'text', instructions: 'A code.',
      options: { values: [{ value: 'a' }] },
      sql: { postgres: 'varchar({values})' },
    }))).toContain('interpolable: none');
  });

  it('refuses a resolved SQL type that is not a SQL type name', () => {
    expect(refusal(() => register({
      name: 'Sneaky', base: 'text', instructions: 'x.',
      sql: { postgres: 'text); DROP TABLE users; --' },
    }))).toContain('is not a SQL type name');
  });

  it('refuses a `cast` template that never places the value it casts', () => {
    // The bound value would be dropped, so the emitted SQL would carry one
    // parameter fewer than the query supplies — every later placeholder shifts.
    expect(refusal(() => register({
      name: 'Dropped', base: 'json', instructions: 'x.',
      cast: { postgres: "'literal'::jsonb" },
    }))).toContain('never names `{value}`');
  });

  it('refuses an EMPTY slot — `{}` in a template names nothing', () => {
    expect(refusal(() => register({
      name: 'Empty', base: 'json', instructions: 'x.',
      cast: { postgres: "'{}'::jsonb || {value}" },
    }))).toContain('names `{}`');
  });

  it('refuses a `base` that is not a scalar kind, for a caller with no types', () => {
    // Unreachable from TypeScript — the declaration is a union discriminated by
    // `base` — but this is a runtime registration surface, so it is checked.
    const notAKind = { ...uuidDecl, base: 'geography' } as unknown as FieldTypeRefinementDef;
    expect(refusal(() => register(notAKind))).toContain('`base` must be one of');
  });

  it('refuses registering a refinement — or its impl — once the catalog has been built', () => {
    // The one SILENT failure in this design: a stored `as` resolves against the
    // registry as it stood AT PARSE TIME, so a system registering `uuid` after
    // the catalog crawl leaves every already-parsed column carrying the
    // un-narrowed base — with the LOWER() back, and the tag still reading `text`.
    for (const build of [
      (r: Registry): void => void r.parseType(thingTypeDef),
      (r: Registry): void => void r.registerType(r.parseType({ name: 'x', fields: [], count: 1 })),
    ]) {
      const registry = refinedRegistry();
      build(registry);
      expect(refusal(() => register({ name: 'Late', base: 'text', instructions: 'x.' }, registry)))
        .toContain('after a Type had already been parsed or registered');
      expect(refusal(() => registry.registerFieldTypeImpl('uuid', { value: z.string() })))
        .toContain('after a Type had already been parsed or registered');
      expect(refusalCode(() => register({ name: 'Late', base: 'text', instructions: 'x.' }, registry)))
        .toBe('field-type.late-refinement');
    }
  });
});

// ─── The code half, and why it is not on the declaration ─────────────────────

describe('a declaration is safe to PERSIST; the value gate is the code half', () => {
  it('a declaration round-trips through JSON and registers to the same thing', () => {
    const revived: FieldTypeRefinementDef = JSON.parse(JSON.stringify(uuidDecl)) as FieldTypeRefinementDef;
    expect(revived).toEqual(uuidDecl);
    const registry = createRegistry();
    registry.registerFieldType(revived);
    expect(registry.parseFieldType({ kind: 'text', as: 'uuid' }).toJSON())
      .toEqual(refinedRegistry().parseFieldType({ kind: 'text', as: 'uuid' }).toJSON());
  });

  it('a zod schema does NOT survive that round-trip — which is why it is not on the declaration', () => {
    // The measured failure this split exists to prevent: `JSON.stringify` turns
    // a zod schema into a plausible HUSK rather than dropping it, so a
    // declaration carrying one would register clean and then throw a raw
    // TypeError out of zod's internals at the first validValue() — no
    // QueryTypeError, no code, no path, and the strictest gate silently dead.
    const husk: unknown = JSON.parse(JSON.stringify({ value: z.uuid() }));
    expect(husk).not.toEqual({});
    expect(husk instanceof z.ZodType).toBe(false);
    // The impl road refuses it instead, at registration, with a code and a path.
    const registry = createRegistry();
    registry.registerFieldType(uuidDecl);
    const message = refusal(() =>
      registry.registerFieldTypeImpl('uuid', { value: husk } as unknown as { value: z.ZodTypeAny }));
    expect(message).toContain('`value` must be a zod schema');
  });

  it('refuses an impl for an unregistered name, and a SECOND impl for a registered one', () => {
    const registry = createRegistry();
    registry.registerFieldType(uuidDecl);
    expect(refusal(() => registry.registerFieldTypeImpl('uuidd', { value: z.uuid() })))
      .toContain('did you mean `uuid`?');
    registry.registerFieldTypeImpl('uuid', { value: z.uuid() });
    expect(refusal(() => registry.registerFieldTypeImpl('uuid', { value: z.string() })))
      .toContain('already has an implementation');
  });

  it('an impl-less refinement still narrows — the gate is the STRICTER half, not the only one', () => {
    const registry = createRegistry();
    registry.registerFieldType(uuidDecl);
    const ft = registry.parseFieldType({ kind: 'text', as: 'uuid' });
    expect(ft.textCasing()).toBe('exact');
    expect(ft.validValue(A_UUID)).toBe(true);
    // …and without the impl the base's own bounds are all that apply.
    expect(ft.validValue('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaZZ')).toBe(true);
    expect(ft.validValue('too short')).toBe(false);
  });
});

// ─── The meet's two order-dependence traps ───────────────────────────────────

describe('the meet never produces a type the registry itself would refuse', () => {
  /** A registry refining BOTH members of each cross-kind comparable family. */
  function crossKind(): Registry {
    return createRegistry()
      .registerFieldType({
        name: 'Score', base: 'number', instructions: 'A 0–100 score.',
        options: { min: 0, max: 100 }, avgBytes: 2,
      })
      .registerFieldType({ name: 'Usd', base: 'money', instructions: 'US dollars.' })
      .registerFieldType({ name: 'Day', base: 'date', instructions: 'A calendar day.' })
      .registerFieldType({ name: 'Instant', base: 'timestamp', instructions: 'A UTC instant.' });
  }

  it('drops to NO MEET when the met kind leaves the refinement\'s base, rather than stapling the tag on', () => {
    // `number`↔`money` and `date`↔`timestamp` are the only families that meet
    // across kinds, and `meetWith` answers with whichever side is MORE SPECIFIC.
    // So `Score` (a number) met with a money is a MONEY, which cannot carry it —
    // tagging it anyway produced `{kind:'money', …, as:'Score'}`, a def this very
    // registry throws on, and it reached callers through `params()`.
    const registry = crossKind();
    const meetJson = (x: FieldTypeDef, y: FieldTypeDef): unknown =>
      registry.parseFieldType(x).meet(registry.parseFieldType(y))?.toJSON() ?? null;

    // The tag does NOT survive: the meet is the other kind.
    expect(meetJson({ kind: 'number', as: 'Score' }, { kind: 'money' })).toBeNull();
    expect(meetJson({ kind: 'money' }, { kind: 'number', as: 'Score' })).toBeNull();
    expect(meetJson({ kind: 'date', as: 'Day' }, { kind: 'timestamp' })).toBeNull();
    expect(meetJson({ kind: 'timestamp' }, { kind: 'date', as: 'Day' })).toBeNull();

    // …and it DOES survive when the meet stays in its base kind, which is the
    // half a blanket "operand kinds differ ⇒ refuse" rule would have got wrong.
    expect(meetJson({ kind: 'money', as: 'Usd' }, { kind: 'number' }))
      .toEqual({ kind: 'money', as: 'Usd' });
    expect(meetJson({ kind: 'timestamp', as: 'Instant' }, { kind: 'date' }))
      .toEqual({ kind: 'timestamp', as: 'Instant' });

    // The control: the same families still meet when neither side is refined.
    expect(meetJson({ kind: 'number' }, { kind: 'money' })).not.toBeNull();
    expect(meetJson({ kind: 'date' }, { kind: 'timestamp' })).not.toBeNull();
  });

  it('…and that is checked on the RESULT, because checking the OPERANDS is not associative', () => {
    // The counterexample that decided it: `money ⊓ number` is a money, so a rule
    // refusing whenever the two operands' kinds differ would refuse
    // `(Usd ⊓ money) ⊓ number` and accept `Usd ⊓ (money ⊓ number)`. Asking about
    // the met KIND asks the only question that is stable however a fold groups.
    const registry = crossKind();
    const ft = (def: FieldTypeDef): FieldType => registry.parseFieldType(def);
    const usd = ft({ kind: 'money', as: 'Usd' });
    const money = ft({ kind: 'money' });
    const number = ft({ kind: 'number' });
    const left = usd.meet(money)?.meet(number);
    const right = usd.meet(money.meet(number)!);
    expect(left?.toJSON()).toEqual(right?.toJSON());
    expect(left?.toJSON()).toEqual({ kind: 'money', as: 'Usd' });
  });

  it('every meet it DOES produce re-parses on the registry that produced it', () => {
    // The property the bug broke, stated directly: a `ParamDef.type` handed back
    // by `params()` must be a def the same registry accepts.
    const registry = crossKind();
    const all = [
      { kind: 'number', as: 'Score' }, { kind: 'number' }, { kind: 'money' },
      { kind: 'money', currency: 'USD' }, { kind: 'date', as: 'Day' }, { kind: 'date' },
      { kind: 'timestamp' }, { kind: 'timestamp', timezone: true },
    ] satisfies FieldTypeDef[];
    for (const x of all) {
      for (const y of all) {
        const met = registry.parseFieldType(x).meet(registry.parseFieldType(y));
        if (!met) continue;
        const json = met.toJSON();
        expect(() => registry.parseFieldType(json)).not.toThrow();
        expect(registry.parseFieldType(json).toJSON()).toEqual(json);
      }
    }
  });

  it('REFUSES two DIFFERENT compilations of one name — the left operand no longer wins', () => {
    // Two registries can compile one name differently. Taking the left side's
    // instance made `a ⊓ b` and `b ⊓ a` JSON-identical (so a def-comparing
    // property test is blind) while ADMITTING different values and answering
    // different sqlType / avgBytes.
    const strict = createRegistry().registerFieldType(uuidDecl);
    strict.registerFieldTypeImpl('uuid', { value: z.uuid() });
    const loose = createRegistry().registerFieldType({
      name: 'uuid', base: 'text', instructions: 'Anything, really.', avgBytes: 99,
    });
    const a = strict.parseFieldType({ kind: 'text', as: 'uuid' });
    const b = loose.parseFieldType({ kind: 'text', as: 'uuid' });
    expect(a.meet(b)).toBeUndefined();
    expect(b.meet(a)).toBeUndefined();
    // …while the SAME compilation still meets itself, in either direction.
    const a2 = strict.parseFieldType({ kind: 'text', as: 'uuid' });
    expect(a.meet(a2)?.toJSON()).toEqual(a.toJSON());
  });
});

// ─── Enumerating what is registered ──────────────────────────────────────────

describe('a consumer can enumerate what a registry knows', () => {
  it('lists the field-type KINDS from the registry, not from the package', () => {
    expect(createRegistry().fieldTypeKinds().sort())
      .toEqual([...SCALAR_KINDS].sort());
  });

  it('lists the registered refinements, in registration order', () => {
    const registry = refinedRegistry();
    expect(registry.fieldTypeRefinementNames()).toEqual(['uuid', 'Geometry']);
    expect(registry.fieldTypeRefinement('uuid')?.base).toBe('text');
    expect(registry.fieldTypeRefinement('nope')).toBeUndefined();
    expect(registry.fieldTypeRefinementList().map((r) => r.instructions)).toEqual([
      uuidDecl.instructions, geoDecl.instructions,
    ]);
  });

  it('a registry with no refinements is unchanged in every observable way', () => {
    const registry = createRegistry();
    expect(registry.fieldTypeRefinementNames()).toEqual([]);
    expect(registry.parseFieldType({ kind: 'text' }).as).toBeUndefined();
    expect(registry.parseFieldType({ kind: 'text' }).refinement).toBeUndefined();
  });
});

// ─── The live crash the old exhaustiveness guard was ─────────────────────────

describe('an unregistered field-type kind describes itself instead of crashing', () => {
  /**
   * A third-party field type over a kind this package does not ship, registered
   * through the public `defineFieldType`.
   *
   * `FieldTypeClass.NAME` is typed `FieldTypeKind`, so this shape is not
   * spellable in TypeScript without the escape below — which is the point. The
   * kind union is closed at COMPILE time and the registry's map is open at
   * RUNTIME, and `describe-generate`'s guard used to THROW in exactly that gap,
   * from `describeType()` / `fieldMeta()` — i.e. from generating the default
   * description of any field that has none. An ordinary read of the catalog
   * crashed. It now falls back to the type's own `toCode()`, while the
   * compile-time exhaustiveness over the nine builtins is unchanged.
   */
  const DURATION = 'duration' as unknown as FieldTypeKind;

  class DurationFieldType extends FieldType {
    static readonly NAME = DURATION;
    readonly kind = DurationFieldType.NAME;
    static from(): DurationFieldType {
      return new DurationFieldType();
    }
    static toSchema(): z.ZodTypeAny {
      return z.object({ kind: z.literal(DURATION) });
    }
    resolve(): ScalarKind {
      return 'number';
    }
    toSQLType(): string {
      return 'interval';
    }
    override toCode(): string {
      return 'a duration in seconds';
    }
    protected builtinJSON(): FieldTypeDef {
      return { kind: DURATION } as unknown as FieldTypeDef;
    }
    protected builtinClone(): FieldType {
      return new DurationFieldType();
    }
    protected builtinValueSchema(): z.ZodTypeAny {
      return z.number();
    }
    protected builtinAvgBytes(): number {
      return 8;
    }
  }

  it('renders the type\'s own `toCode()` rather than throwing', () => {
    const registry = createRegistry();
    registry.defineFieldType(DurationFieldType);
    const type = registry.parseType({
      name: 'job',
      fields: [{ name: 'took', type: { kind: DURATION } as unknown as FieldTypeDef }],
      count: 1,
    });
    expect(fieldMeta(type.field('took')!).description).toBe('a duration in seconds.');
    expect(() => describeType(type)).not.toThrow();
    // …and the registry reports it, so a consumer can see what it holds.
    expect(registry.fieldTypeKinds()).toContain(DURATION);
  });
});
