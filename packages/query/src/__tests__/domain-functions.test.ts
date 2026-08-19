/**
 * A DOMAIN vocabulary (the worked example is PostGIS) needs no new field type:
 * registered scalar functions over a `{kind:'json'}` column emit valid
 * dialect-native SQL today. This test IS the doc section in `aeye-query.md`
 * ("A domain vocabulary needs no new field type") — the SQL asserted below is
 * the SQL printed there, so the claim cannot rot silently.
 *
 * It also pins the two honest LIMITS named in the same section, because a limit
 * that is only prose is a limit nobody re-measures: the cast target is the
 * BASE's (`jsonb`, not `geometry(Point,4326)`), and a meaningless ordering
 * between two such columns is NOT refused.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry, QueryEngine } from '../index';
import type { FieldTypeDef, SelectDef } from '../index';

/** A registry with `parcel` + the three PostGIS predicates, and its engine. */
function geoFixture(): QueryEngine {
  const registry = createRegistry();
  const geometry: FieldTypeDef = { kind: 'json' };
  for (const [name, output, instructions] of [
    ['ST_Contains', { kind: 'bool' }, 'True when geometry a fully contains geometry b.'],
    ['ST_Within', { kind: 'bool' }, 'True when geometry a lies entirely inside geometry b.'],
    ['ST_Distance', { kind: 'number' }, 'Distance between two geometries, in the SRID unit.'],
  ] as const) {
    registry.registerFunction({
      name,
      shape: 'scalar',
      output,
      instructions,
      params: [
        { name: 'a', type: geometry },
        { name: 'b', type: geometry },
      ],
    });
  }
  registry.registerType(
    registry.parseType({
      name: 'parcel',
      count: 250_000,
      bytes: 160,
      fields: [
        { name: 'name', type: { kind: 'text' } },
        { name: 'shape', type: geometry },
        { name: 'other', type: geometry },
      ],
    }),
  );
  registry.finalize();
  return new QueryEngine(registry);
}

/** `ST_<name>(a: parcel.shape, b: :here)`. */
const geoCall = (name: string) =>
  ({
    kind: 'function-call' as const,
    function: name,
    args: {
      a: { kind: 'field-ref' as const, source: 'parcel', field: 'shape' },
      b: { kind: 'param' as const, name: 'here' },
    },
  });

const nearby: SelectDef = {
  kind: 'select',
  fields: [{ expr: { kind: 'field-ref', source: 'parcel', field: 'name' } }],
  from: { kind: 'type', type: 'parcel' },
  where: [geoCall('ST_Contains')],
  order: [{ expr: geoCall('ST_Distance'), dir: 'asc' }],
  limit: 10,
};

describe('a domain vocabulary over a json column (PostGIS)', () => {
  it('validates clean, and types the geometry param from the declared parameter', () => {
    const engine = geoFixture();
    expect(engine.validateQuery(nearby).list).toEqual([]);
    // The param is used ONLY as a function argument — nothing else could type
    // it. (Through 0.6.6 this was `function.arg-type` + `param.untyped`.)
    const here = engine.parameters(nearby).find((x) => x.name === 'here');
    expect(here?.category).toBe('json');
    expect(here?.type?.toJSON()).toEqual({ kind: 'json' });
  });

  it('emits dialect-native PostGIS SQL', () => {
    const engine = geoFixture();
    const sql = engine.toSQL(nearby, 'postgres', { params: { here: { type: 'Point', coordinates: [1, 2] } } });
    expect(sql.sql).toBe(
      'SELECT "parcel"."name" AS "name" FROM "parcel" AS "parcel" ' +
        'WHERE ST_Contains("parcel"."shape", CAST($1 AS jsonb)) ' +
        'ORDER BY ST_Distance("parcel"."shape", CAST($2 AS jsonb)) ASC LIMIT 10',
    );
    // The LIMIT of the technique, stated as an assertion: the cast target is the
    // BASE type's, not `geometry(Point,4326)`.
    expect(sql.sql).toContain('CAST($1 AS jsonb)');
  });

  it('does NOT refuse a meaningless ordering between two such columns', () => {
    // The other limit: `json` is the type, so `json < json` is comparable. A
    // registered TYPE (not just functions) is what would refuse this.
    const engine = geoFixture();
    const ordered: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'parcel', field: 'name' } }],
      from: { kind: 'type', type: 'parcel' },
      where: [
        {
          kind: 'comparison',
          op: '<',
          left: { kind: 'field-ref', source: 'parcel', field: 'shape' },
          right: { kind: 'field-ref', source: 'parcel', field: 'other' },
        },
      ],
    };
    expect(engine.validateQuery(ordered).list).toEqual([]);
  });
});
