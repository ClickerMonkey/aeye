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
import { describeOperators, describeEngine, describeTypes } from '../llm/describe';
import { buildSchemas } from '../llm/schemas';
import { exprKindApplicable, selectFunctions } from '../schema-build';
import { Value } from '../runtime/value';
import { arrayExecutor } from '../runtime/executor';
import type { FieldType } from '../field-type';
import type { OperatorDef } from '../operator';
import type { FieldTypeRefinementDef } from '../refinement';
import type { ExprDef, JsonValue, QueryDef, SelectDef, TypeDef } from '../schema';

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
  // `sql` — the CAST TARGET / column type — is per column and interpolates the
  // options. `cast` deliberately does NOT: it says only "this document IS a
  // geometry", which is the one thing true of a value in ANY position. A cast
  // carrying the typmod (`::geometry({subtype},{srid})`) is column-shaped, and
  // in a value position it pins a constraint the value never had to satisfy —
  // PostGIS then refuses a Polygon cast to `geometry(Point,4326)`. `Typed`
  // below is that shape, kept so both roads are exercised.
  sql: { postgres: 'geometry({subtype},{srid})' },
  cast: { postgres: 'ST_GeomFromGeoJSON({value})' },
  compare: { equality: false, ordering: false, textMatch: false },
};

/**
 * A refinement whose `cast` IS column-shaped — it interpolates an `ownOptions`
 * slot, so resolving it needs a value only a column has.
 *
 * The counterpart to `GEOMETRY` above, and the reason both exist: a write cell
 * may resolve those slots (a default is a fact about the column), a VALUE
 * position may not, and each road needs a type that reaches its arm.
 */
const TYPED: FieldTypeRefinementDef = {
  name: 'Typed',
  base: 'json',
  instructions: 'A geometry whose cast pins the column typmod — column-shaped, on purpose.',
  ownOptions: {
    subtype: { type: { kind: 'text', values: [{ value: 'Point' }, { value: 'Polygon' }] }, default: 'Point' },
  },
  cast: { postgres: 'ST_GeomFromGeoJSON({value})::geometry({subtype})' },
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

  it('refuses a `{` that opens no slot — the residue the scanner cannot see', () => {
    // `TEMPLATE_SLOT` only matches a CLOSED `{…}`, so an unclosed or nested
    // brace never reaches the unknown-slot resolver and would sail through as
    // literal text into emitted SQL — exactly what that refusal exists to
    // prevent, reached by the one road it cannot see.
    const unclosed = refusal(() => baseRegistry().registerOperator(withEmit({ postgres: '({left} && {right} {oops)' })));
    expect(unclosed.message).toContain('that opens no slot');
    expect(unclosed.message).toContain('(declared: left, right)');
    // A NESTED brace is the same failure: `{q` survives as literal text.
    expect(
      refusal(() => baseRegistry().registerOperator(withEmit({ postgres: '({left} && {right}{q{left}})' }))).message,
    ).toContain('that opens no slot');
    // …and it suggests a real operand when the stray brace looks like a typo.
    expect(
      refusal(() => baseRegistry().registerOperator(withEmit({ postgres: '({left} && {right} {rigt)' }))).message,
    ).toContain('did you mean `right`?');
  });

  it('accepts a legally-wrapped template containing an ASTRAL character', () => {
    // The paren walk indexes by UTF-16 code unit, because it compares against
    // `trimmed.length`, which is also UTF-16. Walking code POINTS instead made
    // the two disagree the moment a template held a surrogate pair, and the
    // closing `)` tripped the closed-early return — refusing a correctly wrapped
    // template with a message about parentheses, which is the wrong thing to
    // point a declarer at.
    // A BMP accented character always passed; the astral one is the regression.
    for (const template of ['({left} && {right} é)', '({left} && {right} 𝕏)']) {
      expect(() => baseRegistry().registerOperator(withEmit({ postgres: template }))).not.toThrow();
    }
    // The genuinely-unwrapped case is still refused, astral or not.
    expect(
      refusal(() => baseRegistry().registerOperator(withEmit({ postgres: '({left}) 𝕏 ({right})' }))).message,
    ).toContain('must be wrapped in its own balanced parentheses');
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
    // THE FLAGSHIP QUERY, AND IT HAS TO EXECUTE. A document operand — here a
    // bound PARAM — binds through the DECLARED operand type's own `cast`
    // template, not through the dialect's default json cast. Emitted the other
    // way (`CAST($1 AS jsonb)`) Postgres refuses the statement outright:
    // `operator does not exist: geometry && jsonb`, because the column is
    // DDL'd `geometry(Polygon,4326)`.
    //
    // NO TYPMOD. The operand declared no `with`, so the cast asserts only that
    // the document IS a geometry — which is all `geometry && geometry` needs,
    // and all a value position can honestly say. Pinning the refinement's
    // DEFAULTS instead produced `::geometry(Point,4326)`, and PostGIS rejects a
    // Polygon cast to a Point typmod — on the NORMAL case, since `&&` is a
    // bounding-box pre-filter whose argument is usually a box.
    expect(sql.sql).toBe(
      'SELECT "parcel"."name" AS "name", ' +
        '("parcel"."shape" <-> ST_GeomFromGeoJSON($1)) AS "distance" ' +
        'FROM "parcel" AS "parcel" ' +
        'WHERE ("parcel"."shape" && ST_GeomFromGeoJSON($2)) ' +
        'LIMIT 10',
    );
    // …while the COLUMN's own type still carries the typmod, which is what a
    // cast TARGET is for.
    expect(engine.registry.dialect('postgres')!.sqlTypeFor(
      engine.type('parcel')!.field('shape')!.fieldType,
    )).toBe('geometry(Polygon,4326)');
  });

  it('emits the declared cast for a LITERAL operand too, not only for a bound param', () => {
    // Both roads a document can arrive by. `LiteralExpr.toSQL` carries the same
    // shape-only default `ParamExpr.toSQL` does, so a literal operand emitted
    // `CAST($1 AS jsonb)` as well — which is why the routing is shared rather
    // than special-cased on params.
    const sql = geoEngine().toSQL(
      parcelSelect({
        where: [
          {
            kind: 'operator',
            op: '&&',
            args: {
              left: { kind: 'field-ref', source: 'parcel', field: 'shape' },
              right: { kind: 'literal', value: { type: 'Polygon', coordinates: [] } },
            },
          },
        ],
      }),
      'postgres',
    );
    expect(sql.sql).toContain('("parcel"."shape" && ST_GeomFromGeoJSON($1))');
  });

  it('leaves a NON-document operand exactly as it was', () => {
    // The routing predicate is the A12 one: a value routes when it is an OBJECT
    // or when the target is a `json` one. A `number` operand with a scalar param
    // must still bind plainly — casting it would be the mirror-image defect.
    const registry = baseRegistry().registerOperator({
      name: '<<',
      operands: [{ name: 'left', type: { kind: 'number' } }, { name: 'right', type: 'any' }],
      output: { kind: 'bool' },
      instructions: 'A scalar stand-in, for the non-document road.',
      emit: { postgres: '({left} << {right})' },
    });
    registry.registerType(registry.parseType(parcelTypeDef));
    const sql = new QueryEngine(registry).toSQL(
      parcelSelect({
        where: [
          {
            kind: 'operator',
            op: '<<',
            args: {
              left: { kind: 'field-ref', source: 'parcel', field: 'id' },
              right: { kind: 'param', name: 'n' },
            },
          },
        ],
      }),
      'postgres',
      { params: { n: 3 } },
    );
    expect(sql.sql).toContain('("parcel"."id" << $1)');
    expect(sql.params).toEqual([3]);
  });

  it('a COLUMN may resolve a cast option from its own bag AND from the default', () => {
    // The column half of the position rule, over a COLUMN-SHAPED cast. A write
    // cell is the one position that may fill an unwritten slot: a default is a
    // fact about the column, so `shape` (which wrote `Polygon`) and `fallback`
    // (which wrote nothing, and is a `Point` by declaration) both resolve — and
    // this is the A12 behaviour `writeCellSql` has had since 0.6.2, unchanged by
    // sharing the routing.
    const registry = createRegistry().registerFieldType(TYPED);
    const typedTypeDef: TypeDef = {
      name: 'shapes',
      count: 10,
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'shape', type: { kind: 'json', as: 'Typed', with: { subtype: 'Polygon' } } },
        { name: 'fallback', type: { kind: 'json', as: 'Typed' } },
      ],
    };
    registry.registerType(registry.parseType(typedTypeDef));
    const sql = new QueryEngine(registry).toSQL(
      {
        kind: 'update',
        type: 'shapes',
        set: {
          shape: { kind: 'literal', value: { type: 'Polygon', coordinates: [] } },
          fallback: { kind: 'literal', value: { type: 'Point', coordinates: [0, 0] } },
        },
        where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'shapes', field: 'id' }, right: { kind: 'literal', value: 1 } }],
      },
      'postgres',
    );
    expect(sql.sql).toContain('ST_GeomFromGeoJSON($1)::geometry(Polygon)');
    expect(sql.sql).toContain('ST_GeomFromGeoJSON($2)::geometry(Point)');
  });

  it('REFUSES a document operand whose cast needs an option the operand never wrote', () => {
    // The value half. `Typed`'s cast interpolates `{subtype}`, and this operand
    // declares no `with` — so resolving it would assert `Point` about a value
    // nothing required to be one. Both alternatives are worse: the default-fill
    // emits SQL PostGIS rejects, and falling back to the base cast re-emits the
    // `CAST($1 AS jsonb)` that broke this road to begin with.
    const registry = createRegistry().registerFieldType(TYPED).registerOperator({
      name: '&&',
      operands: [
        { name: 'left', type: { kind: 'json', as: 'Typed' } },
        { name: 'right', type: { kind: 'json', as: 'Typed' } },
      ],
      output: { kind: 'bool' },
      instructions: 'Overlap over a column-shaped cast.',
      emit: { postgres: '({left} && {right})' },
    });
    const typedTypeDef: TypeDef = {
      name: 'shapes',
      count: 10,
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'shape', type: { kind: 'json', as: 'Typed', with: { subtype: 'Polygon' } } },
      ],
    };
    registry.registerType(registry.parseType(typedTypeDef));
    const query: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'shapes', field: 'id' } }],
      from: { kind: 'type', type: 'shapes' },
      where: [
        {
          kind: 'operator',
          op: '&&',
          args: {
            left: { kind: 'field-ref', source: 'shapes', field: 'shape' },
            right: { kind: 'param', name: 'box' },
          },
        },
      ],
    };
    const engine = new QueryEngine(registry);
    const problem = refusal(() => engine.toSQL(query, 'postgres', { params: { box: { type: 'Polygon' } } }));
    expect(problem.code).toBe('cast.unwritten-option');
    expect(problem.path).toEqual(['args', 'right']);
    expect(problem.message).toContain('`{subtype}`');
    expect(problem.message).toContain('a default belongs to the TYPE, not to this value');
    // It names the OPERATOR as well as the operand. Two registered operators can
    // both declare a `right`, and `… at args.right` identified neither — the
    // precedent is `operator.missing-arg`, one screen away, which always did.
    expect(problem.message).toContain("Operand 'right' of operator '&&'");
    // A COLUMN operand is untouched — it carries no bound value at all.
    expect(
      engine.toSQL({ ...query, where: [{ kind: 'operator', op: '&&', args: {
        left: { kind: 'field-ref', source: 'shapes', field: 'shape' },
        right: { kind: 'field-ref', source: 'shapes', field: 'shape' },
      } }] }, 'postgres').sql,
    ).toContain('("shapes"."shape" && "shapes"."shape")');
  });

  it('USES a column-shaped cast when the OPERAND itself wrote the options', () => {
    // The other resolution the refusal names: an operand that pins `subtype` is
    // making a real constraint, so the cast expresses something it declared.
    const registry = createRegistry().registerFieldType(TYPED).registerOperator({
      name: '&&',
      operands: [
        { name: 'left', type: { kind: 'json', as: 'Typed' } },
        { name: 'right', type: { kind: 'json', as: 'Typed', with: { subtype: 'Polygon' } } },
      ],
      output: { kind: 'bool' },
      instructions: 'Overlap against a Polygon specifically.',
      emit: { postgres: '({left} && {right})' },
    });
    const typedTypeDef: TypeDef = {
      name: 'shapes',
      count: 10,
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'shape', type: { kind: 'json', as: 'Typed', with: { subtype: 'Polygon' } } },
      ],
    };
    registry.registerType(registry.parseType(typedTypeDef));
    const sql = new QueryEngine(registry).toSQL(
      {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'shapes', field: 'id' } }],
        from: { kind: 'type', type: 'shapes' },
        where: [
          {
            kind: 'operator',
            op: '&&',
            args: {
              left: { kind: 'field-ref', source: 'shapes', field: 'shape' },
              right: { kind: 'param', name: 'box' },
            },
          },
        ],
      },
      'postgres',
      { params: { box: { type: 'Polygon' } } },
    );
    expect(sql.sql).toContain('("shapes"."shape" && ST_GeomFromGeoJSON($1)::geometry(Polygon))');
  });

  it('passes a refined operand that declares NO cast straight through to the base', () => {
    // A refinement with an `as` but no `cast` for this dialect has no option
    // slots to be unwritten, so nothing is refused and the base cast applies —
    // the `as` alone was never a reason to change the binding.
    const registry = createRegistry()
      .registerFieldType({ name: 'Geography', base: 'json', instructions: 'A PostGIS geography.' })
      .registerOperator({
        name: '&&',
        operands: [
          { name: 'left', type: { kind: 'json', as: 'Geography' } },
          { name: 'right', type: { kind: 'json', as: 'Geography' } },
        ],
        output: { kind: 'bool' },
        instructions: 'Overlap over a cast-less refinement.',
        emit: { postgres: '({left} && {right})' },
      });
    const geoTypeDef: TypeDef = {
      name: 'area',
      count: 10,
      fields: [{ name: 'shape', type: { kind: 'json', as: 'Geography' } }],
    };
    registry.registerType(registry.parseType(geoTypeDef));
    const sql = new QueryEngine(registry).toSQL(
      {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'area', field: 'shape' } }],
        from: { kind: 'type', type: 'area' },
        where: [
          {
            kind: 'operator',
            op: '&&',
            args: {
              left: { kind: 'field-ref', source: 'area', field: 'shape' },
              right: { kind: 'param', name: 'box' },
            },
          },
        ],
      },
      'postgres',
      { params: { box: { type: 'Polygon' } } },
    );
    expect(sql.sql).toContain('("area"."shape" && CAST($1 AS jsonb))');
  });

  it('binds a SCALAR into a plain `json` operand encoded AND cast — the A12 arm', () => {
    // The `target is json` half of the shared predicate, which no operator-road
    // test reached: a bare scalar is a legal `json` value, and binding it raw
    // gives Postgres a `text` where it wants `jsonb`. It must be JSON-ENCODED as
    // well as cast, which is exactly the pair `jsonValue` applies.
    const registry = createRegistry().registerOperator({
      name: '@>',
      operands: [{ name: 'left', type: { kind: 'json' } }, { name: 'right', type: { kind: 'json' } }],
      output: { kind: 'bool' },
      instructions: 'JSON containment.',
      emit: { postgres: '({left} @> {right})' },
    });
    const docTypeDef: TypeDef = {
      name: 'doc',
      count: 10,
      fields: [{ name: 'body', type: { kind: 'json' } }],
    };
    registry.registerType(registry.parseType(docTypeDef));
    const sql = new QueryEngine(registry).toSQL(
      {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'doc', field: 'body' } }],
        from: { kind: 'type', type: 'doc' },
        where: [
          {
            kind: 'operator',
            op: '@>',
            args: {
              left: { kind: 'field-ref', source: 'doc', field: 'body' },
              right: { kind: 'param', name: 'v' },
            },
          },
        ],
      },
      'postgres',
      { params: { v: 'bare' } },
    );
    expect(sql.sql).toContain('("doc"."body" @> CAST($1 AS jsonb))');
    expect(sql.params).toEqual(['"bare"']);
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

  it('names both remedies in the no-run refusal, and the SQL road still works', async () => {
    // A SQL-road-only operator is a legitimate shape — it just cannot be
    // EVALUATED — so the refusal points at both: register a run, or emit.
    const engine = runtimeEngine(false);
    const query = parcelSelect({ where: [SHAPE_OVERLAPS_BOX] });
    const message = await engine
      .run(query, { params: { box: { type: 'Polygon', coordinates: [1] } } })
      .then(() => '', (err: unknown) => (err instanceof Error ? err.message : String(err)));
    expect(message).toContain("registerOperatorRun('&&'");
    expect(message).toContain('engine.toSQL');
    expect(engine.toSQL(query, 'postgres', { params: { box: {} } }).sql).toContain('&&');
  });

  it('REFUSES when no implementation is registered, rather than returning zero rows', async () => {
    // The one place this package's "a missing run answers NULL" rule does not
    // apply, and the reason is measurable: an operator is usually a PREDICATE,
    // so NULL is UNKNOWN for every row and the query returns an EMPTY RESULT SET
    // that looks exactly like one that ran. That is the very failure
    // `OperatorExpr.toSQL` refuses an unsupported dialect for, and it would be
    // incoherent to refuse it on one road and produce it on the other.
    await expect(
      runtimeEngine(false).run(parcelSelect({ where: [SHAPE_OVERLAPS_BOX] }), {
        params: { box: { type: 'Polygon', coordinates: [1] } },
      }),
    ).rejects.toThrow(/operator\.no-run/);
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
    // The operand tag names the registered TYPE and nothing else. It used to
    // render the refinement's DEFAULTS (`subtype=Point,srid=4326`) plus the
    // refused arms — but an operand's declared type is a COMPARABILITY
    // constraint, so beside a column reading `subtype=Polygon` a model had every
    // reason to conclude `shape` was not a legal `left`.
    const geometry = 'json(as Geometry)';
    expect(text).toContain(`- &&(left: ${geometry}, right: ${geometry}) → bool — Bounding-box overlap`);
    expect(text).toContain(`- <->(left: ${geometry}, right: ${geometry}) → number`);
    expect(text).not.toContain('subtype=Point');
    expect(text).not.toContain('no <');
    // …while the COLUMN still renders its own effective options and refusals,
    // which are facts about it. Both readings live in one catalog.
    expect(describeTypes(geoEngine())).toContain(
      'shape: json(as Geometry,subtype=Polygon,srid=4326,no =,no <,no LIKE)',
    );
    // The declared example is rendered verbatim under the signature.
    expect(text).toContain('"op":"&&"');
  });

  it('renders the OUTPUT in COLUMN style, so its refused arms are stated somewhere', () => {
    // The output is not an operand and need not be any column's type, so the
    // `types:` block may never mention it — rendering it in operand style
    // deleted its refusals from the catalog entirely. Measured: `<->` returning
    // a `Meters` that refuses ordering told a model nothing, and
    // `WHERE (shape <-> :p) < :max` was then refused with `comparison.type`.
    const registry = baseRegistry()
      .registerFieldType({
        name: 'Meters',
        base: 'number',
        instructions: 'A length in metres.',
        compare: { equality: false, ordering: false },
      })
      .registerOperator({ ...DISTANCE, output: { kind: 'number', as: 'Meters' } });
    registry.registerType(registry.parseType(parcelTypeDef));
    const text = describeOperators(new QueryEngine(registry));
    expect(text).toContain('→ number(as Meters,no =,no <)');
    // The refusal it discloses is live, and this catalog is its ONLY mention:
    // no column is a `Meters`.
    expect(describeTypes(new QueryEngine(registry))).not.toContain('Meters');
    expect(
      problemsOf(
        new QueryEngine(registry),
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
              right: { kind: 'param', name: 'max' },
            },
          ],
        }),
      )[0],
    ).toContain('comparison.type');
  });

  it('DOES render an option the operand declaration itself wrote', () => {
    // The rule is "only what the declaration wrote", not "never any options": an
    // operand that pins an SRID is making a real constraint, and a model has to
    // see it to know which columns fit.
    const registry = baseRegistry().registerOperator({
      ...OVERLAPS,
      operands: [
        { name: 'left', type: { kind: 'json', as: 'Geometry', with: { srid: 3857 } } },
        { name: 'right', type: { kind: 'json', as: 'Geometry' } },
      ],
    });
    const text = describeOperators(new QueryEngine(registry));
    expect(text).toContain('- &&(left: json(as Geometry,srid=3857), right: json(as Geometry)) → bool');
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
    // …and an operator over a type NO field could supply is gated out even on a
    // registry that has both the operator and Types — reachability is about the
    // operand types, not about the operator merely existing.
    const unreachable = createRegistry().registerFieldType(GEOMETRY).registerOperator({
      ...OVERLAPS,
      operands: [{ name: 'left', type: { kind: 'timestamp' } }, { name: 'right', type: { kind: 'timestamp' } }],
    });
    unreachable.registerType(unreachable.parseType(parcelTypeDef));
    expect(
      exprKindApplicable('operator', unreachable.typeList(), selectFunctions(unreachable, 'all'), unreachable),
    ).toBe(false);
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

describe('an operator that reconstructs a refused arm', () => {
  it('is ALLOWED, and `checkOperator` warns that the catalog then contradicts itself', () => {
    // `Geometry` declares `equality: false`, so the builtin `=` over `shape` is
    // refused — and an operator NAMED `=` over the same type validates clean.
    // That is the author's prerogative (an operator declares its own meaning),
    // but the model sees `no =` in the type block and a `=` in the operators
    // block of ONE catalog with nothing saying which wins.
    const equals: OperatorDef = {
      name: '=',
      operands: [
        { name: 'left', type: { kind: 'json', as: 'Geometry' } },
        { name: 'right', type: { kind: 'json', as: 'Geometry' } },
      ],
      output: { kind: 'bool' },
      instructions: 'Exact byte equality of two geometries.',
      emit: { postgres: '({left} = {right})' },
    };
    const registry = baseRegistry().registerOperator(equals);
    registry.registerType(registry.parseType(parcelTypeDef));
    const engine = new QueryEngine(registry);
    const shape: ExprDef = { kind: 'field-ref', source: 'parcel', field: 'shape' };
    // The operator road is clean…
    expect(
      problemsOf(engine, parcelSelect({ where: [{ kind: 'operator', op: '=', args: { left: shape, right: shape } }] })),
    ).toEqual([]);
    // …while the builtin `=` over the same column is still refused.
    expect(
      problemsOf(engine, parcelSelect({ where: [{ kind: 'comparison', op: '=', left: shape, right: shape }] }))[0],
    ).toContain('comparison.type');

    const report = checkOperator(equals, { registry: baseRegistry() });
    const shadow = report.problems.filter((p) => p.code === 'conformance.shadows-refused-arm');
    expect(shadow).toHaveLength(2); // one per operand
    expect(shadow[0]?.severity).toBe('warning');
    expect(shadow[0]?.message).toContain('say in `=`');
    // A non-comparison name over the same type says nothing.
    expect(
      checkOperator(OVERLAPS, { registry: baseRegistry() }).problems.filter(
        (p) => p.code === 'conformance.shadows-refused-arm',
      ),
    ).toEqual([]);
  });

  it('says nothing about an `any` operand, which declares no type to refuse anything', () => {
    const anyOperand: OperatorDef = {
      name: '=',
      operands: [{ name: 'left', type: 'any' }],
      output: { kind: 'bool' },
      instructions: 'Equality over anything at all.',
      emit: { postgres: '({left} = {left})' },
    };
    expect(
      checkOperator(anyOperand, { registry: baseRegistry() }).problems.filter(
        (p) => p.code === 'conformance.shadows-refused-arm',
      ),
    ).toEqual([]);
  });

  it('tests MEMBERSHIP of an arm, not the one glyph that arm renders as', () => {
    /** How many shadow warnings `name` raises over two `Geometry` operands. */
    const warnings = (name: string): number =>
      checkOperator(
        { ...OVERLAPS, name, emit: { postgres: `({left} ${name} {right})` } },
        { registry: baseRegistry() },
      ).problems.filter((p) => p.code === 'conformance.shadows-refused-arm').length;

    // `Geometry` refuses ALL THREE arms. Every SQL token of each arm must warn —
    // the check was first written off `COMPARE_ARM_OPERATORS`, which holds ONE
    // REPRESENTATIVE glyph per arm "as a model would write it", so `=` warned
    // and `<>` did not, `<` warned and `<=` / `>` / `>=` did not.
    for (const equality of ['=', '<>']) expect([equality, warnings(equality)]).toEqual([equality, 2]);
    for (const ordering of ['<', '<=', '>', '>=']) expect([ordering, warnings(ordering)]).toEqual([ordering, 2]);
    // And the textMatch branch was DEAD: its rendering glyph is the WORD `LIKE`,
    // which `OPERATOR_NAME_PATTERN` refuses outright, so no operator name could
    // ever equal it. The realistic shadow is Postgres's punctuation spelling.
    for (const textMatch of ['~~', '~~*', '!~~', '!~~*']) {
      expect([textMatch, warnings(textMatch)]).toEqual([textMatch, 2]);
    }
    // A token belonging to no arm still says nothing.
    for (const unrelated of ['&&', '<->', '@>']) expect([unrelated, warnings(unrelated)]).toEqual([unrelated, 0]);
  });

  it('sees a refinement carried by an ARRAY operand ELEMENT type', () => {
    // A container carries no refinement of its own, so an
    // `array<json as Geometry>` operand answered "no refinement" and warned
    // about nothing.
    const arrayOperand: OperatorDef = {
      name: '=',
      operands: [{ name: 'left', type: { kind: 'array', item: { kind: 'json', as: 'Geometry' } } }],
      output: { kind: 'bool' },
      instructions: 'Equality over a list of geometries.',
      emit: { postgres: '({left} = {left})' },
    };
    expect(
      checkOperator(arrayOperand, { registry: baseRegistry() }).problems.filter(
        (p) => p.code === 'conformance.shadows-refused-arm',
      ),
    ).toHaveLength(1);
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

// ─── The value-position rule, one level DOWN ─────────────────────────────────

describe('the value-position rule survives a dialect\'s own element-wise recursion', () => {
  /** A registry over an `array<json as Typed>` operand — the road that bypassed the rule. */
  function arrayRegistry(operandWith?: Record<string, string>): Registry {
    const registry = createRegistry().registerFieldType(TYPED);
    const item = { kind: 'json', as: 'Typed', ...(operandWith ? { with: operandWith } : {}) } as const;
    registry.registerOperator({
      name: '@>',
      operands: [
        { name: 'left', type: { kind: 'array', item: { kind: 'json', as: 'Typed' } } },
        { name: 'right', type: { kind: 'array', item } },
      ],
      output: { kind: 'bool' },
      instructions: 'Array containment over typed documents.',
      emit: { postgres: '({left} @> {right})' },
    });
    registry.registerType(
      registry.parseType({
        name: 'shapes',
        count: 10,
        fields: [
          { name: 'id', type: { kind: 'number', whole: true } },
          { name: 'geoms', type: { kind: 'array', item: { kind: 'json', as: 'Typed', with: { subtype: 'Polygon' } } } },
        ],
      }),
    );
    return registry;
  }
  /** `geoms @> <literal>` over `shapes`. */
  const contains = (right: JsonValue): QueryDef => ({
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'shapes', field: 'id' } }],
    from: { kind: 'type', type: 'shapes' },
    where: [
      {
        kind: 'operator',
        op: '@>',
        args: {
          left: { kind: 'field-ref', source: 'shapes', field: 'geoms' },
          right: { kind: 'literal', value: right },
        },
      },
    ],
  });

  it('REFUSES an ELEMENT whose cast interpolates an option the operand never wrote', () => {
    // Measured before the fix, on this exact declaration and this exact value:
    //   ARRAY[ST_GeomFromGeoJSON($1)::geometry(Point)]::geometry(Point)[]
    // — a Polygon document cast to a Point typmod, which is precisely the class
    // the rule refuses ONE LEVEL UP. Postgres constructs a native array
    // element-wise and re-enters `jsonValue` per element, so a rule enforced
    // only at the operand was enforced for the container and skipped for
    // everything inside it.
    const engine = new QueryEngine(arrayRegistry());
    const problem = refusal(() => engine.toSQL(contains([{ type: 'Polygon' }]), 'postgres'));
    expect(problem.code).toBe('cast.unwritten-option');
    expect(problem.path).toEqual(['args', 'right']);
    expect(problem.message).toContain('`{subtype}`');
  });

  it('EMITS the element cast when the operand wrote the options', () => {
    const sql = new QueryEngine(arrayRegistry({ subtype: 'Polygon' })).toSQL(
      contains([{ type: 'Polygon' }]),
      'postgres',
    ).sql;
    // The ELEMENT carries the declared cast; the ARRAY's own `::` target is the
    // BASE's, because `Typed` declares a `cast` and no `sql` — the documented
    // fallback, and the reason the shipped `Geometry` declares both.
    expect(sql).toContain('ARRAY[ST_GeomFromGeoJSON($1)::geometry(Polygon)]::jsonb[]');
  });

  it('leaves a COLUMN position resolving its defaults, as it always did', () => {
    // A write cell is a column: its refinement's defaults are facts about it.
    const registry = arrayRegistry();
    const sql = new QueryEngine(registry).toSQL(
      {
        kind: 'insert',
        into: 'shapes',
        rows: [{ id: { kind: 'literal', value: 1 }, geoms: { kind: 'literal', value: [{ type: 'Polygon' }] } }],
      },
      'postgres',
    ).sql;
    expect(sql).toContain('ST_GeomFromGeoJSON($2)::geometry(Polygon)');
  });
});

describe('`checkOperator` finds an operand cast that can never be resolved', () => {
  /** `&&` over a column-shaped `Typed`, with no `with` on either operand. */
  const UNWRITABLE: OperatorDef = {
    name: '&&',
    operands: [
      { name: 'left', type: { kind: 'json', as: 'Typed' } },
      { name: 'right', type: { kind: 'json', as: 'Typed' } },
    ],
    output: { kind: 'bool' },
    instructions: 'Overlap over a column-shaped cast — the shape that is refused at emit.',
    emit: { postgres: '({left} && {right})' },
  };

  it('WARNS at the declaration for what would otherwise appear at the first bound document', () => {
    const warnings = checkOperator(UNWRITABLE, {
      registry: createRegistry().registerFieldType(TYPED),
    }).problems.filter((p) => p.code === 'conformance.unwritable-operand-cast');
    // One per operand — both are typed `Typed` and neither writes `subtype`.
    expect(warnings.map((p) => p.path)).toEqual([
      ['checkOperator', '&&', 'operands', 'left'],
      ['checkOperator', '&&', 'operands', 'right'],
    ]);
    expect(warnings[0]!.severity).toBe('warning');
    expect(warnings[0]!.message).toContain('`{subtype}`');
    // It names BOTH resolutions the emit-time refusal names.
    expect(warnings[0]!.message).toContain('`with` bag');
    expect(warnings[0]!.message).toContain('cast TARGET');
  });

  it('is SILENT once the operand writes the options, or when the cast interpolates none', () => {
    const written = checkOperator(
      { ...UNWRITABLE, operands: UNWRITABLE.operands.map((o) => ({ ...o, type: { kind: 'json', as: 'Typed', with: { subtype: 'Polygon' } } })) },
      { registry: createRegistry().registerFieldType(TYPED) },
    );
    expect(written.problems.filter((p) => p.code === 'conformance.unwritable-operand-cast')).toEqual([]);
    // `Geometry`'s cast interpolates nothing, so it is position-independent.
    expect(
      checkOperator(OVERLAPS, { registry: baseRegistry() })
        .problems.filter((p) => p.code === 'conformance.unwritable-operand-cast'),
    ).toEqual([]);
  });

  it('reaches an ARRAY operand\'s ELEMENT type, the level the emit road recurses into', () => {
    const warnings = checkOperator(
      {
        ...UNWRITABLE,
        name: '@>',
        operands: UNWRITABLE.operands.map((o) => ({
          ...o,
          type: { kind: 'array', item: { kind: 'json', as: 'Typed' } },
        })),
        emit: { postgres: '({left} @> {right})' },
      },
      { registry: createRegistry().registerFieldType(TYPED) },
    ).problems.filter((p) => p.code === 'conformance.unwritable-operand-cast');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]!.message).toContain('typed `Typed`');
  });
});

describe('an unwritable cast naming TWO options reads as a list, in both surfaces', () => {
  /** A refinement whose cast interpolates BOTH of its own options. */
  const TWO_SLOT: FieldTypeRefinementDef = {
    name: 'TwoSlot',
    base: 'json',
    instructions: 'A geometry whose cast pins BOTH the subtype and the SRID — doubly column-shaped.',
    ownOptions: {
      subtype: { type: { kind: 'text', values: [{ value: 'Point' }, { value: 'Polygon' }] }, default: 'Point' },
      srid: { type: { kind: 'number', whole: true }, default: 4326 },
    },
    cast: { postgres: 'ST_GeomFromGeoJSON({value})::geometry({subtype},{srid})' },
  };
  const OVERLAPS_TWO: OperatorDef = {
    name: '&&',
    operands: [
      { name: 'left', type: { kind: 'json', as: 'TwoSlot' } },
      { name: 'right', type: { kind: 'json', as: 'TwoSlot' } },
    ],
    output: { kind: 'bool' },
    instructions: 'Overlap over a doubly column-shaped cast.',
    emit: { postgres: '({left} && {right})' },
  };

  it('the EMIT refusal lists both, and says "them"', () => {
    const registry = createRegistry().registerFieldType(TWO_SLOT).registerOperator(OVERLAPS_TWO);
    registry.registerType(
      registry.parseType({
        name: 'shapes',
        count: 10,
        fields: [
          { name: 'id', type: { kind: 'number', whole: true } },
          { name: 'shape', type: { kind: 'json', as: 'TwoSlot', with: { subtype: 'Polygon', srid: 3857 } } },
        ],
      }),
    );
    const problem = refusal(() =>
      new QueryEngine(registry).toSQL(
        {
          kind: 'select',
          fields: [{ expr: { kind: 'field-ref', source: 'shapes', field: 'id' } }],
          from: { kind: 'type', type: 'shapes' },
          where: [
            {
              kind: 'operator',
              op: '&&',
              args: {
                left: { kind: 'field-ref', source: 'shapes', field: 'shape' },
                right: { kind: 'literal', value: { type: 'Polygon' } },
              },
            },
          ],
        },
        'postgres',
      ),
    );
    expect(problem.message).toContain('`{subtype}`, `{srid}`');
    expect(problem.message).toContain('declared no value for them');
  });

  it('the `checkOperator` warning lists both too', () => {
    const warning = checkOperator(OVERLAPS_TWO, { registry: createRegistry().registerFieldType(TWO_SLOT) })
      .problems.find((p) => p.code === 'conformance.unwritable-operand-cast');
    expect(warning?.message).toContain('`{subtype}`, `{srid}`');
    expect(warning?.message).toContain('writes no value for them');
  });
});
