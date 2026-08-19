/**
 * REGISTERED OPERATORS — `registerOperator` + the `operator` expr kind.
 *
 * The worked example throughout is PostGIS, because it exercises every part at
 * once: `&&` is infix with NO call form and no builtin equivalent, `<->` returns
 * a BUILTIN type from two registered ones, both are declared over a `Geometry`
 * refinement that itself declares `compare: { ordering: false }`, and neither
 * has any portable ANSI form — so the dialect refusal is a real case rather than
 * a constructed one.
 *
 * What this file is pinning, beyond "it works":
 *
 *  - the DECLARATION is where every defect is refused, including the ones that
 *    would otherwise only appear as bad SQL (an unbalanced template, a dropped
 *    operand, a comment sequence);
 *  - a bare bind param takes its type from the DECLARED operand — the A22 road,
 *    on the new kind, so the operator half cannot regress independently;
 *  - a dialect with no template REFUSES rather than degrading, which is the one
 *    place this feature deliberately behaves unlike `emitBuiltinCall`;
 *  - `compare` and operators are DISJOINT: `Geometry` refuses `=` and `<` and
 *    still accepts `&&`, which is the whole reason an honest `compare`
 *    declaration is usable.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry, type Registry } from '../registry';
import { QueryEngine } from '../engine';
import { QueryTypeError, Problems } from '../problem';
import { checkOperator, checkLatticeLaws, topsByKind } from '../conformance';
import { OperatorExpr } from '../exprs/operator';
import { describeOperators, describeEngine } from '../llm/describe';
import { buildSchemas } from '../llm/schemas';
import { exprKindApplicable, selectFunctions } from '../schema-build';
import { Value } from '../runtime/value';
import { arrayExecutor } from '../runtime/executor';
import type { FieldType } from '../field-type';
import type { OperatorDef } from '../operator';
import type { FieldTypeRefinementDef } from '../refinement';
import type { ExprDef, QueryDef, SelectDef, TypeDef } from '../schema';

// ─── The worked PostGIS registry ─────────────────────────────────────────────

/** The `Geometry` refinement both worked operators are declared over. */
const GEOMETRY: FieldTypeRefinementDef = {
  name: 'Geometry',
  base: 'json',
  instructions:
    'A PostGIS geometry, carried as GeoJSON. Compare two geometries with ST_Contains / ST_Within or ' +
    'the && operator, and order by distance with <->; `=` and `<` are not defined on one.',
  ownOptions: {
    subtype: { type: { kind: 'text', values: [{ value: 'Point' }, { value: 'Polygon' }] }, default: 'Point' },
    srid: { type: { kind: 'number', whole: true }, default: 4326 },
  },
  sql: { postgres: 'geometry({subtype},{srid})' },
  cast: { postgres: 'ST_GeomFromGeoJSON({value})::geometry({subtype},{srid})' },
  compare: { equality: false, ordering: false, textMatch: false },
};

/** `&&` — bounding-box overlap. Infix, no call form, no portable equivalent. */
const OVERLAPS: OperatorDef = {
  name: '&&',
  operands: [
    { name: 'left', type: { kind: 'json', as: 'Geometry' } },
    { name: 'right', type: { kind: 'json', as: 'Geometry' } },
  ],
  output: { kind: 'bool' },
  instructions:
    'Bounding-box overlap between two geometries. Cheap and GiST-index-assisted; use it as a pre-filter ' +
    'before an exact ST_Contains / ST_Within.',
  emit: { postgres: '({left} && {right})' },
  selectivity: 0.1,
  examples: [
    JSON.stringify({
      kind: 'operator',
      op: '&&',
      args: {
        left: { kind: 'field-ref', source: 'parcel', field: 'shape' },
        right: { kind: 'param', name: 'box' },
      },
    }),
  ],
};

/** `<->` — distance. Two registered operands, a BUILTIN result. */
const DISTANCE: OperatorDef = {
  name: '<->',
  operands: [
    { name: 'left', type: { kind: 'json', as: 'Geometry' } },
    { name: 'right', type: { kind: 'json', as: 'Geometry' } },
  ],
  output: { kind: 'number' },
  instructions: 'Distance between two geometries, in the SRID unit. In ORDER BY it uses a KNN index scan.',
  emit: { postgres: '({left} <-> {right})' },
};

const parcelTypeDef: TypeDef = {
  name: 'parcel',
  count: 250_000,
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text', maxLength: 200 } },
    { name: 'shape', type: { kind: 'json', as: 'Geometry', with: { subtype: 'Polygon' } } },
  ],
};

/** A registry with `Geometry`, both operators, and a `parcel` Type over them. */
function geoRegistry(): Registry {
  const registry = createRegistry();
  registry.registerFieldType(GEOMETRY);
  registry.registerOperator(OVERLAPS);
  registry.registerOperator(DISTANCE);
  registry.registerType(registry.parseType(parcelTypeDef));
  return registry;
}

/** The `geoRegistry` behind an engine. */
function geoEngine(): QueryEngine {
  return new QueryEngine(geoRegistry());
}

/** A registry carrying only `Geometry` — for declarations under test. */
function baseRegistry(): Registry {
  return createRegistry().registerFieldType(GEOMETRY);
}

/** The error a thrown `QueryTypeError` carries, as `code` + `message`. */
function refusal(fn: () => unknown): { code: string; message: string; path: (string | number)[] } {
  try {
    fn();
  } catch (err) {
    if (err instanceof QueryTypeError) return err.problem;
    throw err;
  }
  throw new Error('expected a QueryTypeError, but nothing was thrown');
}

/** `OVERLAPS` with `patch` applied — one field changed per refusal test. */
function overlapsWith(patch: Record<string, unknown>): OperatorDef {
  return { ...OVERLAPS, ...patch } as OperatorDef;
}

/** A SELECT over `parcel` with the supplied clauses. */
function parcelSelect(clauses: Partial<SelectDef>): QueryDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'parcel', field: 'name' } }],
    from: { kind: 'type', type: 'parcel' },
    ...clauses,
  };
}

/** `shape && :box`, as an `ExprDef`. */
const SHAPE_OVERLAPS_BOX: ExprDef = {
  kind: 'operator',
  op: '&&',
  args: {
    left: { kind: 'field-ref', source: 'parcel', field: 'shape' },
    right: { kind: 'param', name: 'box' },
  },
};

// ─── Registration ────────────────────────────────────────────────────────────

describe('registerOperator — the declaration is where a defect is refused', () => {
  it('registers the worked PostGIS pair and exposes them by name', () => {
    const registry = geoRegistry();
    expect(registry.operatorNames()).toEqual(['&&', '<->']);
    expect(registry.operator('&&')?.instructions).toContain('Bounding-box overlap');
    expect(registry.operator('&&')?.dialects()).toEqual(['postgres']);
    expect(registry.operator('<->')?.output.resolve()).toBe('number');
    // A declaration round-trips as ITSELF — a consumer that persisted it reads
    // back what it wrote.
    expect(registry.operator('&&')?.toJSON()).toBe(OVERLAPS);
  });

  it('refuses a name that is not SQL operator punctuation', () => {
    for (const name of ['overlaps', 'ST_Overlaps', '', '&& x', 'a&&']) {
      expect(refusal(() => baseRegistry().registerOperator(overlapsWith({ name }))).code).toBe(
        'operator.bad-declaration',
      );
    }
    // …and says WHY a word is not an option, since a word operator is the first
    // thing a declarer coming from `registerFunction` reaches for.
    expect(refusal(() => baseRegistry().registerOperator(overlapsWith({ name: 'overlaps' }))).message).toContain(
      'A WORD operator is spelled either as a function',
    );
  });

  it('refuses a COMMENT sequence in a name, which the punctuation charset alone admits', () => {
    // `&&--` matches OPERATOR_NAME_PATTERN exactly: every character is in the
    // charset. Emitted, it comments out the rest of the query.
    const problem = refusal(() => baseRegistry().registerOperator(overlapsWith({ name: '&&--' })));
    expect(problem.code).toBe('operator.bad-declaration');
    expect(problem.message).toContain('opens (or closes) a SQL COMMENT');
  });

  it('refuses a SECOND declaration of one name, and says who holds it', () => {
    const named = baseRegistry().registerOperator({ ...OVERLAPS, declaredBy: '@acme/postgis' });
    expect(refusal(() => named.registerOperator(OVERLAPS)).message).toContain(
      'already registered as an operator by @acme/postgis',
    );
    // An incumbent that named no declarer still refuses; it just cannot say who.
    const anonymous = baseRegistry().registerOperator(OVERLAPS);
    expect(refusal(() => anonymous.registerOperator(OVERLAPS)).message).toContain(
      '`&&` is already registered as an operator. The second declaration is refused',
    );
  });

  it('refuses an unknown declaration key, and names the DECLINED ones with their reason', () => {
    expect(refusal(() => baseRegistry().registerOperator(overlapsWith({ emitt: {} }))).message).toContain(
      'did you mean `emit`?',
    );
    // The three §6 members this release deliberately does not ship each refuse
    // with the reason, so a declarer copying the design plan is told rather than
    // left to wonder which spelling was wrong.
    for (const [key, fragment] of [
      ['precedence', 'nothing reads a precedence'],
      ['indexed', 'declare `selectivity` instead'],
      ['changes', 'silently ignored'],
    ] as const) {
      expect(refusal(() => baseRegistry().registerOperator(overlapsWith({ [key]: 1 }))).message).toContain(fragment);
    }
  });

  it('requires non-empty `instructions`', () => {
    for (const instructions of ['', '   ', undefined]) {
      const problem = refusal(() => baseRegistry().registerOperator(overlapsWith({ instructions })));
      expect(problem.path).toEqual(['registerOperator', '&&', 'instructions']);
    }
  });

  it('refuses a `selectivity` that is not a fraction', () => {
    for (const selectivity of [-0.1, 1.5, Number.NaN]) {
      expect(refusal(() => baseRegistry().registerOperator(overlapsWith({ selectivity }))).message).toContain(
        'must be between 0 and 1',
      );
    }
  });

  it('refuses an operand list that could not be called', () => {
    // No operands at all — that is a zero-argument FUNCTION.
    expect(refusal(() => baseRegistry().registerOperator(overlapsWith({ operands: [] }))).message).toContain(
      'registerFunction',
    );
    // A malformed entry, a bad name, and a duplicate.
    expect(refusal(() => baseRegistry().registerOperator(overlapsWith({ operands: [null] }))).message).toContain(
      '`{ name, type }`',
    );
    expect(
      refusal(() =>
        baseRegistry().registerOperator(overlapsWith({ operands: [{ name: 'a-b', type: 'any' }] })),
      ).message,
    ).toContain('template slot name');
    expect(
      refusal(() =>
        baseRegistry().registerOperator(
          overlapsWith({ operands: [{ name: 'left', type: 'any' }, { name: 'left', type: 'any' }] }),
        ),
      ).message,
    ).toContain('declared twice');
  });

  it('refuses an operand or output type that does not parse, naming the operand', () => {
    // A bare registry has no `Geometry`, so the operand's `as` is unknown there.
    const problem = refusal(() => createRegistry().registerOperator(OVERLAPS));
    expect(problem.path).toEqual(['registerOperator', '&&', 'operands', 0, 'type']);
    expect(problem.message).toContain('Unknown field-type refinement');
    expect(
      refusal(() => baseRegistry().registerOperator(overlapsWith({ output: { kind: 'nope' } }))).path,
    ).toEqual(['registerOperator', '&&', 'output']);
  });

  it("does NOT freeze the refinement vocabulary — a field type may still be registered after an operator", () => {
    const registry = baseRegistry().registerOperator(OVERLAPS);
    expect(() =>
      registry.registerFieldType({ name: 'Geography', base: 'json', instructions: 'A PostGIS geography.' }),
    ).not.toThrow();
  });
});

describe('registerOperator — the emit template', () => {
  const withEmit = (emit: unknown): OperatorDef => overlapsWith({ emit });

  it('requires SQL for at least one dialect, and shows the shape', () => {
    for (const emit of [undefined, {}]) {
      expect(refusal(() => baseRegistry().registerOperator(withEmit(emit))).message).toContain(
        "{ postgres: '({left} && {right})' }",
      );
    }
  });

  it('refuses a non-string / empty template', () => {
    for (const template of [undefined, '', '   ', 7]) {
      expect(
        refusal(() => baseRegistry().registerOperator(withEmit({ postgres: template }))).message,
      ).toContain('must be a non-empty string');
    }
  });

  it('refuses a template that is not wrapped in its OWN parentheses', () => {
    // Unwrapped — composes wrongly under any surrounding operator.
    expect(
      refusal(() => baseRegistry().registerOperator(withEmit({ postgres: '{left} && {right}' }))).message,
    ).toContain('must be wrapped in its own balanced parentheses');
    // Starts with `(` and ends with `)` but the pair is NOT the same one — the
    // case a naive startsWith/endsWith check accepts.
    expect(
      refusal(() => baseRegistry().registerOperator(withEmit({ postgres: '({left}) && ({right})' }))).message,
    ).toContain('must be wrapped in its own balanced parentheses');
    // Unbalanced in the other direction.
    expect(
      refusal(() => baseRegistry().registerOperator(withEmit({ postgres: '({left} && {right}))' }))).message,
    ).toContain('must be wrapped in its own balanced parentheses');
    expect(
      refusal(() => baseRegistry().registerOperator(withEmit({ postgres: ')({left} && {right}(' }))).message,
    ).toContain('must be wrapped in its own balanced parentheses');
    // A function-shaped emission is written WITH the redundant pair, and passes.
    expect(() =>
      baseRegistry().registerOperator(withEmit({ postgres: '(ST_Intersects({left}, {right}))' })),
    ).not.toThrow();
  });

  it('refuses a comment sequence, a statement terminator, and an unterminated string literal', () => {
    expect(
      refusal(() => baseRegistry().registerOperator(withEmit({ postgres: '({left} && {right} --x)' }))).message,
    ).toContain('A minus followed by a negation is written `- -`');
    // A BLOCK comment is the same failure with a different remedy sentence.
    expect(
      refusal(() => baseRegistry().registerOperator(withEmit({ postgres: '({left} /*x*/ && {right})' }))).message,
    ).toContain('Write the fragment without a comment.');
    expect(
      refusal(() => baseRegistry().registerOperator(withEmit({ postgres: '({left} && {right}); DROP TABLE t' })))
        .message,
    ).toContain('ends that statement early');
    expect(
      refusal(() => baseRegistry().registerOperator(withEmit({ postgres: "({left} && {right} || 'x)" }))).message,
    ).toContain('odd number of');
    // A BALANCED pair of quotes is ordinary SQL and is allowed.
    expect(() =>
      baseRegistry().registerOperator(withEmit({ postgres: "({left} && ST_GeomFromText('POINT(0 0)', {right}))" })),
    ).not.toThrow();
  });

  it('refuses a slot naming no operand, with a didYouMean', () => {
    const problem = refusal(() => baseRegistry().registerOperator(withEmit({ postgres: '({lft} && {right})' })));
    expect(problem.message).toContain('did you mean `left`?');
    expect(problem.message).toContain('(declared: left, right)');
  });

  it('refuses a template that DROPS a declared operand', () => {
    const problem = refusal(() => baseRegistry().registerOperator(withEmit({ postgres: '({left} IS NOT NULL)' })));
    expect(problem.message).toContain('never names `{right}`');
    expect(problem.message).toContain('the query would supply an expression the SQL never mentions');
  });

  it('builds the "you need an emit" example from the declaration\'s OWN operand names', () => {
    // A UNARY operator, so the example cannot be a hardcoded `left`/`right`.
    const unary: OperatorDef = {
      ...OVERLAPS,
      name: '@',
      operands: [{ name: 'value', type: 'any' }],
      emit: {},
    };
    expect(refusal(() => baseRegistry().registerOperator(unary)).message).toContain(
      "{ postgres: '({value})' }",
    );
  });

  it('accepts a MULTI-dialect declaration and reports both', () => {
    const registry = baseRegistry().registerOperator(
      withEmit({ postgres: '({left} && {right})', base: '(ST_Intersects({left}, {right}))' }),
    );
    expect(registry.operator('&&')?.dialects()).toEqual(['postgres', 'base']);
  });
});

describe('registerOperatorRun', () => {
  it('refuses a run for an operator that is not registered', () => {
    const problem = refusal(() => geoRegistry().registerOperatorRun('&&&', () => Value.null()));
    expect(problem.code).toBe('operator.unknown');
    expect(problem.message).toContain('(registered: &&, <->)');
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

/** Every problem of `query` on `engine`, as `code: message`. */
function problemsOf(engine: QueryEngine, query: QueryDef): string[] {
  return engine.validateQuery(query).list.map((p) => `${p.code}: ${p.message}`);
}

describe('the `operator` expr — validation', () => {
  it('validates the worked PostGIS query clean, and types the param from the OPERAND', () => {
    const engine = geoEngine();
    const query = parcelSelect({
      where: [SHAPE_OVERLAPS_BOX],
      order: [
        {
          expr: {
            kind: 'operator',
            op: '<->',
            args: {
              left: { kind: 'field-ref', source: 'parcel', field: 'shape' },
              right: { kind: 'param', name: 'here' },
            },
          },
          dir: 'asc',
        },
      ],
      limit: 10,
    });
    expect(problemsOf(engine, query)).toEqual([]);
    // The A22 road on the new kind: a BARE param takes its type from the
    // declared operand rather than being judged against the `text` placeholder.
    // The type is the OPERAND's, not the column's — so it carries no `with` bag
    // and takes `Geometry`'s declared defaults, which is right: `&&` accepts any
    // geometry, and narrowing the param to the one column it happened to sit
    // beside would refuse a second use against a different SRID.
    const params = engine.parameters(query);
    expect(params.map((p) => [p.name, p.type?.toJSON()])).toEqual([
      ['box', { kind: 'json', as: 'Geometry' }],
      ['here', { kind: 'json', as: 'Geometry' }],
    ]);
  });

  it('is ORDER-INDEPENDENT about a param used as an operand (the A22 property)', () => {
    const engine = geoEngine();
    const overlap = SHAPE_OVERLAPS_BOX;
    const isNull: ExprDef = { kind: 'is-null', value: { kind: 'param', name: 'box' } };
    expect(problemsOf(engine, parcelSelect({ where: [overlap, isNull] }))).toEqual([]);
    expect(problemsOf(engine, parcelSelect({ where: [isNull, overlap] }))).toEqual([]);
  });

  it('reports an unknown operator with a didYouMean, and says it is not a function', () => {
    const problems = problemsOf(geoEngine(), parcelSelect({ where: [{ ...SHAPE_OVERLAPS_BOX, op: '&&&' }] }));
    expect(problems[0]).toContain('operator.unknown: Unknown operator');
    expect(problems[0]).toContain('did you mean `&&`?');
    expect(problems[0]).toContain('An operator is not a function');
  });

  it('reports a missing / unknown / wrongly-typed operand in the OPERATOR vocabulary', () => {
    const engine = geoEngine();
    const shape: ExprDef = { kind: 'field-ref', source: 'parcel', field: 'shape' };
    expect(problemsOf(engine, parcelSelect({ where: [{ kind: 'operator', op: '&&', args: { left: shape } }] })))
      .toEqual(["operator.missing-arg: Operator '&&' is missing required operand 'right'."]);
    expect(
      problemsOf(
        engine,
        parcelSelect({ where: [{ kind: 'operator', op: '&&', args: { left: shape, rigt: shape } }] }),
      ),
    ).toEqual([
      "operator.missing-arg: Operator '&&' is missing required operand 'right'.",
      "operator.unknown-arg: Operator '&&' has no operand named 'rigt'. — did you mean `right`?",
    ]);
    expect(
      problemsOf(
        engine,
        parcelSelect({
          where: [
            {
              kind: 'operator',
              op: '&&',
              args: { left: shape, right: { kind: 'field-ref', source: 'parcel', field: 'name' } },
            },
          ],
        }),
      ),
    ).toEqual(["operator.arg-type: Operand 'right' of '&&' expects json, got text."]);
  });

  it('degrades to a nullable text placeholder for an UNREGISTERED operator, and costs nothing extra', () => {
    // The resolve / cost / selectivity fallbacks: an unknown operator is
    // REPORTED by validation, so every other surface has to keep answering
    // rather than throwing at it.
    const engine = geoEngine();
    const unknown: ExprDef = { ...SHAPE_OVERLAPS_BOX, op: '&&&' };
    expect(engine.resolveExpr(unknown).kind).toBe('computed');
    const costed = engine.cost(parcelSelect({ where: [unknown] }));
    // No declared selectivity and no declared cost — every row survives.
    expect(costed.rows).toBe(250_000);
    // …and an engine with NO operators at all says so instead of listing none.
    const bare = new QueryEngine(createRegistry());
    expect(bare.validateExpr(unknown).list.map((p) => p.message).join(' ')).toContain(
      'no operator is registered on this engine',
    );
  });

  it('resolves to the DECLARED output type, never inferred from the operands', () => {
    const engine = geoEngine();
    // `<->` takes two `json as Geometry` and produces a NUMBER — so comparing it
    // to a numeric param is legal and types that param as a number.
    const query = parcelSelect({
      where: [
        {
          kind: 'comparison',
          op: '<',
          left: {
            kind: 'operator',
            op: '<->',
            args: {
              left: { kind: 'field-ref', source: 'parcel', field: 'shape' },
              right: { kind: 'param', name: 'here' },
            },
          },
          right: { kind: 'param', name: 'maxDistance' },
        },
      ],
    });
    expect(problemsOf(engine, query)).toEqual([]);
    const distance = engine.parameters(query).find((p) => p.name === 'maxDistance');
    expect(distance?.type?.resolve()).toBe('number');
  });

  it('is DISJOINT from a type\'s declared `compare` — the whole reason an honest declaration is usable', () => {
    const engine = geoEngine();
    const shape: ExprDef = { kind: 'field-ref', source: 'parcel', field: 'shape' };
    // `Geometry` declares every comparison arm false, so `=` and `<` are refused
    // with the type's own instructions…
    const compared = problemsOf(engine, parcelSelect({ where: [{ kind: 'comparison', op: '=', left: shape, right: shape }] }));
    expect(compared[0]).toContain('comparison.type: Cannot compare `Geometry` values with \'=\'');
    expect(compared[0]).toContain('the && operator');
    // …and `&&` over the very same column is clean. If `compare` gated operators
    // too, declaring the truth about a geometry would delete the mechanism that
    // makes it queryable.
    expect(problemsOf(engine, parcelSelect({ where: [SHAPE_OVERLAPS_BOX] }))).toEqual([]);
  });
});

// ─── SQL ─────────────────────────────────────────────────────────────────────

describe('the `operator` expr — SQL', () => {
  it('emits the declared template with the operands spliced by NAME', () => {
    const engine = geoEngine();
    const sql = engine.toSQL(
      parcelSelect({
        fields: [
          { expr: { kind: 'field-ref', source: 'parcel', field: 'name' } },
          {
            expr: {
              kind: 'operator',
              op: '<->',
              args: {
                left: { kind: 'field-ref', source: 'parcel', field: 'shape' },
                right: { kind: 'param', name: 'here' },
              },
            },
            as: 'distance',
          },
        ],
        where: [SHAPE_OVERLAPS_BOX],
        limit: 10,
      }),
      'postgres',
      { params: { here: { type: 'Point', coordinates: [0, 0] }, box: { type: 'Polygon', coordinates: [] } } },
    );
    // A PRE-EXISTING LIMIT, pinned here because this is where it shows: a bound
    // PARAM carrying a document emits the BASE cast (`CAST($1 AS jsonb)`), not
    // the refinement's declared `cast`. `ParamExpr.toSQL` calls
    // `dialect.jsonValue(raw)` with no field type, and it has none to pass:
    // `engine.toSQL` builds a fresh scope and runs no inference walk, so a
    // param's inferred type does not exist at emit time. It is not specific to
    // operators — the same param under `ST_Contains(a, b)` emits the same cast —
    // and the fix (threading a declared / inferred type into every param
    // binding) changes the emitted SQL of every existing `json` param. The
    // COLUMN side is unaffected and already carries its declared type.
    expect(sql.sql).toBe(
      'SELECT "parcel"."name" AS "name", ' +
        '("parcel"."shape" <-> CAST($1 AS jsonb)) AS "distance" ' +
        'FROM "parcel" AS "parcel" ' +
        'WHERE ("parcel"."shape" && CAST($2 AS jsonb)) ' +
        'LIMIT 10',
    );
  });

  it('emits the refinement cast for a LITERAL operand, which does carry its column type', () => {
    // The other half of the limit above: a `write` cell knows its column, so the
    // declared `cast` template does fire there — the mechanism works, and it is
    // the PARAM road that cannot reach a type at emit.
    const sql = geoEngine().toSQL(
      {
        kind: 'update',
        type: 'parcel',
        set: { shape: { kind: 'literal', value: { type: 'Polygon', coordinates: [] } } },
        where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'parcel', field: 'id' }, right: { kind: 'literal', value: 1 } }],
      },
      'postgres',
    );
    expect(sql.sql).toContain('ST_GeomFromGeoJSON($1)::geometry(Polygon,4326)');
  });

  it('REFUSES a dialect it declares no template for, rather than degrading', () => {
    const engine = geoEngine();
    const problem = refusal(() =>
      engine.toSQL(parcelSelect({ where: [SHAPE_OVERLAPS_BOX] }), 'base', { params: { box: {} } }),
    );
    expect(problem.code).toBe('operator.unsupported-dialect');
    expect(problem.message).toContain('declares SQL only for `postgres`; this engine emits `base`');
    expect(problem.message).toContain('REFUSED rather than degraded');
  });

  it('refuses to emit an UNKNOWN operator, and an operator missing an operand its template places', () => {
    const engine = geoEngine();
    // Both are only reachable by emitting a query that was never validated —
    // and both refuse rather than emitting something plausible.
    expect(
      refusal(() =>
        engine.toSQL(parcelSelect({ where: [{ ...SHAPE_OVERLAPS_BOX, op: '&&&' }] }), 'postgres', {
          params: { box: {} },
        }),
      ).code,
    ).toBe('operator.unknown');
    const missing = refusal(() =>
      engine.toSQL(
        parcelSelect({
          where: [
            {
              kind: 'operator',
              op: '&&',
              args: { left: { kind: 'field-ref', source: 'parcel', field: 'shape' } },
            },
          ],
        }),
        'postgres',
      ),
    );
    expect(missing.code).toBe('operator.missing-arg');
    expect(missing.path).toEqual(['args', 'right']);
  });
});

// ─── Cost ────────────────────────────────────────────────────────────────────

describe('the `operator` expr — cost', () => {
  it('applies the DECLARED selectivity, and the default keeps every row', () => {
    const engine = geoEngine();
    // `&&` declares 0.1 over 250_000 parcels.
    expect(engine.cost(parcelSelect({ where: [SHAPE_OVERLAPS_BOX] })).rows).toBe(25_000);
    // A comparison over `<->` (which declares no selectivity) contributes only
    // the comparison's own range estimate, not an operator one.
    const undeclared = engine.cost(
      parcelSelect({
        where: [
          {
            kind: 'comparison',
            op: '<',
            left: {
              kind: 'operator',
              op: '<->',
              args: {
                left: { kind: 'field-ref', source: 'parcel', field: 'shape' },
                right: { kind: 'param', name: 'here' },
              },
            },
            right: { kind: 'param', name: 'maxDistance' },
          },
        ],
      }),
    ).rows;
    expect(undeclared).toBe(125_000);
  });

  it('adds a declared intrinsic cost on top of its operands', () => {
    const registry = baseRegistry().registerOperator({ ...OVERLAPS, cost: { rows: 3, bytes: 1_000_000 } });
    registry.registerType(registry.parseType(parcelTypeDef));
    const withCost = new QueryEngine(registry).cost(parcelSelect({ where: [SHAPE_OVERLAPS_BOX] }));
    const without = geoEngine().cost(parcelSelect({ where: [SHAPE_OVERLAPS_BOX] }));
    expect(withCost.rows).toBe(without.rows + 3);
    expect(withCost.bytes).toBeGreaterThan(without.bytes);
  });
});

// ─── Runtime ─────────────────────────────────────────────────────────────────

describe('the `operator` expr — the in-memory road', () => {
  /** An engine over two in-memory parcels, with `&&` implemented. */
  function runtimeEngine(withRun: boolean): QueryEngine {
    const registry = geoRegistry();
    if (withRun) {
      // A stand-in for a real bbox test: "the two share a coordinate".
      registry.registerOperatorRun('&&', (args) => {
        const left = args['left']?.raw;
        const right = args['right']?.raw;
        return Value.of(JSON.stringify(left) === JSON.stringify(right));
      });
    }
    return new QueryEngine(registry, {
      executors: {
        parcel: arrayExecutor([
          { id: 1, name: 'north', shape: { type: 'Polygon', coordinates: [1] } },
          { id: 2, name: 'south', shape: { type: 'Polygon', coordinates: [2] } },
        ]),
      },
    });
  }

  it('runs a registered implementation', async () => {
    const result = await runtimeEngine(true).run(parcelSelect({ where: [SHAPE_OVERLAPS_BOX] }), {
      params: { box: { type: 'Polygon', coordinates: [1] } },
    });
    expect(result.rows.map((r) => r['name'])).toEqual(['north']);
  });

  it('answers NULL when no implementation is registered (a SQL-road operator)', async () => {
    const result = await runtimeEngine(false).run(parcelSelect({ where: [SHAPE_OVERLAPS_BOX] }), {
      params: { box: { type: 'Polygon', coordinates: [1] } },
    });
    // A NULL predicate is UNKNOWN, so no row survives — and nothing throws.
    expect(result.rows).toEqual([]);
  });
});

// ─── Round trip ──────────────────────────────────────────────────────────────

describe('the `operator` expr — round trip', () => {
  const def: ExprDef = SHAPE_OVERLAPS_BOX;

  it('parses, clones and serializes back to exactly its def', () => {
    const registry = geoRegistry();
    const expr = registry.parseExpr(def);
    expect(expr.toJSON()).toEqual(def);
    expect(expr.clone().toJSON()).toEqual(def);
    expect(expr.toCode()).toBe('&&(left: parcel.shape, right: :box)');
  });

  it('survives the DEFENSIVE structural parser, which the wire road actually uses', () => {
    const problems = new Problems();
    const expr = geoRegistry().parseCheckedExpr(def, problems);
    expect(problems.list).toEqual([]);
    expect(expr).toBeInstanceOf(OperatorExpr);
    expect(expr?.toJSON()).toEqual(def);
  });

  it('reports a structurally bad def rather than throwing', () => {
    const problems = new Problems();
    expect(geoRegistry().parseCheckedExpr({ kind: 'operator', op: 7, args: {} }, problems)).toBeUndefined();
    expect(problems.list.map((p) => p.code)).toContain('shape.type');
  });

  it('refuses a mismatched kind through `from`', () => {
    expect(() => OperatorExpr.from({ kind: 'literal', value: 1 }, geoRegistry())).toThrow(/expected 'operator'/);
  });
});

// ─── What the model is told ──────────────────────────────────────────────────

describe('what a model is told about a registered operator', () => {
  it('renders an `operators:` block with signatures, refinement names and examples', () => {
    const text = describeOperators(geoEngine());
    expect(text).toContain('operators:');
    // The operand tag is the FULL one the field description uses — the declared
    // options AND the refused comparison arms — because "which of these two
    // `json`s does `&&` take, and what may I not do with it" is exactly the
    // question a model has while choosing.
    const geometry = 'json(as Geometry,subtype=Point,srid=4326,no =,no <,no LIKE)';
    expect(text).toContain(`- &&(left: ${geometry}, right: ${geometry}) → bool — Bounding-box overlap`);
    expect(text).toContain(`- <->(left: ${geometry}, right: ${geometry}) → number`);
    // The declared example is rendered verbatim under the signature.
    expect(text).toContain('"op":"&&"');
  });

  it('says so plainly when a registry has none, and OMITS the block from `describeEngine`', () => {
    expect(describeOperators(createRegistry())).toBe('operators: (none registered)');
    const bare = describeEngine(createRegistry());
    expect(bare).not.toContain('operators:');
    expect(describeEngine(geoEngine())).toContain('operators:');
  });

  it('honours a caller override for an operator, by name', () => {
    const text = describeOperators(geoEngine(), 2, { instructions: { '&&': 'OUR OWN NOTE.' } });
    expect(text).toContain('→ bool — OUR OWN NOTE.');
    // An override that BLANKS the line renders the bare signature. Only an
    // override can produce this: `instructions` is required and non-empty at
    // registration.
    expect(describeOperators(geoEngine(), 2, { instructions: { '&&': '' } })).toContain('→ bool\n');
  });

  it('renders an `any` operand as `any`, in both the description and the schema glossary', () => {
    const registry = baseRegistry().registerOperator({
      ...OVERLAPS,
      operands: [{ name: 'left', type: { kind: 'json', as: 'Geometry' } }, { name: 'right', type: 'any' }],
    });
    registry.registerType(registry.parseType(parcelTypeDef));
    expect(describeOperators(new QueryEngine(registry))).toContain('right: any) → bool');
    // The generated schema renders the same signature into the `op` enum's
    // glossary; asserting the enum still ACCEPTS the operator is what proves the
    // glossary was rendered without the schema's internals being spelled out
    // here (the union is lazy, so it has no readable shape until it is used).
    const schema = buildSchemas(registry, { depth: { functions: 'names' }, functions: 'none' });
    expect(schema.Expr.safeParse(SHAPE_OVERLAPS_BOX).success).toBe(true);
  });

  it('lists the `operator` kind in the expression catalog only when one is reachable', () => {
    expect(describeExprKinds(geoEngine())).toContain('operator');
    expect(describeExprKinds(new QueryEngine(createRegistry()))).not.toContain('- operator —');
  });

  /** The expression-catalog lines of an engine (for the gate assertions above). */
  function describeExprKinds(engine: QueryEngine): string {
    return describeEngine(engine).split('\n\n')[1] ?? '';
  }
});

describe('capability gating', () => {
  it('offers the `operator` kind only when a registered operand type is reachable', () => {
    const geo = geoRegistry();
    const selected = selectFunctions(geo, 'all');
    expect(exprKindApplicable('operator', geo.typeList(), selected, geo)).toBe(true);
    // The SAME operators, over a Type with no geometry column — a dead branch,
    // gated out.
    const noGeometry = createRegistry().registerFieldType(GEOMETRY).registerOperator(OVERLAPS);
    const noteTypeDef: TypeDef = { name: 'note', count: 10, fields: [{ name: 'body', type: { kind: 'text' } }] };
    noGeometry.registerType(noGeometry.parseType(noteTypeDef));
    expect(exprKindApplicable('operator', noGeometry.typeList(), selectFunctions(noGeometry, 'all'), noGeometry))
      .toBe(false);
    // No registry supplied at all ⇒ no operator branch (the safe answer).
    expect(exprKindApplicable('operator', geo.typeList(), selected)).toBe(false);
  });

  it('enum-locks `op` to the registered names, and strictens the operands at `typed` depth', () => {
    const geo = geoRegistry();
    // `functions: 'none'` throughout: the operator branches are what is under
    // test, and building the typed args of all 60+ builtin functions costs
    // seconds under coverage instrumentation for nothing this asserts.
    const build = (functions: 'open' | 'names' | 'typed') =>
      buildSchemas(geo, { depth: { functions }, functions: 'none' });
    const shape: ExprDef = SHAPE_OVERLAPS_BOX;
    const names = build('names');
    expect(names.Expr.safeParse(shape).success).toBe(true);
    expect(names.Expr.safeParse({ ...shape, op: '&&&' }).success).toBe(false);
    const typed = build('typed');
    expect(typed.Expr.safeParse(shape).success).toBe(true);
    // A misspelled OPERAND is refused by the schema itself at `typed`.
    expect(
      typed.Expr.safeParse({
        kind: 'operator',
        op: '&&',
        args: { left: { kind: 'field-ref', source: 'parcel', field: 'shape' }, rigt: { kind: 'param', name: 'b' } },
      }).success,
    ).toBe(false);
    // …and an `open` depth keeps the free-string shape, as a function call does.
    expect(build('open').Expr.safeParse({ ...shape, op: '&&&' }).success).toBe(true);
  });

  it('renders the free shape for a bare `toSchema()` with no registry', () => {
    expect(OperatorExpr.toSchema({}).safeParse(SHAPE_OVERLAPS_BOX).success).toBe(true);
  });
});

// ─── Conformance ─────────────────────────────────────────────────────────────

describe('checkOperator', () => {
  it('passes the worked PostGIS declarations', () => {
    for (const decl of [OVERLAPS, DISTANCE]) {
      const report = checkOperator(decl, { registry: baseRegistry() });
      expect(report.problems).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.lattice?.ok).toBe(true);
    }
  });

  it('reports a declaration that does not register at all', () => {
    // A bare registry has no `Geometry`, so the operand type is unresolvable.
    const report = checkOperator(OVERLAPS);
    expect(report.ok).toBe(false);
    expect(report.problems[0]?.code).toBe('operator.bad-declaration');
    expect(report.problems[0]?.message).toContain('Unknown field-type refinement');
    expect(report.lattice).toBeUndefined();
  });

  it('catches a MISSPELLED dialect key — a declaration nothing else can refuse', () => {
    const report = checkOperator(overlapsWith({ emit: { postgress: '({left} && {right})' } }), {
      registry: baseRegistry(),
    });
    expect(report.problems.map((p) => p.code)).toEqual(['conformance.unknown-dialect']);
    expect(report.problems[0]?.message).toContain('registered: base, postgres');
  });

  it('catches a shipped example that is malformed, foreign, or names the wrong operands', () => {
    const check = (examples: string[]): string[] =>
      checkOperator(overlapsWith({ examples }), { registry: baseRegistry() }).problems.map((p) => p.message);
    expect(check(['{not json'])[0]).toContain('not valid JSON');
    expect(check([JSON.stringify({ kind: 'nope' })])[0]).toContain('does not parse as an expression');
    expect(check([JSON.stringify({ kind: 'literal', value: 1 })])[0]).toContain('is not a use of `&&`');
    expect(
      check([JSON.stringify({ kind: 'operator', op: '&&', args: { left: { kind: 'param', name: 'a' } } })])[0],
    ).toContain('supplies operands left but `&&` declares left, right');
    expect(check([JSON.stringify({ kind: 'operator', op: '&&', args: {} })])[0]).toContain(
      'supplies operands (none) but `&&` declares left, right',
    );
  });
});

describe('an operator perturbs NOTHING about the lattice', () => {
  it('gives the same verdict over the Geometry type set with and without operators registered', () => {
    /** The lattice verdict over a `Geometry` set built on `registry`. */
    const verdict = (registry: Registry): unknown => {
      const types: Record<string, FieldType> = {
        geom: registry.parseFieldType({ kind: 'json', as: 'Geometry' }),
        geomPoint: registry.parseFieldType({ kind: 'json', as: 'Geometry', with: { subtype: 'Point' } }),
        geomPoly: registry.parseFieldType({ kind: 'json', as: 'Geometry', with: { subtype: 'Polygon' } }),
        ...topsByKind(),
      };
      return checkLatticeLaws(types, { registry }).failed;
    };
    const without = verdict(baseRegistry());
    const withOperators = verdict(baseRegistry().registerOperator(OVERLAPS).registerOperator(DISTANCE));
    expect(without).toEqual([]);
    expect(withOperators).toEqual(without);
  });
});
