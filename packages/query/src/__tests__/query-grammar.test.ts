/**
 * The query grammar as `@aeye/schema` (`llm/grammar.ts`), end to end.
 *
 * - FAITHFUL: at every depth level of every axis, the presets, the `strict`
 *   sugar, function selectors and `maxEnumSize` ladders, every probe gets the
 *   same verdict from `buildSchemas(...).Query` as from the step-1 corpus port
 *   (`packages/schema/src/__tests__/corpus/query.ts`), which was checked
 *   value-for-value against query's former zod `buildSchemas` (24 configs × 49
 *   probes, a capability-free registry, the PostGIS operator registry).
 *   The JSON the model is sent is the same too.
 * - Real answers decode on OpenAI strict / Anthropic strict / Gemini / lenient.
 * - Errors for the model at each detail level, through `buildQueryTool`.
 * - Requests degrade with query's tool among many (OpenAI's 128-tool cap).
 * - Caching: binds per (registry identity, version, options), nothing held
 *   per call (the zod path's `sharedIdRegistry` leak is gone).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  a, Bundle, ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, OPENAI_STRICT, SchemaParseError, type Profile,
} from '@aeye/schema';
import { planRequest, Tool, type Context } from '@aeye/core';
import { createRegistry, type Registry } from '../registry';
import { QueryEngine } from '../engine';
import type { ExprDef, FunctionDef, QueryDef, TypeDef } from '../schema';
import type { Expr } from '../expr';
import { buildSchemas, QUERY_RESULTS, QUERY_BIND_CACHE_SIZE, type BuildSchemasOptions } from '../llm/schemas';
import { buildQueryTool } from '../llm/tool';
import { orderTypeDef, userTypeDef } from './_utils';
// The step-1 corpus port, the reference (it was proven against the zod buildSchemas).
import { QuerySchema as PortQuery, type BuildOptions } from '../../../schema/src/__tests__/corpus/query';
import { catalogOf } from '../../../schema/src/__tests__/corpus/query-fixtures';

// ============================================================================
// Registries (the corpus's fixtures, on this package's own registry)
// ============================================================================

const genRows: FunctionDef = { name: 'genRows', shape: 'tabular', params: [], output: { type: 'order' } };
const widgetTypeDef: TypeDef = { name: 'widget', fields: [{ name: 'id', type: { kind: 'number', whole: true } }, { name: 'label', type: { kind: 'text' } }], count: 10 };

function fixtureRegistry(): Registry {
  const r = createRegistry();
  r.registerType(r.parseType(userTypeDef));
  r.registerType(r.parseType(orderTypeDef));
  r.registerFunction(genRows);
  r.finalize();
  return r;
}
function plainRegistry(): Registry {
  const r = createRegistry();
  r.registerType(r.parseType(widgetTypeDef));
  r.finalize();
  return r;
}
function geoRegistry(): Registry {
  const r = createRegistry();
  r.registerFieldType({
    name: 'Geometry',
    base: 'json',
    instructions: 'A PostGIS geometry, carried as GeoJSON.',
    ownOptions: {
      subtype: { type: { kind: 'text', values: [{ value: 'Point' }, { value: 'Polygon' }] }, default: 'Point' },
      srid: { type: { kind: 'number', whole: true }, default: 4326 },
    },
    sql: { postgres: 'geometry({subtype},{srid})' },
    cast: { postgres: 'ST_GeomFromGeoJSON({value})' },
    compare: { equality: false, ordering: false, textMatch: false },
  });
  const geom = { name: 'left', type: { kind: 'json' as const, as: 'Geometry' } };
  r.registerOperator({ name: '&&', operands: [geom, { ...geom, name: 'right' }], output: { kind: 'bool' }, instructions: 'Bounding-box overlap.', emit: { postgres: '({left} && {right})' } });
  r.registerOperator({ name: '<->', operands: [geom, { ...geom, name: 'right' }], output: { kind: 'number' }, instructions: 'Distance.', emit: { postgres: '({left} <-> {right})' } });
  r.registerType(r.parseType({
    name: 'parcel',
    count: 250_000,
    fields: [
      { name: 'id', type: { kind: 'number', whole: true } },
      { name: 'name', type: { kind: 'text', maxLength: 200 } },
      { name: 'shape', type: { kind: 'json', as: 'Geometry', with: { subtype: 'Polygon' } } },
    ],
  }));
  r.finalize();
  return r;
}

const fx = fixtureRegistry();
const plain = plainRegistry();
const geo = geoRegistry();

// ============================================================================
// Probes (the corpus's)
// ============================================================================

const ref = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });
const select = (expr: ExprDef, from = 'user'): QueryDef => ({ kind: 'select', fields: [{ expr }], from: { kind: 'type', type: from } });

/** Valid for the fixture at every depth. */
const VALID: Record<string, QueryDef> = {
  fieldRef: select(ref('user', 'name')),
  ordered: { kind: 'select', fields: [{ expr: ref('order', 'note') }, { expr: ref('order', 'total') }], from: { kind: 'type', type: 'order' }, order: [{ expr: ref('order', 'total'), dir: 'desc' }] },
  param: {
    kind: 'select', fields: [{ expr: ref('order', 'id') }], from: { kind: 'type', type: 'order' },
    where: [{ kind: 'comparison', op: '=', left: ref('order', 'note'), right: { kind: 'param', name: 'note' } }], limit: { kind: 'param', name: 'limit' },
  },
  groupCount: {
    kind: 'select',
    fields: [{ expr: ref('user', 'name'), as: 'name' }, { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'count' }],
    from: { kind: 'type', type: 'user' },
    groupBy: [ref('user', 'name')],
    order: [{ expr: { kind: 'output', name: 'count' }, dir: 'desc', nulls: 'last' }],
    having: [{ kind: 'output', name: 'count' }],
  },
  join: {
    kind: 'select', from: { kind: 'type', type: 'user' },
    joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'o' }, joinType: 'inner' }],
    fields: [{ expr: ref('user', 'id'), as: 'userId' }],
  },
  rich: {
    kind: 'select', distinct: true,
    fields: [
      { expr: { kind: 'case', branches: [{ when: { kind: 'is-null', value: ref('user', 'age') }, then: { kind: 'literal', value: 'unknown' } }], else: { kind: 'binary', op: '+', left: ref('user', 'age'), right: { kind: 'unary', op: '-', operand: { kind: 'literal', value: 1 } } } }, as: 'ageish' },
      { expr: { kind: 'literal', value: { nested: [1, 'two', null, { deep: true }] } }, as: 'doc' },
    ],
    from: { kind: 'type', type: 'user' },
    where: [{
      kind: 'logical', op: 'and', operands: [
        { kind: 'in', value: ref('user', 'id'), in: { kind: 'select', fields: [{ expr: ref('order', 'userId') }], from: { kind: 'type', type: 'order' } } },
        { kind: 'exists', query: select(ref('order', 'id'), 'order'), not: false },
        { kind: 'between', value: ref('user', 'age'), lower: { kind: 'literal', value: 18 }, upper: { kind: 'literal', value: 65 } },
        { kind: 'in', value: ref('user', 'name'), in: [{ kind: 'literal', value: 'Ada' }], not: true },
      ],
    }],
    limit: 10, offset: 0,
  },
  sorter: {
    kind: 'select', fields: [{ expr: ref('user', 'name') }], from: { kind: 'type', type: 'user' },
    order: [{ kind: 'sorter', sorts: { byName: ref('user', 'name'), byAge: { kind: 'output', name: 'age' } }, defaultSort: [{ sort: 'byName', dir: 'asc' }] }],
  },
  search: {
    kind: 'select', fields: [{ expr: ref('user', 'email') }], from: { kind: 'type', type: 'user' },
    where: [
      { kind: 'text-search', source: 'user', field: 'email', query: { kind: 'param', name: 'q' } },
      { kind: 'array-op', op: 'containsAny', target: ref('user', 'tags'), value: [{ kind: 'literal', value: 'beta' }] },
      { kind: 'filters', source: 'user', fields: ['name'] },
    ],
  },
  setop: { kind: 'union', all: true, left: select(ref('user', 'name')), right: select(ref('user', 'email')), order: [{ expr: ref('user', 'name'), dir: 'asc' }], limit: 5 },
  cte: { kind: 'cte', ctes: [{ name: 'big', query: select(ref('order', 'id'), 'order') }, { name: 'tree', base: select(ref('user', 'id')), recursive: select(ref('user', 'id')) }], final: { kind: 'expr', expr: { kind: 'literal', value: 1 } } },
  fnSource: { kind: 'select', fields: [{ expr: { kind: 'aggregate', function: 'count', args: {} } }], from: { kind: 'function', function: 'genRows', args: {}, as: 'g' } },
  window: { kind: 'select', fields: [{ expr: { kind: 'window', function: 'rowNumber', args: {}, partitionBy: [ref('user', 'name')], orderBy: [{ expr: ref('user', 'id'), dir: 'asc' }] } }], from: { kind: 'type', type: 'user' } },
  insert: { kind: 'insert', into: 'order', rows: [{ id: 1, userId: 'u1', total: 9.5, note: { kind: 'param', name: 'note' } }], returning: [{ expr: ref('order', 'id') }] },
  update: { kind: 'update', type: 'user', set: { name: { kind: 'function-call', function: 'upper', args: { value: ref('user', 'name') } } }, where: [{ kind: 'is-null', value: ref('user', 'age') }] },
  delete: { kind: 'delete', from: 'order', where: [{ kind: 'comparison', op: '=', left: ref('order', 'id'), right: { kind: 'param', name: 'id' } }] },
  upsert: { kind: 'insert', into: 'user', rows: [{ id: { kind: 'param', name: 'id' }, name: 'Ada', email: 'a@x' }], onConflict: { fields: ['id'], update: { name: { kind: 'excluded', field: 'name' } } } },
};

const PROBES: Record<string, unknown> = {
  ...VALID,
  crossTypeField: select(ref('user', 'total')),
  unknownField: select(ref('user', 'nope')),
  unknownSource: select(ref('ghost', 'name')),
  unknownType: { kind: 'select', fields: [{ expr: ref('ghost', 'x') }], from: { kind: 'type', type: 'ghost' } },
  unknownFn: select({ kind: 'function-call', function: 'no_such_fn', args: {} }),
  upperWrongArg: select({ kind: 'function-call', function: 'upper', args: { wrong: ref('user', 'name') } }),
  upperRightArg: select({ kind: 'function-call', function: 'upper', args: { value: ref('user', 'name') } }),
  countDistinct: select({ kind: 'aggregate', function: 'count', args: {}, distinct: true }),
  countNoArgs: select({ kind: 'aggregate', function: 'count' } as ExprDef),
  filtersOpen: select({ kind: 'filters', source: 'anything', fields: ['whatever'] }),
  filtersPaired: select({ kind: 'filters', source: 'user', fields: ['name', 'age'] }),
  filtersCross: select({ kind: 'filters', source: 'user', fields: ['total'] }),
  semantic: select({ kind: 'semantic', source: 'user', field: 'email', query: 'ada' }),
  textScore: select({ kind: 'text-score', source: 'user', query: 'ada' }),
  badRelationJoin: { ...VALID.join, joins: [{ on: { kind: 'relation', source: 'user', field: 'name', as: 'x' } }] },
  manualJoin: { ...VALID.fieldRef, joins: [{ on: { kind: 'type', type: 'order' }, and: { kind: 'comparison', op: '=', left: ref('order', 'userId'), right: ref('user', 'id') }, joinType: 'left' }] },
  insertUnknownField: { kind: 'insert', into: 'order', rows: [{ id: 1, userId: 'u', total: 1, ghost: 2 }] },
  insertMissingRequired: { kind: 'insert', into: 'order', rows: [{ note: 'x' }] },
  insertWrongValue: { kind: 'insert', into: 'order', rows: [{ id: 'one', userId: 'u', total: 1 }] },
  insertIntoGhost: { kind: 'insert', into: 'ghost', rows: [] },
  updateUnknownField: { kind: 'update', type: 'user', set: { ghost: 1 } },
  wrongKind: { kind: 'selectt', fields: [], from: { kind: 'type', type: 'user' } },
  badOp: select({ kind: 'comparison', op: '==', left: ref('user', 'id'), right: { kind: 'literal', value: 1 } } as never),
  missingField: { kind: 'select', from: { kind: 'type', type: 'user' } },
  outputInWhere: { kind: 'select', fields: [], from: { kind: 'type', type: 'user' }, where: [{ kind: 'output', name: 'x' }] },
  sorterInWhere: { kind: 'select', fields: [], from: { kind: 'type', type: 'user' }, where: [{ kind: 'sorter', sorts: {} }] },
};

const PLAIN_PROBES: Record<string, unknown> = {
  widgetRef: select(ref('widget', 'id'), 'widget'),
  widgetFilters: select({ kind: 'filters', source: 'widget' }, 'widget'),
  widgetSemantic: select({ kind: 'semantic', source: 'widget', query: 'hi' }, 'widget'),
  widgetTextSearch: select({ kind: 'text-search', source: 'widget', query: 'hi' }, 'widget'),
  widgetArrayOp: select({ kind: 'array-op', op: 'isEmpty', target: ref('widget', 'id') }, 'widget'),
  widgetEmptyJoins: { ...select(ref('widget', 'id'), 'widget'), joins: [] },
  widgetJoin: { ...select(ref('widget', 'id'), 'widget'), joins: [{ on: { source: 'widget', field: 'nope' } }] },
  widgetTabular: select({ kind: 'tabular-function-call', function: 'gen', args: {} }, 'widget'),
};

const GEO_PROBES: Record<string, unknown> = {
  overlaps: select({ kind: 'operator', op: '&&', args: { left: ref('parcel', 'shape'), right: { kind: 'param', name: 'box' } } } as ExprDef, 'parcel'),
  distance: select({ kind: 'operator', op: '<->', args: { left: ref('parcel', 'shape'), right: ref('parcel', 'shape') } } as ExprDef, 'parcel'),
  unknownOperator: select({ kind: 'operator', op: '@@', args: {} } as ExprDef, 'parcel'),
  wrongOperand: select({ kind: 'operator', op: '&&', args: { left: ref('parcel', 'shape'), middle: ref('parcel', 'shape') } } as ExprDef, 'parcel'),
};

/** Every level of every axis, the presets, the sugar, function selectors and the degrade budget (the corpus's 24). */
const CONFIGS: BuildOptions[] = [
  {}, { depth: 'open' }, { depth: 'paired' }, { strict: true }, { strict: false },
  ...(['open', 'types', 'fields', 'both', 'paired'] as const).map((refs) => ({ depth: { refs } })),
  { depth: { typeNames: 'enum' } },
  { depth: { functions: 'names' } },
  { depth: { functions: 'typed' } },
  { depth: { functions: 'names' }, functions: 'none' },
  { depth: { functions: 'typed' }, functions: ['upper', 'count'] },
  { depth: { functions: 'typed' }, functions: { scalar: ['upper'], aggregate: 'all', window: 'none' } },
  { depth: { filters: 'paired' } },
  { depth: { writes: 'names' } },
  { depth: { writes: 'typed' } },
  { depth: 'paired', maxEnumSize: 1 },
  { depth: 'paired', maxEnumSize: 3 },
  { depth: 'paired', maxEnumSize: 6 },
  { strict: true, maxEnumSize: 100 },
  { depth: 'paired', types: ['user'] },
];

/** The port's options as this package's (`types` by instance). */
const ours = (registry: Registry, o: BuildOptions): BuildSchemasOptions =>
  ({ ...o, ...(o.types ? { types: registry.typeList().filter((t) => o.types!.includes(t.name)) } : {}) }) as BuildSchemasOptions;

const clone = <T>(v: T): T => structuredClone(v);

function mismatches(registry: Registry, probes: Record<string, unknown>, configs: readonly BuildOptions[]): string[] {
  const out: string[] = [];
  const cat = catalogOf(registry as never);
  for (const o of configs) {
    const real = buildSchemas(registry, ours(registry, o)).Query.render(LENIENT);
    const port = PortQuery.render(LENIENT, cat, o);
    for (const [name, v] of Object.entries(probes)) {
      const mine = real.parse(clone(v));
      const theirs = port.parse(clone(v));
      if (mine.ok !== theirs.ok) out.push(`${JSON.stringify(o)} ${name}: port ${theirs.ok ? 'accepts' : 'rejects'}, query ${mine.ok ? 'accepts' : `rejects:\n${mine.ok ? '' : mine.message}`}`);
    }
  }
  return out;
}

/** A ref-free schema as its own bundle. */
const lenientOf = (s: unknown) => new Bundle<unknown>({}, s as never).bind();

const PROFILES: readonly Profile[] = [LENIENT, OPENAI_STRICT, ANTHROPIC_STRICT, GOOGLE_STRICT];

// ============================================================================
// Faithfulness
// ============================================================================

describe('the grammar accepts exactly what the verified port (and so the old zod buildSchemas) accepts', () => {
  it('the fixture, at every depth / preset / selector / budget', () => {
    expect(mismatches(fx, PROBES, CONFIGS)).toEqual([]);
  });

  it('a capability-free registry: gated kinds are gone, joins must be empty', () => {
    expect(mismatches(plain, PLAIN_PROBES, CONFIGS.slice(0, 12))).toEqual([]);
  });

  it('registered operators: open / names / typed', () => {
    expect(mismatches(geo, GEO_PROBES, [{}, { depth: { functions: 'names' } }, { depth: { functions: 'typed' } }])).toEqual([]);
  });

  it('the probes discriminate: verdicts flip with the depth; the corpus is valid at the paired preset', () => {
    const verdicts = new Map<string, Set<boolean>>();
    for (const o of CONFIGS) {
      const r = buildSchemas(fx, ours(fx, o)).Query.render(LENIENT);
      for (const [n, v] of Object.entries(PROBES)) {
        if (!verdicts.has(n)) verdicts.set(n, new Set());
        verdicts.get(n)!.add(r.parse(clone(v)).ok);
      }
    }
    const flips = [...verdicts].filter(([, s]) => s.size === 2).map(([n]) => n);
    expect(flips).toEqual(expect.arrayContaining(['countNoArgs', 'crossTypeField', 'filtersCross', 'unknownField', 'unknownFn', 'unknownType', 'upperWrongArg']));
    const never = [...verdicts].filter(([, s]) => s.size === 1 && s.has(false)).map(([n]) => n);
    expect(never).toEqual(expect.arrayContaining(['badOp', 'missingField', 'outputInWhere', 'sorterInWhere', 'wrongKind', 'insertUnknownField', 'updateUnknownField']));
    const paired = buildSchemas(fx, { strict: true }).Query.render(LENIENT);
    for (const [n, v] of Object.entries(VALID)) expect([n, paired.parse(clone(v)).ok]).toEqual([n, true]);
  });

  it('the model is sent the same JSON as from the port, on every profile family', () => {
    const cat = catalogOf(fx as never);
    for (const o of [{}, { strict: true }, { depth: { writes: 'typed' } }] as BuildOptions[]) {
      for (const p of PROFILES) {
        const mine = buildSchemas(fx, ours(fx, o)).Query.render(p).jsonSchema;
        const theirs = PortQuery.render(p, cat, o).jsonSchema;
        expect(isDeepStrictEqual(mine, theirs), `${JSON.stringify(o)} on ${p.id}`).toBe(true);
      }
    }
  });
});

// ============================================================================
// Real answers, every profile family
// ============================================================================

describe('answers decode on every profile family', () => {
  for (const o of [{}, { strict: true }] as BuildSchemasOptions[]) {
    it(`every valid query, written as each model writes it, decodes back to the code shape — ${JSON.stringify(o)}`, () => {
      const bound = buildSchemas(fx, o).Query;
      for (const p of PROFILES) {
        const r = bound.render(p);
        for (const [n, v] of Object.entries(VALID)) {
          // (At the open write depth a raw row value isn't an expression: only what the grammar takes.)
          if (!bound.render(LENIENT).parse(clone(v)).ok) continue;
          const wire = r.encode(clone(v));
          const res = r.parse(clone(wire));
          expect([p.id, n, res.ok]).toEqual([p.id, n, true]);
          if (res.ok) expect([p.id, n, res.value]).toEqual([p.id, n, v]);
        }
      }
    });
  }

  it('OpenAI strict: nulls for absent, pairs for records, JSON text for literal values — decoded in place', () => {
    const r = buildSchemas(fx, { strict: true }).Query.render(OPENAI_STRICT);
    // What an OpenAI strict model writes for VALID.update (a SET record as pairs, nulls for the absent).
    const wire = r.encode(clone(VALID.update!)) as Record<string, unknown>;
    expect(JSON.stringify(wire)).toContain('null');
    const res = r.parse(wire);
    expect(res.ok && res.value).toEqual(VALID.update);
    // A decoded value is query's own QueryDef, usable without a cast.
    if (res.ok) {
      const q: QueryDef = res.value;
      expect(q.kind).toBe('update');
    }
  });

  it('a typed fn with no required params: args may be left out and decode as {} (as ExprDef has it)', () => {
    const r = buildSchemas(fx, { strict: true }).Expr.render(OPENAI_STRICT);
    const res = r.parse({ input: { kind: 'aggregate', function: 'count', args: null, distinct: null } });
    expect(res.ok && res.value).toEqual({ kind: 'aggregate', function: 'count', args: {} });
  });

  it('a 1k-row typed insert decodes (pairs ↔ rows) on OpenAI strict', () => {
    const r = buildSchemas(fx, { strict: true }).Query.render(OPENAI_STRICT);
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i, userId: `u${i}`, total: i / 2 }));
    const q: QueryDef = { kind: 'insert', into: 'order', rows };
    const res = r.parse(r.encode(clone(q)));
    expect(res.ok && res.value).toEqual(q);
  });
});

// ============================================================================
// Errors for the model, through the tool
// ============================================================================

const ctx: Context<{}, {}> = {};
const engine = new QueryEngine(fx);

async function told(options: Parameters<typeof buildQueryTool>[1], query: unknown): Promise<string> {
  const tool = buildQueryTool(engine, options);
  const err = await tool.parse(ctx, JSON.stringify({ query })).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(SchemaParseError);
  return (err as SchemaParseError).message;
}

describe('errors for the model at each detail level', () => {
  const typo = { ...VALID.param!, where: [{ kind: 'comparison', op: 'notlike', left: ref('order', 'note'), right: { kind: 'literal', value: 1 } }] };
  const semantic = select(ref('user', 'ghost'));

  it('summary < list < markers <= full, all under the 2000-character cap; markers and full echo the JSON with a marker', async () => {
    const sizes: Record<string, number> = {};
    for (const detail of ['summary', 'list', 'markers', 'full'] as const) {
      const message = await told({ strict: true, errorFormat: detail }, typo);
      sizes[detail] = message.length;
      expect(message.length).toBeLessThanOrEqual(2000);
      if (detail === 'markers' || detail === 'full') expect(message).toContain('^');
      else expect(message).not.toContain('^');
    }
    expect(sizes.summary!).toBeLessThan(sizes.list!);
    expect(sizes.list!).toBeLessThan(sizes.markers!);
    expect(sizes.markers!).toBeLessThanOrEqual(sizes.full!);
  });

  it('full: "did you mean" for a misspelt enum value, at the path the model wrote it', async () => {
    const message = await told({ strict: true }, typo);
    expect(message).toContain('query.where[0].op');
    expect(message).toContain('did you mean `notLike`');
  });

  it('a SEMANTIC problem (unknown field at the open depth) reaches the model at its path, in the same format', async () => {
    const message = await told({}, semantic);
    expect(message).toContain("has no field 'ghost'");
    expect(message).toContain('^');
    const summary = await told({ errorFormat: 'summary' }, semantic);
    expect(summary.length).toBeLessThan(message.length);
  });

  it('maxChars caps a huge answer\'s message', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ id: `x${i}`, userId: 'u', total: 1 }));
    const message = await told({ strict: true, errorFormat: { maxChars: 600 } }, { kind: 'insert', into: 'order', rows });
    expect(message.length).toBeLessThanOrEqual(600);
  });
});

// ============================================================================
// The tool through a real request plan
// ============================================================================

const MODELS = {
  gpt: { id: 'gpt-4o', provider: 'openai', capabilities: ['toolsStrict', 'structured', 'json'] },
  claude: { id: 'claude-sonnet-4-5', provider: 'anthropic', capabilities: ['toolsStrict', 'structured'] },
  gemini: { id: 'gemini-2.5-pro', provider: 'google', capabilities: ['toolsStrict', 'structured', 'json'] },
  ollama: { id: 'llama3.1', provider: 'ollama', capabilities: ['json'] },
} as const;

describe('buildQueryTool end to end through a request plan', () => {
  for (const [name, model] of Object.entries(MODELS)) {
    it(`${name}: the plan sends the grammar; a call written as this model writes it decodes to a runnable Query`, async () => {
      const tool = buildQueryTool(engine, { strict: true });
      const compiled = await tool.compile(ctx);
      const plan = planRequest({ tools: [compiled![1]] }, model);
      const query = engine.parseQuery(VALID.ordered!);
      const call = plan.encodeCall('query', query);
      const decoded = await tool.parse(ctx, JSON.stringify(call.args), plan, undefined, { name: call.name });
      expect(decoded.toJSON()).toEqual(VALID.ordered);
    });
  }

  it('past OpenAI\'s 128 tools the query tool still decodes (directly or through the dispatcher), nothing errors', async () => {
    const tool = buildQueryTool(engine, { strict: true });
    const others = Array.from({ length: 139 }, (_, i) => new Tool({
      name: `t${i}`,
      description: `tool ${i}`,
      schema: a.object({ n: a.number(), tags: a.record(a.string()).optional() }),
      call: () => 'ok',
    }));
    const defs = [];
    for (const t of [tool, ...others]) defs.push((await t.compile(ctx))![1]);
    const plan = planRequest({ tools: defs }, MODELS.gpt);
    expect(plan.sent.length).toBeLessThanOrEqual(128);
    const query = engine.parseQuery(VALID.insert!);
    const call = plan.encodeCall('query', query);
    const decoded = await tool.parse(ctx, JSON.stringify(call.args), plan, undefined, { name: call.name });
    expect(decoded.toJSON()).toEqual(query.toJSON());
  });

  it('Anthropic: the query tool among many strict tools degrades (never errors) and still decodes', async () => {
    const tool = buildQueryTool(engine, { strict: true });
    const others = Array.from({ length: 30 }, (_, i) => new Tool({
      name: `s${i}`, description: `strict ${i}`, strict: true,
      schema: a.object({ q: a.string().optional(), when: a.string().optional() }), call: () => 'ok',
    }));
    const defs = [];
    for (const t of [tool, ...others]) defs.push((await t.compile(ctx))![1]);
    const plan = planRequest({ tools: defs }, MODELS.claude);
    expect(plan.degradations.length).toBeGreaterThan(0);
    const query = engine.parseQuery(VALID.join!);
    const call = plan.encodeCall('query', query);
    const decoded = await tool.parse(ctx, JSON.stringify(call.args), plan, undefined, { name: call.name });
    expect(decoded.toJSON()).toEqual(query.toJSON());
    // A semantic problem is told through the plan too, at its path.
    const bad = plan.encodeCall('query', engine.parseQuery(VALID.rich!));
    const err = await tool.parse(ctx, JSON.stringify(bad.args), plan, undefined, { name: bad.name }).then(() => undefined, (e: unknown) => e);
    expect((err as Error).message).toContain('is a relation, not a value');
  });
});

// ============================================================================
// Caching, versions, extension
// ============================================================================

describe('binds are cached per (registry, version, options); nothing is kept per call', () => {
  it('the same registry and options bind once', () => {
    const r = fixtureRegistry();
    expect(buildSchemas(r, { strict: true }).Query).toBe(buildSchemas(r, { strict: true }).Query);
    expect(buildSchemas(r, { strict: true }).Query).not.toBe(buildSchemas(r, {}).Query);
    // A registry with the same version but another identity gets its own grammar.
    expect(buildSchemas(fixtureRegistry(), { strict: true }).Query).not.toBe(buildSchemas(r, { strict: true }).Query);
  });

  it('a registration bumps the version: the next bind sees the new Type', () => {
    const r = fixtureRegistry();
    const before = buildSchemas(r, { strict: true }).Query;
    const v = r.version;
    r.registerType(r.parseType(widgetTypeDef));
    expect(r.version).toBeGreaterThan(v);
    const after = buildSchemas(r, { strict: true }).Query;
    expect(after).not.toBe(before);
    expect(before.render(LENIENT).parse(clone(select(ref('widget', 'id'), 'widget'))).ok).toBe(false);
    expect(after.render(LENIENT).parse(clone(select(ref('widget', 'id'), 'widget'))).ok).toBe(true);
  });

  it('the bind caches stay bounded however many registries go through (no process-global per-call registry)', () => {
    for (let i = 0; i < 50; i++) buildSchemas(fixtureRegistry(), { strict: true }).Query.render(LENIENT);
    for (const bundle of Object.values(QUERY_RESULTS)) {
      expect((bundle as unknown as { cache: Map<unknown, unknown> }).cache.size).toBeLessThanOrEqual(QUERY_BIND_CACHE_SIZE);
    }
  });
});

describe('a registered non-builtin expr kind contributes its branch through `toA`', () => {
  it('appears in the Expr union at the build\'s depth', () => {
    const r = fixtureRegistry();
    const MyExpr = {
      KIND: 'my-kind',
      INSTRUCTIONS: 'A test kind.',
      from: (): Expr => { throw new Error('not used'); },
      toA: (b: { types: readonly { name: string }[] }) => a.object({ kind: a.literal('my-kind'), on: a.enum(b.types.map((t) => t.name)) }),
    };
    r.defineExpr(MyExpr as never);
    const e = buildSchemas(r).Expr.render(LENIENT);
    expect(e.parse({ kind: 'my-kind', on: 'user' }).ok).toBe(true);
    expect(e.parse({ kind: 'my-kind', on: 'ghost' }).ok).toBe(false);
    // Without `toA` a registered kind is left out of the model's grammar.
    r.defineExpr({ KIND: 'silent', INSTRUCTIONS: '', from: MyExpr.from } as never);
    expect(buildSchemas(r).Expr.render(LENIENT).parse({ kind: 'silent' }).ok).toBe(false);
  });
});

describe('field types → the typed write values a model sees (FieldType.toA)', () => {
  const r = createRegistry();
  r.registerFieldType({ name: 'uuid', base: 'text', instructions: 'A UUID.', options: { minLength: 36, maxLength: 36 }, sql: { postgres: 'uuid' } });
  r.registerFieldTypeImpl('uuid', { value: z.uuid() });
  const ok = (def: Parameters<typeof r.parseFieldType>[0], v: unknown) => lenientOf(r.parseFieldType(def).toA()).render(LENIENT).parse(clone(v)).ok;

  it('bounds, whole numbers, patterns, closed sets (one or several), dates as a prefix, arrays, money, json, relations', () => {
    expect(ok({ kind: 'number', whole: true, min: 1, max: 9 }, 1.5)).toBe(false);
    expect(ok({ kind: 'number', whole: true, min: 1, max: 9 }, 10)).toBe(false);
    expect(ok({ kind: 'number', values: [{ value: 1 }, { value: 2 }] }, 2)).toBe(true);
    expect(ok({ kind: 'text', values: [{ value: 'open' }, { value: 'done', label: 'Done' }] }, 'done')).toBe(true);
    expect(ok({ kind: 'text', values: [{ value: 'open' }, { value: 'done' }] }, 'later')).toBe(false);
    expect(lenientOf(r.parseFieldType({ kind: 'text', values: [{ value: 'only' }] }).toA()).render(LENIENT).jsonSchema).toEqual({ type: 'string', enum: ['only'] });
    expect(ok({ kind: 'text', minLength: 2, maxLength: 3, pattern: '^a' }, 'abcd')).toBe(false);
    expect(ok({ kind: 'text', minLength: 2, maxLength: 3, pattern: '^a' }, 'ab')).toBe(true);
    expect(ok({ kind: 'date' }, '2026-11-24T10:00')).toBe(true); // query's ISO_DATE is a prefix match
    expect(ok({ kind: 'timestamp' }, '2026-11-24')).toBe(false);
    expect(ok({ kind: 'array', item: { kind: 'number' }, minItems: 1, maxItems: 2 }, [1, 2, 3])).toBe(false);
    expect(ok({ kind: 'array', item: { kind: 'number' }, minItems: 1, maxItems: 2 }, [])).toBe(false);
    expect(ok({ kind: 'array' }, [{ any: 1 }])).toBe(true);
    expect(ok({ kind: 'money', currency: 'USD', number: { min: 0 } }, -1)).toBe(false);
    expect(ok({ kind: 'money', currency: 'USD' }, 3.5)).toBe(true);
    expect(ok({ kind: 'json' }, { any: ['thing'] })).toBe(true);
    expect(ok({ kind: 'bool' }, 'yes')).toBe(false);
    expect(ok({ kind: 'relation', to: 'user', count: 1 }, 'u1')).toBe(true);
  });

  it('a refinement\'s declared value gate is checked on decode, and named in the message', () => {
    const uuid = lenientOf(r.parseFieldType({ kind: 'text', as: 'uuid' }).toA()).render(LENIENT);
    expect(uuid.parse('123e4567-e89b-12d3-a456-426614174000').ok).toBe(true);
    const bad = uuid.parse('x'.repeat(36));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('Not a valid `uuid` value.');
  });
});

describe('the build exposes the grammar\'s recursion points; the prose fallback encodes', () => {
  it('build.Expr / build.Query are the refs a custom kind nests', () => {
    const r = fixtureRegistry();
    r.defineExpr({
      KIND: 'wrap', INSTRUCTIONS: '', from: (): Expr => { throw new Error('unused'); },
      toA: (b: { Expr: unknown; Query: unknown }) => a.object({ kind: a.literal('wrap'), inner: b.Expr as never, sub: (b.Query as never as ReturnType<typeof a.string>).optional() }),
    } as never);
    const e = buildSchemas(r).Expr.render(LENIENT);
    expect(e.parse({ kind: 'wrap', inner: { kind: 'literal', value: 1 }, sub: VALID.fieldRef }).ok).toBe(true);
    expect(e.parse({ kind: 'wrap', inner: 'nope' }).ok).toBe(false);
  });

  it('string-fallback: the tool schema shows a query as prose text', async () => {
    const tool = buildQueryTool(engine, { max: 0 });
    const compiled = await tool.compile(ctx);
    const plan = planRequest({ tools: [compiled![1]] }, MODELS.gpt);
    const call = plan.encodeCall('query', engine.parseQuery(VALID.fieldRef!));
    expect(typeof (call.args as { query: unknown }).query).toBe('string');
  });
});
