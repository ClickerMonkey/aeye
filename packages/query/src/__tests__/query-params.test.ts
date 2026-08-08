/**
 * A17 — `Query.params()` reports a ROW BOUND (`limit` / `offset`) bound to a
 * `param` at EVERY nesting depth, not just on the root statement.
 *
 * `params()` is how a caller learns what `engine.run(query, { params })` /
 * `toSQL(query, { params })` expects — downstream it is what DECLARES a stored
 * query's arguments. It used to observe out-of-tree bounds on the ROOT query
 * only (a `SelectQuery`-owned hook the base never recursed through), so a paged
 * `cte` — whose bound lives on `final`, exactly where `autoPaginate` puts it —
 * reported `[]` while the emitter still produced `LIMIT ? OFFSET ?`.
 *
 * It is a REPORTING gap, not an emit gap, which is what made it quiet. Measured
 * on 0.6.3, binding exactly what `params()` declared:
 *
 *     toSQL(autoPaginate(cte), { params: {} })
 *       → 'WITH "recent" AS (…) SELECT … LIMIT ? OFFSET ?'   params: [null, null]
 *
 * `LIMIT NULL OFFSET NULL` is "no limit, no offset" in Postgres, so a caller
 * that faithfully bound the declared signature read the WHOLE table.
 *
 * The gap was never `cte`-specific: NOTHING below the root was observed. The fix
 * moves the observation into each owning kind's own `validateWalk` — the walk
 * that already recurses into a CTE body and its `final`, a set-operation arm, and
 * a FROM / IN / EXISTS subquery, all sharing ONE `ParamSet`. So the invariant is
 * tested as a PROPERTY over query shapes rather than as the one reported example:
 * for every shape, binding exactly the params `params()` declares leaves NO bind
 * slot null.
 */
import { describe, it, expect } from 'vitest';
import { autoPaginate } from '../transforms/index';
import { fixture } from './_utils';
import type {
  CTEStatementDef,
  ParamDef,
  QueryDef,
  SelectDef,
  SetOperationDef,
} from '../schema';

/** A minimal select over `order`. */
function baseSelect(): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
    from: { kind: 'type', type: 'order' },
  };
}

/** The same select with its own `limit` bound to `param`. */
function boundedSelect(name: string): SelectDef {
  return { ...baseSelect(), limit: { kind: 'param', name } };
}

/** A select reading a CTE named `cteName`. */
function readCte(cteName: string): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: cteName, field: 'id' } }],
    from: { kind: 'type', type: cteName },
  };
}

/** `WITH recent AS (<body>) <final>`. */
function cte(body: QueryDef = baseSelect(), final: QueryDef = readCte('recent')): CTEStatementDef {
  return { kind: 'cte', ctes: [{ name: 'recent', query: body }], final };
}

/** Just the param NAMES, in report order. */
function names(params: readonly ParamDef[]): string[] {
  return params.map((p) => p.name);
}

// ─── The reported case, and its neighbours ───────────────────────────────────

describe('A17 — params() sees a row bound on a delegating statement', () => {
  it("reports the window params bound on a paged `cte`'s final", () => {
    const fx = fixture();
    const params = fx.engine.parseQuery(autoPaginate(cte())).params(fx.engine);
    expect(names(params)).toEqual(['limit', 'offset']);
    // The SAME inferred type a paged select reports — a bound is observed
    // against a plain number field type. (It is unqualified `number`, not
    // `whole: true`; a row count could be narrower, but pinning that here would
    // change what an existing paged SELECT declares, so it is left as measured.)
    expect(params.map((p) => p.type)).toEqual([{ kind: 'number' }, { kind: 'number' }]);
    const select = fx.engine.parseQuery(autoPaginate(baseSelect())).params(fx.engine);
    expect(params).toEqual(select);
  });

  it('reports a paged plain select exactly as before (content AND order)', () => {
    const fx = fixture();
    // A WHERE param plus the two bounds: the clause param keeps its leading
    // position, so an existing caller's argument order is untouched.
    const withWhere: SelectDef = {
      ...baseSelect(),
      where: [
        {
          kind: 'comparison',
          op: '=',
          left: { kind: 'field-ref', source: 'order', field: 'id' },
          right: { kind: 'param', name: 'id' },
        },
      ],
    };
    const params = fx.engine.parseQuery(autoPaginate(withWhere)).params(fx.engine);
    expect(names(params)).toEqual(['id', 'limit', 'offset']);
  });

  it('reports through a NESTED cte (a cte whose final is a cte)', () => {
    const fx = fixture();
    const nested: CTEStatementDef = {
      kind: 'cte',
      ctes: [{ name: 'outer', query: baseSelect() }],
      final: cte(),
    };
    expect(names(fx.engine.parseQuery(autoPaginate(nested)).params(fx.engine))).toEqual([
      'limit',
      'offset',
    ]);
  });

  it('reports NOTHING for a cte with no window (an absent bound is not a param)', () => {
    const fx = fixture();
    expect(fx.engine.parseQuery(cte()).params(fx.engine)).toEqual([]);
  });

  it('reports only the bound that is actually present (limit, no offset)', () => {
    const fx = fixture();
    const oneSided = cte(baseSelect(), boundedSelect('take'));
    expect(names(fx.engine.parseQuery(oneSided).params(fx.engine))).toEqual(['take']);
  });

  it('still omits a LITERAL bound — only a `param` bound is an argument', () => {
    const fx = fixture();
    const literal = cte(baseSelect(), { ...baseSelect(), limit: 25, offset: 50 });
    expect(fx.engine.parseQuery(literal).params(fx.engine)).toEqual([]);
  });

  it('names the OWNING statement when a nested bound conflicts with a text use', () => {
    const fx = fixture();
    // The same name used as a row bound on `final` AND compared to a text field:
    // one value cannot be both, so the param is dropped from the report and the
    // conflict is reported at the path that actually holds the bound.
    const conflicting = cte(baseSelect(), {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'recent', field: 'id' } }],
      from: { kind: 'type', type: 'recent' },
      where: [
        {
          kind: 'comparison',
          op: '=',
          left: { kind: 'field-ref', source: 'order', field: 'note' },
          right: { kind: 'param', name: 'n' },
        },
      ],
      joins: [{ on: { kind: 'type', type: 'order' } }],
      limit: { kind: 'param', name: 'n' },
    });
    expect(fx.engine.parseQuery(conflicting).params(fx.engine)).toEqual([]);
    const conflict = fx.engine.validateQuery(conflicting).list.find((x) => x.code === 'param.conflict');
    expect(conflict).toBeDefined();
    // `final.limit`, not a root-relative `limit` that does not exist.
    expect(conflict!.message).toContain('final.limit');
  });
});

// ─── The generalization: EVERY nesting position, as a property ───────────────

/**
 * `cte` is where the gap was reported, but it was never the only delegator —
 * every nested-query position had it, because the observation ran on the root
 * alone. Each shape below emits ONE `LIMIT ?` from a bound named `deep`.
 */
const nestedBoundShapes: ReadonlyArray<{ name: string; def: QueryDef }> = [
  { name: "a cte's final", def: cte(baseSelect(), boundedSelect('deep')) },
  { name: "a cte's BODY", def: cte(boundedSelect('deep'), readCte('recent')) },
  {
    name: "a set operation's ARM",
    def: { kind: 'union', left: boundedSelect('deep'), right: baseSelect() },
  },
  {
    name: 'a set operation SET-LEVEL bound',
    def: {
      kind: 'union',
      left: baseSelect(),
      right: baseSelect(),
      limit: { kind: 'param', name: 'deep' },
    },
  },
  {
    name: 'a FROM subquery',
    def: {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 's', field: 'id' } }],
      from: { kind: 'subquery', query: boundedSelect('deep'), as: 's' },
    },
  },
  {
    name: 'an IN subquery',
    def: {
      ...baseSelect(),
      where: [
        {
          kind: 'in',
          value: { kind: 'field-ref', source: 'order', field: 'id' },
          in: boundedSelect('deep'),
        },
      ],
    },
  },
  {
    name: 'an EXISTS subquery',
    def: {
      ...baseSelect(),
      where: [{ kind: 'exists', query: boundedSelect('deep') }],
    },
  },
  {
    name: 'a DELETE’s IN subquery',
    def: {
      kind: 'delete',
      from: 'order',
      where: [
        {
          kind: 'in',
          value: { kind: 'field-ref', source: 'order', field: 'id' },
          in: boundedSelect('deep'),
        },
      ],
    },
  },
  // INSERT … SELECT was worse than the rest: its source query was never walked
  // AT ALL, so not just the bound but EVERY param inside it went unreported.
  { name: 'an INSERT … SELECT source', def: { kind: 'insert', into: 'order', select: boundedSelect('deep') } },
];

describe('A17 — the gap generalizes past `cte`: every nested position', () => {
  for (const { name, def } of nestedBoundShapes) {
    it(`reports a row bound on ${name}`, () => {
      const fx = fixture();
      expect(names(fx.engine.parseQuery(def).params(fx.engine))).toEqual(['deep']);
    });
  }

  it('reports a param in an INSERT … SELECT’s WHERE (its source was never walked)', () => {
    const fx = fixture();
    const def: QueryDef = {
      kind: 'insert',
      into: 'order',
      select: {
        ...baseSelect(),
        where: [
          {
            kind: 'comparison',
            op: '=',
            left: { kind: 'field-ref', source: 'order', field: 'id' },
            right: { kind: 'param', name: 'deep' },
          },
        ],
      },
    };
    expect(names(fx.engine.parseQuery(def).params(fx.engine))).toEqual(['deep']);
  });

  it('surfaces a real error inside an INSERT … SELECT instead of accepting it silently', () => {
    const fx = fixture();
    const def: QueryDef = {
      kind: 'insert',
      into: 'order',
      select: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'nosuch', field: 'id' } }],
        from: { kind: 'type', type: 'order' },
      },
    };
    const problems = fx.engine.validateQuery(def);
    expect(problems.list.map((x) => x.code)).toEqual(['ref.unknown-source']);
    // Reported UNDER the source query, so a caller can point at the offender.
    expect(problems.list[0]!.path[0]).toBe('select');
  });
});

// ─── The invariant: what params() declares is enough to BIND the SQL ─────────

/**
 * The property that makes the report trustworthy: bind EXACTLY the params
 * `params()` declares and no emitted bind slot is left null. On 0.6.3 every
 * shape above produced `[null]` (and the paged `cte` `[null, null]`), which
 * Postgres reads as "no limit / no offset" — the whole table.
 */
describe('A17 — a declared signature is a BINDABLE signature', () => {
  const everyShape: ReadonlyArray<{ name: string; def: QueryDef }> = [
    { name: 'a paged select', def: autoPaginate(baseSelect()) },
    { name: 'a paged cte', def: autoPaginate(cte()) },
    {
      name: 'a paged nested cte',
      def: autoPaginate({ kind: 'cte', ctes: [{ name: 'outer', query: baseSelect() }], final: cte() }),
    },
    {
      name: 'a paged set operation',
      def: autoPaginate({ kind: 'union', left: baseSelect(), right: baseSelect() }),
    },
    {
      name: 'a cte whose final is a paged set operation',
      def: cte(
        baseSelect(),
        autoPaginate({ kind: 'union', left: readCte('recent'), right: baseSelect() }),
      ),
    },
    ...nestedBoundShapes,
  ];

  for (const { name, def } of everyShape) {
    it(`binds every emitted slot of ${name} from its own declared params`, () => {
      const fx = fixture();
      const declared = fx.engine.parseQuery(def).params(fx.engine);
      // Bind ONLY what was declared — the caller has nothing else to go on.
      const bind = Object.fromEntries(declared.map((p, i) => [p.name, i + 1]));
      const { sql, params } = fx.engine.toSQL(def, 'base', { params: bind });
      const slots = (sql.match(/\?/g) ?? []).length;
      expect(params.length).toBe(slots);
      expect(params.filter((v) => v === null)).toEqual([]);
    });
  }
});
