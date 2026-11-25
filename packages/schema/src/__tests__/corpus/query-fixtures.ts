/**
 * query's own test fixtures (packages/query/src/__tests__/_utils.ts,
 * capability-gating.test.ts, operator.test.ts) as real `@aeye/query`
 * registries, and the adapter from a registry to the port's catalog.
 */
import { createRegistry, type FunctionDef, type Registry, type TypeDef } from '../../../bench/legacy-query';
import type { CatalogType, GatedKind, QueryCatalog } from './query';

// ============================================================================
// Fixtures: query's own (src/__tests__/_utils.ts and friends)
// ============================================================================

// _utils.ts userTypeDef / orderTypeDef
export const userTypeDef: TypeDef = {
  name: 'user',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
    { name: 'age', type: { kind: 'number', whole: true }, nullable: true },
    { name: 'email', type: { kind: 'text', search: true } },
    { name: 'tags', type: { kind: 'array', item: { kind: 'text' } }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, count: 1 }] }],
  count: 1000,
  bytes: 64,
};
export const orderTypeDef: TypeDef = {
  name: 'order',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'userId', type: { kind: 'relation', to: 'user', count: 1, inverseRelation: 'orders' } },
    { name: 'total', type: { kind: 'money', currency: 'USD' } },
    { name: 'note', type: { kind: 'text' }, nullable: true },
  ],
  count: 5000,
  bytes: 48,
};
// capability-gating.test.ts: a tabular function so `tabular-function-call` / function sources apply.
const genRows: FunctionDef = { name: 'genRows', shape: 'tabular', params: [], output: { type: 'order' } };
// capability-gating.test.ts plainEngine(): a capability-free type
const widgetTypeDef: TypeDef = { name: 'widget', fields: [{ name: 'id', type: { kind: 'number', whole: true } }, { name: 'label', type: { kind: 'text' } }], count: 10 };

/** _utils.ts `fixture()` (+ genRows). */
export function fixtureRegistry(): Registry {
  const registry = createRegistry();
  registry.registerType(registry.parseType(userTypeDef));
  registry.registerType(registry.parseType(orderTypeDef));
  registry.registerFunction(genRows);
  registry.finalize();
  return registry;
}
export function plainRegistry(): Registry {
  const registry = createRegistry();
  registry.registerType(registry.parseType(widgetTypeDef));
  registry.finalize();
  return registry;
}
// operator.test.ts: the worked PostGIS registry (a refinement type + two operators + `parcel`)
export function geoRegistry(): Registry {
  const registry = createRegistry();
  registry.registerFieldType({
    name: 'Geometry',
    base: 'json',
    instructions: 'A PostGIS geometry, carried as GeoJSON. Compare two geometries with ST_Contains / ST_Within or the && operator, and order by distance with <->; `=` and `<` are not defined on one.',
    ownOptions: {
      subtype: { type: { kind: 'text', values: [{ value: 'Point' }, { value: 'Polygon' }] }, default: 'Point' },
      srid: { type: { kind: 'number', whole: true }, default: 4326 },
    },
    sql: { postgres: 'geometry({subtype},{srid})' },
    cast: { postgres: 'ST_GeomFromGeoJSON({value})' },
    compare: { equality: false, ordering: false, textMatch: false },
  });
  registry.registerOperator({
    name: '&&',
    operands: [{ name: 'left', type: { kind: 'json', as: 'Geometry' } }, { name: 'right', type: { kind: 'json', as: 'Geometry' } }],
    output: { kind: 'bool' },
    instructions: 'Bounding-box overlap between two geometries. Cheap and GiST-index-assisted; use it as a pre-filter before an exact ST_Contains / ST_Within.',
    emit: { postgres: '({left} && {right})' },
  });
  registry.registerOperator({
    name: '<->',
    operands: [{ name: 'left', type: { kind: 'json', as: 'Geometry' } }, { name: 'right', type: { kind: 'json', as: 'Geometry' } }],
    output: { kind: 'number' },
    instructions: 'Distance between two geometries, in the SRID unit. In ORDER BY it uses a KNN index scan.',
    emit: { postgres: '({left} <-> {right})' },
  });
  registry.registerType(registry.parseType({
    name: 'parcel',
    count: 250_000,
    fields: [
      { name: 'id', type: { kind: 'number', whole: true } },
      { name: 'name', type: { kind: 'text', maxLength: 200 } },
      { name: 'shape', type: { kind: 'json', as: 'Geometry', with: { subtype: 'Polygon' } } },
    ],
  }));
  registry.finalize();
  return registry;
}

// ============================================================================
// The catalog adapter: a real registry → the port's catalog (facts only)
// ============================================================================

const GATED: readonly GatedKind[] = ['field-ref', 'semantic', 'text-search', 'text-score', 'filters', 'array-op'];
let version = 0;

/** exprs/operator.ts `signatureOf` + `typeOf`. */
const typeOf = (ft: { as?: string | undefined; resolve(): string } | undefined) => (!ft ? 'any' : ft.as === undefined ? ft.resolve() : `${ft.resolve()} as ${ft.as}`);

export function catalogOf(registry: Registry): QueryCatalog {
  registry.finalize();
  const types: CatalogType[] = registry.typeList().map((t) => {
    const backing = registry.backing(t.name);
    return {
      name: t.name,
      insertable: t.insertable,
      updatable: t.updatable,
      deletable: t.deletable,
      searchable: t.isSearchable(),
      semantic: t.isSemantic(),
      fields: t.fields.map((f) => {
        const fb = backing?.fields?.[f.name];
        const insertable = f.insertableFor(fb);
        return {
          name: f.name,
          type: f.fieldType.toJSON() as never,
          nullable: f.nullable,
          allows: Object.fromEntries(GATED.map((k) => [k, f.allowsExpr(k)])) as Record<GatedKind, boolean>,
          relation: t.relationFields().includes(f),
          semantic: t.semanticFields().includes(f),
          text: t.textFields().includes(f),
          insertable,
          updatable: f.updatableFor(fb),
          // write-model.ts requiredOnInsert
          requiredOnInsert: insertable && !f.nullable && fb?.default === undefined && !fb?.compute,
        };
      }),
    };
  });
  return {
    version: ++version,
    types,
    functions: registry.functionList().map((f) => ({ name: f.name, shape: f.shape, params: f.params.map((p) => ({ name: p.name, ...(p.optional ? { optional: true } : {}) })) })),
    operators: registry.operatorList().map((o) => ({
      name: o.name,
      operands: o.operands.map((x) => x.name),
      glossary: `${o.name}(${o.operands.map((x) => `${x.name}: ${typeOf(x.fieldType)}`).join(', ')}) → ${typeOf(o.output)} — ${o.instructions}`,
      // schema-build.ts operatorReachable
      reachable: o.operands.some((x) => registry.typeList().some((t) => t.fields.some((f) => x.fieldType === undefined || x.fieldType.comparableWith(f.fieldType)))),
    })),
  };
}

