/**
 * STEP 2 of the registered-type work: a refinement declares options of its OWN,
 * says which arms of the comparison grammar apply to it, and declares which
 * other types it may be compared with.
 *
 * Step 1 gave a refinement a name over a builtin base and let it NARROW that
 * base's own vocabulary. Everything here is about the three facts that
 * vocabulary cannot express:
 *
 *  - **`ownOptions`** — `srid`, `subtype`: options the base has never heard of,
 *    each typed by an ordinary `FieldTypeDef`, supplied per column in a `with`
 *    bag, and interpolable into the per-dialect `sql` / `cast` templates. The
 *    assertion that pays for it is the one at the bottom of "the measured win":
 *    **two columns of one type emit two different cast targets**, which is the
 *    thing a name alone could never do.
 *  - **`compare`** — which of the CLOSED nine-member `ComparisonOp` union mean
 *    anything for this type. `ordering: false` turns `shape < :p` from SQL whose
 *    answer is a storage-format detail into a `Problems`-grade refusal that
 *    quotes the type's own instructions.
 *  - **`comparableWith`** — compatibility as a declared relation, symmetrized by
 *    the registry so commutativity is structural.
 *
 * The lattice consequences of all three live in `param-meet.test.ts`, where the
 * laws are proved over the widest type set in the package; the SAFETY of
 * template interpolation once an option's value arrives per column — which is
 * the #1 item on the design's own failure table — is proved here.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createRegistry, type Registry } from '../registry';
import { QueryEngine } from '../engine';
import { QueryTypeError } from '../problem';
import { TOKEN_PATTERN } from '../field-type';
import { fieldTypeDefSchema, JsonFieldType } from '../field-types/index';
import { describeType } from '../llm/describe';
import { Type } from '../type';
import type { FieldTypeRefinementDef } from '../refinement';
import type { ExprDef, FieldTypeDef, SelectDef, TypeDef } from '../schema';

// ─── Fixture ─────────────────────────────────────────────────────────────────

/**
 * The worked example, and the one the design plan is written around: a PostGIS
 * geometry. It exercises every part of step 2 at once — two own options of
 * different declared types, both interpolated into both templates, a `compare`
 * that refuses two of the three arms, and a declared edge to a sibling type.
 */
const geometryDecl: FieldTypeRefinementDef = {
  name: 'Geometry',
  base: 'json',
  instructions:
    'A PostGIS geometry, carried as GeoJSON. Compare two geometries with ST_Contains / ST_Within, ' +
    'or order by ST_Distance; `<` and LIKE are not defined on one.',
  ownOptions: {
    subtype: {
      type: { kind: 'text', values: [{ value: 'Point' }, { value: 'Polygon' }, { value: 'Geometry' }] },
      default: 'Geometry',
      docs: 'The geometry subtype the column holds.',
    },
    srid: { type: { kind: 'number', whole: true }, default: 4326, docs: 'The spatial reference id.' },
  },
  sql: { postgres: 'geometry({subtype},{srid})' },
  cast: { postgres: 'ST_GeomFromGeoJSON({value})::geometry({subtype},{srid})' },
  compare: { equality: true, ordering: false, textMatch: false },
  comparableWith: ['Geography'],
  avgBytes: 96,
};

/** The sibling `Geometry` names and which does NOT name it back — the symmetrization case. */
const geographyDecl: FieldTypeRefinementDef = {
  name: 'Geography',
  base: 'json',
  instructions: 'A PostGIS geography as GeoJSON, on the spheroid.',
  compare: { ordering: false },
};

/** A `text` refinement that refuses the LIKE family — the third `compare` arm. */
const tokenDecl: FieldTypeRefinementDef = {
  name: 'Token',
  base: 'text',
  instructions: 'An opaque bearer token. Compare it for equality; never pattern-match one.',
  options: { casing: 'exact' },
  compare: { textMatch: false },
};

const parcelDef: TypeDef = {
  name: 'parcel',
  count: 250_000,
  fields: [
    { name: 'name', type: { kind: 'text' } },
    // Two columns of ONE type, differing only in their declared options.
    { name: 'shape', type: { kind: 'json', as: 'Geometry', with: { subtype: 'Polygon', srid: 4326 } } },
    { name: 'centre', type: { kind: 'json', as: 'Geometry', with: { subtype: 'Point', srid: 3857 } } },
    // …and one that names none, so it stands on the declared defaults.
    { name: 'bounds', type: { kind: 'json', as: 'Geometry' } },
    { name: 'region', type: { kind: 'json', as: 'Geography' }, nullable: true },
    { name: 'token', type: { kind: 'text', as: 'Token' } },
  ],
};

function refinedRegistry(): Registry {
  return createRegistry()
    .registerFieldType(geometryDecl)
    .registerFieldType(geographyDecl)
    .registerFieldType(tokenDecl);
}

function fixture(): { registry: Registry; engine: QueryEngine } {
  const registry = refinedRegistry();
  registry.registerType(registry.parseType(parcelDef));
  registry.finalize();
  return { registry, engine: new QueryEngine(registry) };
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

/** `SELECT name FROM parcel WHERE <where>`. */
function whereSelect(...where: ExprDef[]): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'parcel', field: 'name' } }],
    from: { kind: 'type', type: 'parcel' },
    where,
  };
}

/**
 * A registry + engine for `Blob` — a type that refuses EVERY arm of the grammar.
 * Its own fixture because the point is a type nothing may predicate on, which
 * `parcel` (whose columns must stay usable) cannot also be.
 */
function blobFixture(): { registry: Registry; engine: QueryEngine } {
  const registry = createRegistry().registerFieldType({
    name: 'Blob', base: 'json',
    instructions: 'An opaque payload. Read it; never predicate on it.',
    compare: { equality: false, ordering: false, textMatch: false },
  });
  registry.registerType(registry.parseType({
    name: 'doc', count: 10,
    fields: [{ name: 'id', type: { kind: 'text' } }, { name: 'payload', type: { kind: 'json', as: 'Blob' } }],
  }));
  registry.finalize();
  return { registry, engine: new QueryEngine(registry) };
}

/** `SELECT id FROM doc WHERE <where>`. */
function blobSelect(...where: ExprDef[]): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'doc', field: 'id' } }],
    from: { kind: 'type', type: 'doc' },
    where,
  };
}

/** `parcel.<field> <op> :p`. */
const cmp = (field: string, op: '=' | '<' | 'like'): ExprDef => ({
  kind: 'comparison',
  op,
  left: { kind: 'field-ref', source: 'parcel', field },
  right: { kind: 'param', name: 'p' },
});

// ─── The measured win ────────────────────────────────────────────────────────

describe('the measured win — two columns of ONE type emit two different cast targets', () => {
  it('resolves the declared `sql` template per COLUMN, from that column\'s own options', () => {
    // This is the whole delta a declared option buys over a bare name. Under
    // step 1 a refinement's `sql` was one string resolved at registration, so
    // every column naming `Geometry` would have shared `geometry(Geometry,4326)`
    // — and a `Point` column would have been cast to the wrong type on every
    // predicate over it.
    const { registry } = fixture();
    const pg = registry.dialect('postgres')!;
    const field = (name: string): string => pg.sqlTypeFor(registry.type('parcel')!.field(name)!.fieldType);
    expect(field('shape')).toBe('geometry(Polygon,4326)');
    expect(field('centre')).toBe('geometry(Point,3857)');
    // …and a column that named no options stands on the DECLARED DEFAULTS.
    expect(field('bounds')).toBe('geometry(Geometry,4326)');
  });

  it('resolves the declared `cast` template per column too, around the bound value', () => {
    const { registry } = fixture();
    const pg = registry.dialect('postgres')!;
    const cast = (name: string): string =>
      pg.jsonValue({ type: 'Point' }, registry.type('parcel')!.field(name)!.fieldType).render(pg).sql;
    expect(cast('shape')).toBe('ST_GeomFromGeoJSON($1)::geometry(Polygon,4326)');
    expect(cast('centre')).toBe('ST_GeomFromGeoJSON($1)::geometry(Point,3857)');
    // The base dialect declares neither template ⇒ the ordinary cast over the
    // BASE kind's own SQL type. A fallback, not a degrade.
    const base = registry.dialect('base')!;
    expect(base.jsonValue({ type: 'Point' }, registry.type('parcel')!.field('shape')!.fieldType).render(base).sql)
      .toBe('CAST(? AS json)');
  });
});

// ─── The wire form ───────────────────────────────────────────────────────────

describe('a column\'s own options ride in a `with` bag', () => {
  it('round-trips through `toJSON`, with its keys CANONICALLY ordered', () => {
    const registry = refinedRegistry();
    const json = registry.parseFieldType({ kind: 'json', as: 'Geometry', with: { subtype: 'Polygon', srid: 4326 } }).toJSON();
    // Sorted, not as written — `meet` compares two types by their serialized
    // form, so a bag that kept insertion order would make two equal types
    // unequal depending on which one was authored first.
    expect(JSON.stringify(json)).toBe('{"kind":"json","as":"Geometry","with":{"srid":4326,"subtype":"Polygon"}}');
    expect(refinedRegistry().parseFieldType(json).toJSON()).toEqual(json);
  });

  it('a column that names NO options carries no bag at all', () => {
    // Which is what keeps an existing def byte-identical: a defaulted option is
    // resolved on READ, never materialized (and see `param-meet.test.ts` for why
    // materializing it would break the option lattice).
    const ft = refinedRegistry().parseFieldType({ kind: 'json', as: 'Geometry' });
    expect(ft.toJSON()).toEqual({ kind: 'json', as: 'Geometry' });
    expect(ft.refinementOptions).toBeUndefined();
    expect(ft.refinementOption('srid')).toBe(4326);
  });

  it('survives a whole `TypeDef` round-trip', () => {
    const { registry } = fixture();
    const roundTripped = registry.parseType(registry.type('parcel')!.toJSON());
    expect(roundTripped.field('centre')!.fieldType.toJSON()).toEqual({
      kind: 'json', as: 'Geometry', with: { srid: 3857, subtype: 'Point' },
    });
  });

  it('`clone()` keeps the bag', () => {
    const ft = refinedRegistry().parseFieldType({ kind: 'json', as: 'Geometry', with: { srid: 3857 } });
    expect(ft.clone().toJSON()).toEqual(ft.toJSON());
    expect(ft.meet(ft.clone())?.toJSON()).toEqual(ft.toJSON());
  });
});

describe('the parse is the gate on what a column may say', () => {
  it('REFUSES an option the type does not declare, with a suggestion', () => {
    const message = refusal(() => refinedRegistry().parseFieldType({ kind: 'json', as: 'Geometry', with: { srids: 4326 } }));
    expect(message).toContain('declares no option `srids`');
    expect(message).toContain('did you mean `srid`?');
    expect(message).toContain('declared: subtype, srid');
    expect(refusalCode(() => refinedRegistry().parseFieldType({ kind: 'json', as: 'Geometry', with: { nope: 1 } })))
      .toBe('field-type.unknown-option');
  });

  it('REFUSES a value the option\'s own declared type refuses, and names the members', () => {
    const message = refusal(() => refinedRegistry().parseFieldType({ kind: 'json', as: 'Geometry', with: { subtype: 'Blob' } }));
    expect(message).toContain('one of Point|Polygon|Geometry');
    expect(message).toContain('"Blob" is not one');
    expect(refusalCode(() => refinedRegistry().parseFieldType({ kind: 'json', as: 'Geometry', with: { srid: 'four' } })))
      .toBe('field-type.bad-option');
  });

  it('REFUSES a `with` bag on a def that names no `as`', () => {
    // The options belong to a DECLARATION; with no `as` there is none to belong
    // to, and dropping the bag would leave its author believing a fact that is
    // not in force.
    expect(refusalCode(() => refinedRegistry().parseFieldType({ kind: 'json', with: { srid: 4326 } })))
      .toBe('field-type.unknown-option');
  });

  it('a REFINEMENT with no declared options refuses any bag at all', () => {
    expect(refusal(() => refinedRegistry().parseFieldType({ kind: 'json', as: 'Geography', with: { srid: 4326 } })))
      .toContain('declared: none');
  });
});

// ─── Template safety, once the value arrives per column ──────────────────────

describe('template interpolation stays safe when the VALUE is the column author\'s', () => {
  const register = (decl: FieldTypeRefinementDef): void => {
    createRegistry().registerFieldType(decl);
  };

  it('REFUSES interpolating an option whose declared type is not CLOSED', () => {
    // The rule that replaces step 1's "check the declared value". A declared
    // value was a constant and could be checked once; an own option's value
    // arrives per column, so what has to be bounded is the TYPE. An open `text`
    // would let a column author write `text); DROP TABLE users; --` into a raw
    // SQL slot.
    const message = refusal(() => register({
      name: 'Open', base: 'json', instructions: 'x.',
      ownOptions: { tag: { type: { kind: 'text' }, default: 'a' } },
      sql: { postgres: 'geometry({tag})' },
    }));
    expect(message).toContain('does not bound that');
    expect(message).toContain('Give it a CLOSED type');
  });

  it('…and a closed set whose MEMBERS are not bare tokens is not closed enough', () => {
    expect(refusal(() => register({
      name: 'Sneaky', base: 'json', instructions: 'x.',
      ownOptions: { tag: { type: { kind: 'text', values: [{ value: 'ok' }, { value: 'a); DROP TABLE t; --' }] }, default: 'ok' } },
      sql: { postgres: 'geometry({tag})' },
    }))).toContain('Give it a CLOSED type');
  });

  it('ACCEPTS the three closed shapes — a values set, a bool, a whole number', () => {
    expect(() => register({
      name: 'Ok', base: 'json', instructions: 'x.',
      ownOptions: {
        sub: { type: { kind: 'text', values: [{ value: 'Point' }] }, default: 'Point' },
        srid: { type: { kind: 'number', whole: true }, default: 4326 },
        flag: { type: { kind: 'bool' }, default: false },
      },
      sql: { postgres: 'geometry({sub},{srid},{flag})' },
    })).not.toThrow();
  });

  it('REFUSES an interpolated option with no `default` — a template must resolve for EVERY column', () => {
    expect(refusal(() => register({
      name: 'Holed', base: 'json', instructions: 'x.',
      ownOptions: { srid: { type: { kind: 'number', whole: true } } },
      sql: { postgres: 'geometry({srid})' },
    }))).toContain('declares no `default`');
  });

  it('an option NOT interpolated needs neither a closed type nor a default', () => {
    // The rule is about the injection surface, not about options in general.
    expect(() => register({
      name: 'Documented', base: 'json', instructions: 'x.',
      ownOptions: { note: { type: { kind: 'text' } } },
    })).not.toThrow();
  });

  it('REFUSES a template that is only a legal type name for SOME values of its option', () => {
    // The check that replaced "resolve it once and test the string": every slot
    // is probed with a letter, an underscore and a DIGIT, so a template whose
    // slot sits where an identifier must start is refused at the DECLARATION
    // rather than on the one column that happens to write a number there.
    const message = refusal(() => register({
      name: 'Positional', base: 'json', instructions: 'x.',
      ownOptions: { srid: { type: { kind: 'number', whole: true }, default: 4326 } },
      sql: { postgres: '{srid}_geom' },
    }));
    expect(message).toContain('"0_geom" is not a SQL type name');
    expect(message).toContain('for EVERY value it can hold');
  });

  it('REFUSES a per-column value that has no bare-token form, even under a closed type', () => {
    // Belt AND braces: a `whole` number is closed enough to declare and still
    // admits `-1` and `1e21`, neither of which is a token. The type check is the
    // structural half; this is the per-value half, and together they make emit
    // total.
    const registry = createRegistry();
    registry.registerFieldType({
      name: 'Sized', base: 'json', instructions: 'x.',
      ownOptions: { n: { type: { kind: 'number', whole: true }, default: 4 } },
      sql: { postgres: 'geometry({n})' },
    });
    expect(refusal(() => registry.parseFieldType({ kind: 'json', as: 'Sized', with: { n: -1 } })))
      .toContain('must be a bare identifier or number token');
    expect(refusalCode(() => registry.parseFieldType({ kind: 'json', as: 'Sized', with: { n: 1e21 } })))
      .toBe('field-type.bad-option');
    expect(() => registry.parseFieldType({ kind: 'json', as: 'Sized', with: { n: 12 } })).not.toThrow();
  });
});

describe('registration refuses a declaration whose options could not be read', () => {
  const register = (decl: FieldTypeRefinementDef): void => {
    createRegistry().registerFieldType(decl);
  };

  it('refuses an option name that would COLLIDE with a base option in a template', () => {
    // `{maxLength}` would name two different values and nothing in the template
    // says which.
    expect(refusal(() => register({
      name: 'Clash', base: 'text', instructions: 'x.',
      options: { maxLength: 36 },
      ownOptions: { maxLength: { type: { kind: 'number', whole: true }, default: 8 } },
    }))).toContain('already a declared BASE option');
  });

  it('refuses the reserved `value` name — a cast template puts the BOUND value there', () => {
    expect(refusal(() => register({
      name: 'Reserved', base: 'json', instructions: 'x.',
      ownOptions: { value: { type: { kind: 'bool' }, default: true } },
    }))).toContain('is reserved');
  });

  it('refuses an option name that is not an identifier', () => {
    expect(refusal(() => register({
      name: 'Odd', base: 'json', instructions: 'x.',
      ownOptions: { 'sr-id': { type: { kind: 'bool' }, default: true } },
    }))).toContain('must match');
  });

  it('refuses a default its OWN declared type refuses', () => {
    expect(refusal(() => register({
      name: 'Wrong', base: 'json', instructions: 'x.',
      ownOptions: { sub: { type: { kind: 'text', values: [{ value: 'Point' }] }, default: 'Blob' } },
    }))).toContain('is not a valid');
  });

  it('refuses an option whose declared TYPE is not a valid field type, with that road\'s own message', () => {
    expect(refusal(() => register({
      name: 'BadType', base: 'json', instructions: 'x.',
      ownOptions: { sub: { type: { kind: 'text', pattern: '([' } } },
    }))).toContain('field-type.bad-pattern');
  });

  it('refuses a `compare` arm that is not a boolean, and a `comparableWith` that is not a name list', () => {
    const notBool = { name: 'B', base: 'json', instructions: 'x.', compare: { ordering: 'no' } };
    expect(refusal(() => register(notBool as unknown as FieldTypeRefinementDef))).toContain('must be a boolean');
    const notNames = { name: 'C', base: 'json', instructions: 'x.', comparableWith: ['not a name'] };
    expect(refusal(() => register(notNames as unknown as FieldTypeRefinementDef))).toContain('is not a refinement name');
  });

  it('refuses `ownOptions` / `compare` / `comparableWith` spelled wrong, like any other unknown key', () => {
    const typo = { ...geometryDecl, ownOption: {} };
    expect(refusal(() => register(typo as unknown as FieldTypeRefinementDef))).toContain('did you mean `ownOptions`?');
  });
});

// ─── The declared comparison grammar ─────────────────────────────────────────

describe('`compare` refuses an arm of the grammar that means nothing for the type', () => {
  const codes = (list: { code: string }[]): string[] => list.map((p) => p.code);

  it('refuses ORDERING a type that declares none, and says what to reach for instead', () => {
    const { engine } = fixture();
    const problems = engine.validateQuery(whereSelect(cmp('shape', '<'))).list;
    expect(codes(problems)).toEqual(['comparison.type']);
    expect(problems[0]!.message).toContain("Cannot order `Geometry` values with '<'");
    expect(problems[0]!.message).toContain('`compare.ordering: false`');
    // The half that saves a round trip: the declaration's own instructions,
    // which name the alternative.
    expect(problems[0]!.message).toContain('order by ST_Distance');
  });

  it('refuses the LIKE family on a type that declares no text matching', () => {
    const { engine } = fixture();
    const problems = engine.validateQuery(whereSelect(cmp('token', 'like'))).list;
    expect(codes(problems)).toEqual(['comparison.type']);
    expect(problems[0]!.message).toContain("Cannot pattern-match `Token` values with 'like'");
    expect(problems[0]!.message).toContain('never pattern-match one');
  });

  it('refuses EQUALITY when the type declares none', () => {
    const { engine } = blobFixture();
    const problems = engine.validateQuery(blobSelect({
      kind: 'comparison', op: '=',
      left: { kind: 'field-ref', source: 'doc', field: 'payload' },
      right: { kind: 'param', name: 'p' },
    })).list;
    expect(codes(problems)).toEqual(['comparison.type']);
    expect(problems[0]!.message).toContain('the type declares no equality');
  });

  it('a bare PARAM operand is NOT exempt — the fact belongs to the column', () => {
    // Unlike the comparability check, which excuses a param because its type is
    // still being inferred. `shape < :p` is refused exactly as
    // `shape < other.shape` is, and both roads are asserted so neither can
    // regress alone.
    const { engine } = fixture();
    const columns: ExprDef = {
      kind: 'comparison', op: '<',
      left: { kind: 'field-ref', source: 'parcel', field: 'shape' },
      right: { kind: 'field-ref', source: 'parcel', field: 'centre' },
    };
    expect(codes(engine.validateQuery(whereSelect(columns)).list)).toEqual(['comparison.type']);
    expect(codes(engine.validateQuery(whereSelect(cmp('shape', '<'))).list)).toEqual(['comparison.type']);
  });

  it('refuses BETWEEN on a type that declares no ORDERING — it is `>=` and `<=`', () => {
    // The hole a one-token rewrite opened: a model refused at `shape < :p`
    // restates it as `shape BETWEEN :p AND :q`. `declaredArmRefusal` was keyed
    // by `ComparisonOp` and so was reachable only from `ComparisonExpr`, while
    // `BETWEEN` emitted `WHERE "parcel"."shape" BETWEEN $1 AND $2` — the exact
    // SQL the refusal exists to prevent.
    const { engine } = fixture();
    const between: ExprDef = {
      kind: 'between',
      value: { kind: 'field-ref', source: 'parcel', field: 'shape' },
      lower: { kind: 'param', name: 'a' },
      upper: { kind: 'param', name: 'b' },
    };
    const problems = engine.validateQuery(whereSelect(between)).list;
    expect(codes(problems)).toEqual(['between.type']);
    expect(problems[0]!.message).toContain("Cannot order `Geometry` values with 'BETWEEN'");
    expect(problems[0]!.message).toContain('order by ST_Distance');
    // …and a bound may be the offending operand too, not only the value.
    const boundIsGeo: ExprDef = {
      kind: 'between',
      value: { kind: 'param', name: 'v' },
      lower: { kind: 'field-ref', source: 'parcel', field: 'shape' },
      upper: { kind: 'field-ref', source: 'parcel', field: 'centre' },
    };
    expect(codes(engine.validateQuery(whereSelect(boundIsGeo)).list)).toContain('between.type');
  });

  it('refuses IN on a type that declares no EQUALITY — it is a disjunction of `=`', () => {
    const { registry, engine } = blobFixture();
    void registry;
    const inList: ExprDef = {
      kind: 'in',
      value: { kind: 'field-ref', source: 'doc', field: 'payload' },
      in: [{ kind: 'param', name: 'a' }, { kind: 'param', name: 'b' }],
    };
    const problems = engine.validateQuery(blobSelect(inList)).list;
    expect(codes(problems)).toEqual(['in.type']);
    expect(problems[0]!.message).toContain("Cannot compare `Blob` values with 'IN'");
  });

  it('…and BETWEEN / IN stay untouched for a type that declares those arms', () => {
    // The control that stops the two above from passing because the predicates
    // broke generally.
    const { engine } = fixture();
    const between: ExprDef = {
      kind: 'between',
      value: { kind: 'field-ref', source: 'parcel', field: 'name' },
      lower: { kind: 'param', name: 'a' },
      upper: { kind: 'param', name: 'b' },
    };
    expect(engine.validateQuery(whereSelect(between)).list).toEqual([]);
    const inList: ExprDef = {
      kind: 'in',
      value: { kind: 'field-ref', source: 'parcel', field: 'token' },
      in: [{ kind: 'param', name: 'a' }],
    };
    // `Token` refuses only the LIKE family, so IN (equality) is fine.
    expect(engine.validateQuery(whereSelect(inList)).list).toEqual([]);
  });

  it('the CONTROL — the arms it DOES declare, and an unrefined column, are untouched', () => {
    const { engine } = fixture();
    // Equality on a geometry is declared and passes.
    expect(engine.validateQuery(whereSelect(cmp('shape', '='))).list).toEqual([]);
    // Ordering a plain text column is unchanged.
    expect(engine.validateQuery(whereSelect(cmp('name', '<'))).list).toEqual([]);
    // …and `Token` refuses only LIKE: `=` and `<` on it are its base's own.
    expect(engine.validateQuery(whereSelect(cmp('token', '='))).list).toEqual([]);
    expect(engine.validateQuery(whereSelect(cmp('token', '<'))).list).toEqual([]);
  });
});

// ─── Declared comparability ──────────────────────────────────────────────────

describe('`comparableWith` is a declared relation the REGISTRY symmetrizes', () => {
  it('lets two DIFFERENT registered types be compared, where the builtin rule would not', () => {
    // `json` compares only with `json`, which is why a declared edge is needed
    // at all for a pair like this — and the builtin rule here already says yes,
    // so the fact under test is the REFINEMENT-level one: the edge exists on
    // both compiled types.
    const registry = refinedRegistry();
    const geometry = registry.fieldTypeRefinement('Geometry')!;
    const geography = registry.fieldTypeRefinement('Geography')!;
    expect(geometry.comparableTo('Geography')).toBe(true);
    // The half the declaration did NOT say — recorded anyway.
    expect(geography.comparableTo('Geometry')).toBe(true);
    expect(geography.declaredComparableWith).toEqual([]);
  });

  it('files a `warn`-grade note naming the side that stayed silent', () => {
    const notes = refinedRegistry().fieldTypeComparabilityNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.code).toBe('field-type.one-sided-comparability');
    expect(notes[0]!.severity).toBe('warning');
    expect(notes[0]!.message).toContain('`Geometry` declares');
    expect(notes[0]!.message).toContain('`Geography` does not name it back');
  });

  it('works in EITHER registration order — an edge may name a type not registered yet', () => {
    // The reason symmetrization lives in the registry rather than in `compile`:
    // a MUTUAL pair is unspellable otherwise, since one of the two has to be
    // declared first and would then name something that does not exist.
    const late = createRegistry().registerFieldType(geographyDecl).registerFieldType(geometryDecl);
    expect(late.fieldTypeRefinement('Geography')!.comparableTo('Geometry')).toBe(true);
    expect(late.fieldTypeRefinement('Geometry')!.comparableTo('Geography')).toBe(true);
  });

  it('a MUTUAL declaration records the edge and files NO note', () => {
    const mutual = createRegistry()
      .registerFieldType({ ...geographyDecl, comparableWith: ['Geometry'] })
      .registerFieldType(geometryDecl);
    expect(mutual.fieldTypeComparabilityNotes()).toEqual([]);
    expect(mutual.fieldTypeRefinement('Geometry')!.comparableTo('Geography')).toBe(true);
  });

  it('an edge to a name that never registers is simply inert', () => {
    // Not an error: a declaration is data, and a deployment may install one half
    // of a pair. What it must not do is silently make something comparable that
    // is not — and it cannot, because the relation is keyed on the compiled
    // refinements that exist.
    const lonely = createRegistry().registerFieldType(geometryDecl);
    expect(lonely.fieldTypeRefinement('Geometry')!.comparableTo('Geography')).toBe(false);
    expect(lonely.fieldTypeComparabilityNotes()).toEqual([]);
  });

  it('naming YOURSELF is dropped rather than refused — every type is comparable with itself', () => {
    const selfish = createRegistry().registerFieldType({ ...geographyDecl, comparableWith: ['Geography'] });
    expect(selfish.fieldTypeRefinement('Geography')!.declaredComparableWith).toEqual([]);
    expect(selfish.fieldTypeRefinement('Geography')!.comparableTo('Geography')).toBe(true);
  });
});

// ─── What the model sees ─────────────────────────────────────────────────────

describe('what the model is told about a declared option', () => {
  it('renders each option\'s EFFECTIVE value in the type tag', () => {
    const { registry } = fixture();
    const described = describeType(registry.type('parcel')!);
    expect(described).toContain('- shape: json(as Geometry,subtype=Polygon,srid=4326,no <,no LIKE)');
    expect(described).toContain('- centre: json(as Geometry,subtype=Point,srid=3857,no <,no LIKE)');
    // A column that named none is rendered with the DEFAULTS rather than blank:
    // the SRID it is stored under is a fact about it either way, and a model
    // reading nothing has no way to know which one it is writing against.
    expect(described).toContain('- bounds: json(as Geometry,subtype=Geometry,srid=4326,no <,no LIKE)');
    // A refinement with no options of its own renders only what it refuses.
    expect(described).toContain('- region: json(as Geography,no <) (nullable)');
  });

  it('renders the arms the type REFUSES, so a model does not discover them by failing', () => {
    // The whole argument for this line, in this package's own accounting: a
    // model that learns `<` is unavailable by WRITING one pays a validate-fail
    // retry carrying the entire schema — thousands of tokens to save the handful
    // this spends. Before it existed the only channel was whatever the declarer
    // happened to type into `instructions`.
    const { registry } = fixture();
    const described = describeType(registry.type('parcel')!);
    expect(described).toContain('json(as Geography,no <)');
    expect(described).toContain('text(as Token,no LIKE)');
    // A type that refuses nothing renders exactly as it did — no empty qualifier.
    const plain = createRegistry().registerFieldType({ name: 'Sha', base: 'text', instructions: 'A digest.' });
    const doc = plain.parseType({ name: 'd', count: 1, fields: [{ name: 'h', type: { kind: 'text', as: 'Sha' } }] });
    expect(describeType(doc)).toContain('- h: text(as Sha) —');
  });

  it('names the refused arms in the `as` enum a model AUTHORS a type against', () => {
    // The tag above is read while writing a PREDICATE; this is read while
    // choosing a TYPE for a column, and both readers need the fact.
    const rendered = schemaDescription(JsonFieldType.toSchema({ registry: refinedRegistry() }));
    expect(rendered).toContain('Geometry — A PostGIS geometry');
    expect(rendered).toContain('(refuses: <, LIKE)');
    expect(rendered).toContain('Geography — A PostGIS geography as GeoJSON, on the spheroid. (refuses: <)');
  });

  it('offers `with` as a STRICT object of the options registered over that base', () => {
    const schema = fieldTypeDefSchema({ registry: refinedRegistry() });
    expect(schema.safeParse({ kind: 'json', as: 'Geometry', with: { subtype: 'Point', srid: 4326 } }).success).toBe(true);
    // Strict: an option no refinement of this base declares is REFUSED by the
    // schema rather than stripped, which is the failure the empty-`as` key
    // documents — `Tool.parse` hands `parseType` the stripped def, so the loud
    // refusal at parse would never fire.
    expect(schema.safeParse({ kind: 'json', as: 'Geometry', with: { nope: 1 } }).success).toBe(false);
    // …and the option's own declared type is the gate, so an invented member is
    // not writable either.
    expect(schema.safeParse({ kind: 'json', as: 'Geometry', with: { subtype: 'Blob' } }).success).toBe(false);
  });

  it('names each option\'s owner, type, default and docs in the key\'s description', () => {
    // Asked of ONE BRANCH's schema, not the union's: `z.toJSONSchema` over the
    // whole `fieldTypeDefSchema` throws `RangeError` on this release and on
    // released `0.6.5` alike (a pre-existing limit recorded in `CHANGELOG.md`,
    // caused by `ArrayFieldType.toSchema`'s lazy having no stable id).
    const rendered = schemaDescription(JsonFieldType.toSchema({ registry: refinedRegistry() }));
    expect(rendered).toContain('Geometry.subtype');
    expect(rendered).toContain('default \\"Geometry\\"');
    expect(rendered).toContain('The geometry subtype the column holds.');
    // …and the option's own closed set reaches the schema, so a model cannot
    // invent a member.
    expect(rendered).toContain('Polygon');
  });

  it('REFUSES a `with` on a base where no refinement declares options', () => {
    // Same reasoning as the empty `as` key: "there are none" is a refusal, not
    // an omission, because an omitted key is STRIPPED.
    const schema = fieldTypeDefSchema({ registry: refinedRegistry() });
    expect(schema.safeParse({ kind: 'text', as: 'Token', with: { srid: 1 } }).success).toBe(false);
    // …and a registry with no refinements at all still accepts a bare def.
    const bare = fieldTypeDefSchema({ registry: createRegistry() });
    expect(bare.safeParse({ kind: 'json', with: { srid: 1 } }).success).toBe(false);
    expect(bare.safeParse({ kind: 'json' }).success).toBe(true);
  });

  it('a Type\'s own generated schema carries the vocabulary — that is where a model authors one', () => {
    const registry = refinedRegistry();
    const authored = {
      name: 'plot', count: 1,
      fields: [{ name: 'shape', type: { kind: 'json', as: 'Geometry', with: { subtype: 'Point' } } }],
    };
    expect(Type.toSchema({ registry }).safeParse(authored).data).toEqual(authored);
    expect(Type.toSchema().safeParse(authored).success).toBe(false);
  });
});

/** A zod schema's own `.describe()` text, wherever in the union the branch put it. */
function schemaDescription(schema: z.ZodTypeAny): string {
  return JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));
}

// ─── The step-1 surface is untouched ─────────────────────────────────────────

describe('a step-1 declaration behaves exactly as it did', () => {
  it('registers, parses, emits and describes with no `ownOptions` / `compare` / `comparableWith`', () => {
    const registry = createRegistry().registerFieldType({
      name: 'uuid', base: 'text',
      instructions: 'A UUID (RFC 4122).',
      options: { minLength: 36, maxLength: 36, casing: 'exact' },
      sql: { postgres: 'uuid' },
      avgBytes: 16,
    });
    registry.registerFieldTypeImpl('uuid', { value: z.uuid() });
    const ft = registry.parseFieldType({ kind: 'text', as: 'uuid' });
    expect(ft.toJSON()).toEqual({ kind: 'text', minLength: 36, maxLength: 36, casing: 'exact', as: 'uuid' });
    expect(ft.refinementOptions).toBeUndefined();
    expect(registry.dialect('postgres')!.sqlTypeFor(ft)).toBe('uuid');
    expect(registry.fieldTypeRefinement('uuid')!.compare).toEqual({ equality: true, ordering: true, textMatch: true });
    expect(registry.fieldTypeRefinement('uuid')!.ownOptions.size).toBe(0);
  });

  it('a base-option `{slot}` still resolves at REGISTRATION, so it costs nothing per column', () => {
    const registry = createRegistry().registerFieldType({
      name: 'Sha', base: 'text', instructions: 'A hex digest.',
      options: { minLength: 64, maxLength: 64 },
      sql: { postgres: 'char({maxLength})' },
    });
    expect(registry.dialect('postgres')!.sqlTypeFor(registry.parseFieldType({ kind: 'text', as: 'Sha' })))
      .toBe('char(64)');
  });

  it('a base-option slot whose value has no TOKEN form still reads as un-interpolable', () => {
    // Both vocabularies go through one `templateToken` now, so a negative bound
    // is refused the same way a closed set always was — as an unknown slot,
    // because there is nothing safe to interpolate.
    expect(refusal(() => createRegistry().registerFieldType({
      name: 'Signed', base: 'number', instructions: 'x.',
      options: { min: -90 },
      sql: { postgres: 'numeric({min})' },
    }))).toContain('interpolable: none');
  });
});

describe('the two ends of the token guarantee cannot drift apart', () => {
  it('registration and parse hold values to the SAME charset — ONE constant, not two', () => {
    // They guard one fact from opposite ends: `tokenSafeValues()` proves at
    // REGISTRATION that every member of a closed option type is a bare token,
    // and `refine` proves at PARSE that each written value is. The charset was
    // RESTATED in both files, and a mutation to one left the whole suite green —
    // so this asserts the shared constant is what both ends use, over a corpus
    // that straddles the boundary.
    for (const member of ['a', 'A_1', '0']) expect(TOKEN_PATTERN.test(member)).toBe(true);
    for (const member of ['a.b', 'a-b', 'a b', '']) {
      expect(TOKEN_PATTERN.test(member)).toBe(false);
      // The REGISTRATION end refuses a closed set holding it.
      expect(() => createRegistry().registerFieldType({
        name: 'Tagged', base: 'json', instructions: 'x.',
        ownOptions: { tag: { type: { kind: 'text', values: [{ value: member }] }, default: member } },
        sql: { postgres: 'geometry({tag})' },
      })).toThrow();
    }
    // …and the PARSE end refuses a column writing a non-token under a type that
    // is closed enough to declare but still admits one. A charset differing by a
    // character would put a value on the wrong side of exactly one of these.
    const open = createRegistry().registerFieldType({
      name: 'Srid', base: 'json', instructions: 'x.',
      ownOptions: { n: { type: { kind: 'number', whole: true }, default: 1 } },
      sql: { postgres: 'geometry({n})' },
    });
    expect(refusalCode(() => open.parseFieldType({ kind: 'json', as: 'Srid', with: { n: -1 } })))
      .toBe('field-type.bad-option');
  });

  it('a DECLARED closed set decides token-safety, and `whole` is only the fallback', () => {
    // Written as `whole || set`, `whole: true` short-circuited past a set the
    // base was about to inspect — so a declaration carrying a NEGATIVE member
    // registered cleanly and then refused every column writing it, blaming the
    // column for a value its own type declares legal. That is the exact failure
    // a `relation` base is refused for.
    expect(refusal(() => createRegistry().registerFieldType({
      name: 'Srid', base: 'json', instructions: 'x.',
      ownOptions: { n: { type: { kind: 'number', whole: true, values: [{ value: -1 }, { value: 5 }] }, default: 5 } },
      sql: { postgres: 'geometry({n})' },
    }))).toContain('Give it a CLOSED type');
    // …while a set whose members are ALL tokens is accepted, and every one of
    // them is then writable on a column.
    const ok = createRegistry().registerFieldType({
      name: 'Srid', base: 'json', instructions: 'x.',
      ownOptions: { n: { type: { kind: 'number', whole: true, values: [{ value: 4326 }, { value: 3857 }] }, default: 4326 } },
      sql: { postgres: 'geometry({n})' },
    });
    for (const n of [4326, 3857]) {
      expect(ok.dialect('postgres')!.sqlTypeFor(ok.parseFieldType({ kind: 'json', as: 'Srid', with: { n } })))
        .toBe(`geometry(${n})`);
    }
  });
});

describe('the small edges a model-facing message walks into', () => {
  it('a declaration key that is an OBJECT PROTOTYPE member reads as unknown, not as a native function', () => {
    // `RELOCATED_KEYS` was an object literal indexed by an arbitrary caller key,
    // so a declaration carrying `toString` produced *"It moved to function
    // toString() { [native code] }"* in a message a model reads.
    const message = refusal(() => createRegistry().registerFieldType(
      { ...geometryDecl, toString: 'oops' } as unknown as FieldTypeRefinementDef));
    expect(message).toContain('Unknown declaration key `toString`');
    expect(message).not.toContain('native code');
  });

  it('an OBJECT-valued option is canonicalized at every DEPTH, so key order is not identity', () => {
    // The bag's own keys were sorted for exactly this reason and the sorting
    // stopped one level down, so two columns whose option objects differed only
    // in key order were two different types with NO MEET. No law caught it —
    // both directions agreed on `undefined` — which is why it has to be
    // structural rather than left to a property to notice.
    const registry = createRegistry().registerFieldType({
      name: 'Meta', base: 'json', instructions: 'x.',
      ownOptions: { meta: { type: { kind: 'json' } } },
    });
    const a = registry.parseFieldType({ kind: 'json', as: 'Meta', with: { meta: { a: 1, b: 2 } } });
    const b = registry.parseFieldType({ kind: 'json', as: 'Meta', with: { meta: { b: 2, a: 1 } } });
    expect(JSON.stringify(a.toJSON())).toBe(JSON.stringify(b.toJSON()));
    expect(a.meet(b)?.toJSON()).toEqual(a.toJSON());
  });

  it('NOTES a comparability edge that crosses BASE kinds', () => {
    // Legitimate — it is what `number`/`money` does natively — but far more often
    // a typo, and the emitted predicate compares a json column to a text one for
    // the database to make what it can of.
    const registry = createRegistry()
      .registerFieldType({ name: 'Shape', base: 'json', instructions: 'A shape.' })
      .registerFieldType({ name: 'Label', base: 'text', instructions: 'A label.', comparableWith: ['Shape'] });
    const note = registry.fieldTypeComparabilityNotes().find((x) => x.code === 'field-type.cross-base-comparability');
    expect(note?.severity).toBe('warning');
    expect(note!.message).toContain('across DIFFERENT base kinds');
    // The edge is still RECORDED — the note says "look at this", not "refused".
    expect(registry.fieldTypeRefinement('Shape')!.comparableTo('Label')).toBe(true);
    // …and a SAME-base edge files no such note.
    const same = createRegistry()
      .registerFieldType({ name: 'A', base: 'json', instructions: 'a.' })
      .registerFieldType({ name: 'B', base: 'json', instructions: 'b.', comparableWith: ['A'] });
    expect(same.fieldTypeComparabilityNotes().map((x) => x.code))
      .not.toContain('field-type.cross-base-comparability');
  });
});

/** Type-level guard: the def branch really does carry both refinement keys. */
const _withIsOnTheBranch: FieldTypeDef = { kind: 'json', as: 'Geometry', with: { srid: 4326 } };
void _withIsOnTheBranch;
