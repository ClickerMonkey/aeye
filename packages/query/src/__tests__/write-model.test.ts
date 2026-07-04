/**
 * WRITE-MODEL / PERMISSIONS — Type/field insert/update/delete permissions, the
 * insert-requiredness rule, `FieldBacking.default` materialization, per-field
 * `exprs` restrictions, and how all of it flows into VALIDATION, SCHEMA-BUILDING,
 * RUNTIME, and DESCRIBE. One self-contained fixture set (does not touch `_utils`).
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { Value } from '../runtime/value';
import { buildSchemas } from '../llm/schemas';
import { requiredOnInsert } from '../write-model';
import { describeType, describeTypes, describeExprs } from '../llm/describe';
import type { Registry } from '../registry';
import type { TypeBacking } from '../backing';
import type { TypeDef, InsertDef, UpdateDef, DeleteDef, ExprDef } from '../schema';
import type { SourceRecord } from '../runtime/row';

const ref = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });
const lit = (value: string | number | boolean | null): ExprDef => ({ kind: 'literal', value });

// ─── The `doc` type: exercises every write-model deviation ────────────────────

const docDef: TypeDef = {
  name: 'doc',
  fields: [
    { name: 'id', type: { kind: 'text' } }, // required-on-insert
    { name: 'title', type: { kind: 'text', search: true, semantic: true }, exprs: { not: ['semantic'] } }, // required
    { name: 'body', type: { kind: 'text' } }, // required
    { name: 'tags', type: { kind: 'array', item: { kind: 'text' } } }, // required (array)
    { name: 'rank', type: { kind: 'number' } }, // required
    { name: 'onlyCmp', type: { kind: 'text' }, exprs: { only: ['comparison'] } }, // required
    { name: 'secret', type: { kind: 'text' }, insertable: false }, // non-insertable
    { name: 'locked', type: { kind: 'text' }, nullable: true, updatable: false }, // optional, non-updatable
    { name: 'status', type: { kind: 'text' }, nullable: true }, // optional (nullable)
    { name: 'createdAt', type: { kind: 'text' } }, // optional (ready-value default)
    { name: 'uuid', type: { kind: 'text' } }, // optional (async-factory default)
    { name: 'seq', type: { kind: 'number' } }, // optional (sync-factory default)
    { name: 'slug', type: { kind: 'text' } }, // computed ⇒ non-insertable/updatable
  ],
  indexes: [{ exprs: [{ expr: ref('doc', 'id'), count: 1 }] }],
  count: 100,
  bytes: 64,
};

const docBacking = (r: Registry): TypeBacking => ({
  fields: {
    createdAt: { default: Value.of('2020-01-01') }, // a ready value
    uuid: { default: () => Promise.resolve(Value.of('u1')) }, // async factory
    seq: { default: () => Value.of(7) }, // sync factory
    slug: { compute: { expr: (alias) => r.parseExpr(ref(alias, 'id')) } }, // computed
  },
});

function docEngine(rows: SourceRecord[] = []): QueryEngine {
  const registry = createRegistry();
  const doc = registry.parseType(docDef);
  registry.registerType(doc, docBacking(registry));
  registry.finalize();
  return new QueryEngine(registry, { executors: { doc: arrayExecutor(rows) } });
}

/** A valid, fully-specified insert (all required fields present). */
function fullInsert(extra: string[] = []): InsertDef {
  const fields = ['id', 'title', 'body', 'tags', 'rank', 'onlyCmp', ...extra];
  const value = (f: string): ExprDef => (f === 'rank' || f === 'seq' ? lit(1) : f === 'tags' ? { kind: 'literal', value: null } : lit(f));
  return { kind: 'insert', into: 'doc', fields, values: [fields.map(value)] };
}

// ─── Model getters (Type / Field) ─────────────────────────────────────────────

describe('write-model: Type + Field getters and JSON round-trip', () => {
  it('Type defaults every write flag to true; restricted flags round-trip through JSON', () => {
    const registry = createRegistry();
    const doc = registry.parseType(docDef);
    expect(doc.insertable).toBe(true);
    expect(doc.updatable).toBe(true);
    expect(doc.deletable).toBe(true);

    const frozen = registry.parseType({ ...docDef, name: 'frozen', insertable: false, updatable: false, deletable: false });
    expect(frozen.insertable).toBe(false);
    const json = frozen.toJSON();
    expect(json.insertable).toBe(false);
    expect(json.updatable).toBe(false);
    expect(json.deletable).toBe(false);
    // A fully-mutable type omits the flags entirely.
    expect(doc.toJSON().insertable).toBeUndefined();
    // Re-parse preserves the restriction.
    expect(registry.parseType(json).deletable).toBe(false);
  });

  it('Field write flags + exprs round-trip; effective status honors backing', () => {
    const registry = createRegistry();
    const doc = registry.parseType(docDef);
    const secret = doc.field('secret')!;
    const locked = doc.field('locked')!;
    const title = doc.field('title')!;
    const plain = doc.field('body')!;

    expect(secret.insertable).toBe(false);
    expect(plain.insertable).toBe(true);
    expect(secret.toJSON().insertable).toBe(false);
    expect(locked.toJSON().updatable).toBe(false);
    expect(plain.toJSON().insertable).toBeUndefined();
    expect(title.toJSON().exprs).toEqual({ not: ['semantic'] });

    // clone preserves an explicit flag AND leaves an unset one implicit.
    expect(secret.clone().insertable).toBe(false);
    expect(locked.clone().updatable).toBe(false); // explicit updatable:false survives clone
    expect(plain.clone().toJSON().insertable).toBeUndefined();

    // insertableFor / updatableFor: explicit flag wins; a computed field defaults off.
    const fb = docBacking(registry);
    expect(secret.insertableFor(undefined)).toBe(false); // explicit false
    expect(plain.insertableFor(undefined)).toBe(true); // plain
    expect(doc.field('slug')!.insertableFor(fb.fields!['slug'])).toBe(false); // computed ⇒ off
    expect(doc.field('slug')!.updatableFor(fb.fields!['slug'])).toBe(false);
  });

  it('Field.allowsExpr honors the field-type floor AND the exprs restriction', () => {
    const registry = createRegistry();
    const doc = registry.parseType(docDef);
    const tags = doc.field('tags')!; // array
    const title = doc.field('title')!; // semantic text, exprs:{not:['semantic']}
    const body = doc.field('body')!; // plain text, no restriction
    const rank = doc.field('rank')!; // number
    const onlyCmp = doc.field('onlyCmp')!; // exprs:{only:['comparison']}

    // Field-type floor.
    expect(tags.allowsExpr('array-op')).toBe(true);
    expect(body.allowsExpr('array-op')).toBe(false); // not an array
    expect(body.allowsExpr('text-search')).toBe(true);
    expect(rank.allowsExpr('text-search')).toBe(false); // not text
    expect(title.allowsExpr('text-search')).toBe(true); // semantic text
    expect(rank.allowsExpr('semantic')).toBe(false);
    expect(rank.allowsExpr('comparison')).toBe(true); // type-agnostic kind

    // Restriction narrows.
    expect(title.allowsExpr('semantic')).toBe(false); // not-excluded
    expect(onlyCmp.allowsExpr('comparison')).toBe(true); // only-allowed
    expect(onlyCmp.allowsExpr('field-ref')).toBe(false); // only-excluded
    expect(body.allowsExpr('field-ref')).toBe(true); // no restriction
  });

  it('requiredOnInsert: an explicitly-insertable COMPUTED field is still not required', () => {
    const registry = createRegistry();
    const t = registry.parseType({ name: 'x', fields: [{ name: 'f', type: { kind: 'text' }, insertable: true }], count: 1, bytes: 8 });
    const f = t.field('f')!;
    // Explicit-insertable, non-nullable, no default, not computed ⇒ required.
    expect(requiredOnInsert(f, undefined)).toBe(true);
    // Same field, now COMPUTED ⇒ the rule still excludes it (never required).
    expect(requiredOnInsert(f, { compute: {} })).toBe(false);
  });
});

// ─── VALIDATION ───────────────────────────────────────────────────────────────

describe('write-model: validation gates', () => {
  const codes = (defQuery: InsertDef | UpdateDef | DeleteDef, engine = docEngine()): string[] =>
    engine.validateQuery(defQuery).list.map((p) => p.code);

  it('insert.type-readonly rejects a non-insertable Type', () => {
    const engine = docEngine();
    const readonlyEngine = frozenEngine();
    expect(codes(fullInsert(), engine)).not.toContain('insert.type-readonly');
    expect(readonlyEngine.validateQuery({ kind: 'insert', into: 'frozen', fields: ['id'], values: [[lit('a')]] }).list.map((p) => p.code)).toContain(
      'insert.type-readonly',
    );
  });

  it('insert.field-readonly rejects a non-insertable field (explicit + computed)', () => {
    const withSecret: InsertDef = { ...fullInsert(), fields: [...fullInsert().fields, 'secret'], values: [[...fullInsert().values![0]!, lit('x')]] };
    expect(codes(withSecret)).toContain('insert.field-readonly');
    const withSlug: InsertDef = { ...fullInsert(), fields: [...fullInsert().fields, 'slug'], values: [[...fullInsert().values![0]!, lit('x')]] };
    expect(codes(withSlug)).toContain('insert.field-readonly'); // computed ⇒ read-only
  });

  it('insert.missing-required lists the omitted required fields, and passes when all present', () => {
    const missing: InsertDef = { kind: 'insert', into: 'doc', fields: ['id'], values: [[lit('a')]] };
    const problems = docEngine().validateQuery(missing).list.filter((p) => p.code === 'insert.missing-required');
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('title');
    expect(problems[0]!.message).toContain('onlyCmp');
    // Optional (nullable / default) + non-insertable + computed are NOT required.
    expect(problems[0]!.message).not.toContain('status');
    expect(problems[0]!.message).not.toContain('createdAt');
    expect(problems[0]!.message).not.toContain('secret');
    expect(problems[0]!.message).not.toContain('slug');
    // All required present ⇒ no missing-required.
    expect(codes(fullInsert())).not.toContain('insert.missing-required');
  });

  it('update gates: type-readonly + field-readonly', () => {
    const engine = docEngine();
    const setLocked: UpdateDef = { kind: 'update', type: 'doc', set: [{ field: 'locked', value: lit('x') }] };
    expect(engine.validateQuery(setLocked).list.map((p) => p.code)).toContain('update.field-readonly');
    const setSlug: UpdateDef = { kind: 'update', type: 'doc', set: [{ field: 'slug', value: lit('x') }] };
    expect(engine.validateQuery(setSlug).list.map((p) => p.code)).toContain('update.field-readonly'); // computed
    const setBody: UpdateDef = { kind: 'update', type: 'doc', set: [{ field: 'body', value: lit('x') }] };
    expect(engine.validateQuery(setBody).list.map((p) => p.code)).not.toContain('update.field-readonly');

    const frozenUpdate: UpdateDef = { kind: 'update', type: 'frozen', set: [{ field: 'id', value: lit('x') }] };
    expect(frozenEngine().validateQuery(frozenUpdate).list.map((p) => p.code)).toContain('update.type-readonly');
  });

  it('delete.type-readonly rejects a non-deletable Type', () => {
    const del: DeleteDef = { kind: 'delete', from: 'frozen' };
    expect(frozenEngine().validateQuery(del).list.map((p) => p.code)).toContain('delete.type-readonly');
    expect(docEngine().validateQuery({ kind: 'delete', from: 'doc' }).list.map((p) => p.code)).not.toContain('delete.type-readonly');
  });

  it('field.expr-denied fires at direct-subject + operator sites, honoring only/not', () => {
    const engine = docEngine([{ id: 'a', title: 't', body: 'b', tags: ['x'] }]);
    // A standalone field-ref onlyCmp (only comparison allowed) is denied for 'field-ref'.
    const scope = () => {
      const s = engine.globalScope().child();
      s.bind('doc', { kind: 'type', type: engine.type('doc')!, source: 'doc', synthetic: false });
      return s;
    };
    const denied = (e: ExprDef): boolean =>
      engine.validateExpr(e, scope()).list.some((p) => p.code === 'field.expr-denied');

    expect(denied(ref('doc', 'onlyCmp'))).toBe(true); // field-ref self-gate
    expect(denied(ref('doc', 'body'))).toBe(false); // unrestricted
    // Operator: a comparison operand supplies its own kind → onlyCmp is ALLOWED there.
    expect(denied({ kind: 'comparison', op: '=', left: ref('doc', 'onlyCmp'), right: lit('x') })).toBe(false);
    // is-null / between / in over onlyCmp are NOT 'comparison' → denied.
    expect(denied({ kind: 'is-null', value: ref('doc', 'onlyCmp') })).toBe(true);
    expect(denied({ kind: 'between', value: ref('doc', 'onlyCmp'), lower: lit('a'), upper: lit('z') })).toBe(true);
    expect(denied({ kind: 'in', value: ref('doc', 'onlyCmp'), in: [lit('a')] })).toBe(true);
    // A nested (non-direct) field-ref self-gates as 'field-ref' (denied), not the operator kind.
    expect(denied({ kind: 'comparison', op: '=', left: { kind: 'binary', op: '+', left: ref('doc', 'onlyCmp'), right: lit(0) }, right: lit(1) })).toBe(true);

    // Direct-subject exprs check with their own kind.
    expect(denied({ kind: 'semantic', source: 'doc', field: 'title', query: 'hi' })).toBe(true); // title excludes semantic
    expect(denied({ kind: 'text-search', source: 'doc', field: 'title', query: 'hi' })).toBe(false); // text-search allowed
    expect(denied({ kind: 'text-score', source: 'doc', field: 'title', query: 'hi' })).toBe(false);
    expect(denied({ kind: 'filters', source: 'doc', fields: ['onlyCmp'] })).toBe(true); // filters denied on onlyCmp
  });

  it('array-op field.expr-denied honors an array field that excludes array-op', () => {
    const engine = arrEngine();
    const s = engine.globalScope().child();
    s.bind('arr', { kind: 'type', type: engine.type('arr')!, source: 'arr', synthetic: false });
    const denied = engine
      .validateExpr({ kind: 'array-op', op: 'isEmpty', target: ref('arr', 'items') }, s)
      .list.some((p) => p.code === 'field.expr-denied');
    expect(denied).toBe(true);
  });
});

// ─── SCHEMA BUILDING ──────────────────────────────────────────────────────────

describe('write-model: schema building', () => {
  it('drops the insert/update/delete kinds when NO Type permits them', () => {
    const schemas = buildSchemas(frozenEngine(), { depth: 'paired' });
    expect(schemas.Query.safeParse({ kind: 'insert', into: 'frozen', fields: [], values: [] }).success).toBe(false);
    expect(schemas.Query.safeParse({ kind: 'update', type: 'frozen', set: [] }).success).toBe(false);
    expect(schemas.Query.safeParse({ kind: 'delete', from: 'frozen' }).success).toBe(false);
    // But a SELECT still works.
    expect(schemas.Query.safeParse({ kind: 'select', fields: [{ expr: ref('frozen', 'id') }], from: { kind: 'type', type: 'frozen' } }).success).toBe(true);
  });

  it('filters into / type / from to the permitted Type subset (enum depth)', () => {
    const engine = perKindEngine();
    const schemas = buildSchemas(engine, { depth: { typeNames: 'enum' } });
    // insOnly is insertable but not updatable / deletable.
    expect(schemas.Insert.safeParse({ kind: 'insert', into: 'insOnly', fields: ['id'], values: [[lit('a')]] }).success).toBe(true);
    expect(schemas.Insert.safeParse({ kind: 'insert', into: 'updOnly', fields: ['id'], values: [[lit('a')]] }).success).toBe(false);
    expect(schemas.Update.safeParse({ kind: 'update', type: 'updOnly', set: [{ field: 'id', value: lit('a') }] }).success).toBe(true);
    expect(schemas.Update.safeParse({ kind: 'update', type: 'insOnly', set: [{ field: 'id', value: lit('a') }] }).success).toBe(false);
    expect(schemas.Delete.safeParse({ kind: 'delete', from: 'delOnly' }).success).toBe(true);
    expect(schemas.Delete.safeParse({ kind: 'delete', from: 'insOnly' }).success).toBe(false);
  });

  it('open depth leaves DML Type names as free strings', () => {
    const schemas = buildSchemas(docEngine()); // open
    expect(schemas.Insert.safeParse({ kind: 'insert', into: 'anything', fields: ['x'], values: [[lit('a')]] }).success).toBe(true);
  });

  it('paired Insert.fields require the required fields, allow the optional ones, and offer only insertable fields', () => {
    const schemas = buildSchemas(docEngine(), { depth: 'paired' });
    const ins = (fields: string[]): boolean =>
      schemas.Insert.safeParse({ kind: 'insert', into: 'doc', fields, values: [fields.map(() => lit('x'))] }).success;
    const required = ['id', 'title', 'body', 'tags', 'rank', 'onlyCmp'];
    expect(ins(required)).toBe(true); // all required present
    expect(ins([...required, 'status'])).toBe(true); // optional allowed
    expect(ins(['id', 'title', 'body', 'tags', 'rank'])).toBe(false); // missing onlyCmp
    expect(ins([...required, 'secret'])).toBe(false); // secret not insertable
    expect(ins([...required, 'slug'])).toBe(false); // slug computed
  });

  it('paired Update.set offers only updatable fields', () => {
    const schemas = buildSchemas(docEngine(), { depth: 'paired' });
    const set = (field: string): boolean => schemas.Update.safeParse({ kind: 'update', type: 'doc', set: [{ field, value: lit('x') }] }).success;
    expect(set('body')).toBe(true);
    expect(set('locked')).toBe(false); // updatable:false
    expect(set('slug')).toBe(false); // computed
  });

  it('paired schema omits a field that excludes the expr kind from operand enums', () => {
    const schemas = buildSchemas(docEngine(), { depth: 'paired' });
    // onlyCmp excludes 'field-ref' ⇒ never offered in a field-ref enum.
    expect(schemas.Expr.safeParse(ref('doc', 'onlyCmp')).success).toBe(false);
    expect(schemas.Expr.safeParse(ref('doc', 'body')).success).toBe(true);
  });

  it('gates array-op AWAY entirely when every array field excludes it', () => {
    const withArray = buildSchemas(docEngine(), { depth: 'paired' });
    expect(withArray.Expr.safeParse({ kind: 'array-op', op: 'isEmpty', target: ref('doc', 'tags') }).success).toBe(true);
    const noArrayOp = buildSchemas(arrEngine(), { depth: 'paired' });
    expect(noArrayOp.Expr.safeParse({ kind: 'array-op', op: 'isEmpty', target: ref('arr', 'items') }).success).toBe(false);
  });

  it('paired schema tolerates a Type with no insertable / updatable fields', () => {
    const schemas = buildSchemas(computedOnlyEngine(), { depth: 'paired' });
    // The one field is computed ⇒ no insertable / updatable fields; empty `fields` still parses.
    expect(schemas.Insert.safeParse({ kind: 'insert', into: 'comp', fields: [], values: [[]] }).success).toBe(true);
    expect(schemas.Update.safeParse({ kind: 'update', type: 'comp', set: [] }).success).toBe(true);
  });
});

// ─── RUNTIME ──────────────────────────────────────────────────────────────────

describe('write-model: runtime default materialization + guards', () => {
  it('materializes a ready-value, sync-factory, and async-factory default for omitted fields', async () => {
    const engine = docEngine([]);
    const insert: InsertDef = {
      ...fullInsert(),
      returning: [
        { expr: ref('doc', 'createdAt'), as: 'createdAt' },
        { expr: ref('doc', 'uuid'), as: 'uuid' },
        { expr: ref('doc', 'seq'), as: 'seq' },
        { expr: ref('doc', 'status'), as: 'status' },
      ],
    };
    const res = await engine.run(insert);
    expect(res.rows[0]).toEqual({ createdAt: '2020-01-01', uuid: 'u1', seq: 7, status: null });
    expect(engine.fieldHasDefault('doc', 'createdAt')).toBe(true);
    expect(engine.fieldHasDefault('doc', 'body')).toBe(false);
  });

  it('skips default materialization when no insertable field is omitted', async () => {
    const engine = docEngine([]);
    const all = ['id', 'title', 'body', 'tags', 'rank', 'onlyCmp', 'locked', 'status', 'createdAt', 'uuid', 'seq'];
    const def: InsertDef = {
      kind: 'insert',
      into: 'doc',
      fields: all,
      values: [all.map(() => lit('x'))],
      returning: [{ expr: ref('doc', 'id'), as: 'id' }],
    };
    expect((await engine.run(def)).rows[0]).toEqual({ id: 'x' });
  });

  it('a supplied optional field is not overwritten by its default', async () => {
    const engine = docEngine([]);
    const insert: InsertDef = {
      ...fullInsert(['seq']),
      returning: [{ expr: ref('doc', 'seq'), as: 'seq' }],
    };
    // fullInsert(['seq']) gives seq = 1 (see `value`), NOT the factory's 7.
    const res = await engine.run(insert);
    expect(res.rows[0]).toEqual({ seq: 1 });
  });

  it('belt-and-suspenders: execute throws on a read-only Type / field', async () => {
    await expect(frozenEngine([{ id: 'a' }]).run({ kind: 'insert', into: 'frozen', fields: ['id'], values: [[lit('a')]] })).rejects.toThrow(
      /not insertable/,
    );
    await expect(frozenEngine([{ id: 'a' }]).run({ kind: 'update', type: 'frozen', set: [{ field: 'id', value: lit('b') }] })).rejects.toThrow(
      /not updatable/,
    );
    await expect(frozenEngine([{ id: 'a' }]).run({ kind: 'delete', from: 'frozen' })).rejects.toThrow(/not deletable/);

    // Field-level guards.
    await expect(
      docEngine([]).run({ kind: 'insert', into: 'doc', fields: ['secret'], values: [[lit('x')]] }),
    ).rejects.toThrow(/'secret' of 'doc' is not insertable/);
    await expect(
      docEngine([{ id: 'a' }]).run({ kind: 'update', type: 'doc', set: [{ field: 'locked', value: lit('x') }] }),
    ).rejects.toThrow(/'locked' of 'doc' is not updatable/);
  });
});

// ─── DESCRIBE ─────────────────────────────────────────────────────────────────

describe('write-model: describe', () => {
  it('describeType notes read-only and partial write restrictions', () => {
    const registry = createRegistry();
    const frozen = registry.parseType({ ...docDef, name: 'frozen', insertable: false, updatable: false, deletable: false });
    expect(describeType(frozen)).toContain('write: read-only');
    const noInsert = registry.parseType({ ...docDef, name: 'ni', insertable: false });
    expect(describeType(noInsert)).toContain('write: no-insert');
    const noDelete = registry.parseType({ ...docDef, name: 'nd', updatable: false, deletable: false });
    expect(describeType(noDelete)).toContain('no-update, no-delete');
    // A fully-mutable type has no write clause.
    expect(describeType(registry.parseType(docDef))).not.toContain('write:');
  });

  it('describeType surfaces per-field deviations via the backing', () => {
    const out = describeTypes(docEngine());
    expect(out).toContain('non-insertable'); // secret
    expect(out).toContain('non-updatable'); // locked
    expect(out).toContain('has-default'); // createdAt / uuid / seq
    expect(out).toContain('exprs:not(semantic)'); // title
    expect(out).toContain('exprs:only(comparison)'); // onlyCmp
    // slug is computed ⇒ both non-insertable and non-updatable.
    expect(out).toContain('[non-insertable, non-updatable]');
  });

  it('describeExprs drops array-op when every array field excludes it', () => {
    expect(describeExprs(docEngine())).toContain('array-op');
    expect(describeExprs(arrEngine())).not.toContain('array-op');
  });
});

// ─── Auxiliary fixtures ───────────────────────────────────────────────────────

function frozenEngine(rows: SourceRecord[] = []): QueryEngine {
  const registry = createRegistry();
  const frozen = registry.parseType({
    name: 'frozen',
    fields: [{ name: 'id', type: { kind: 'text' } }],
    indexes: [{ exprs: [{ expr: ref('frozen', 'id'), count: 1 }] }],
    count: 1,
    bytes: 8,
    insertable: false,
    updatable: false,
    deletable: false,
  });
  registry.registerType(frozen);
  registry.finalize();
  return new QueryEngine(registry, { executors: { frozen: arrayExecutor(rows) } });
}

function perKindEngine(): QueryEngine {
  const registry = createRegistry();
  const mk = (name: string, flags: Partial<TypeDef>): TypeDef => ({
    name,
    fields: [{ name: 'id', type: { kind: 'text' } }],
    indexes: [{ exprs: [{ expr: ref(name, 'id'), count: 1 }] }],
    count: 1,
    bytes: 8,
    ...flags,
  });
  registry.registerType(registry.parseType(mk('insOnly', { updatable: false, deletable: false })));
  registry.registerType(registry.parseType(mk('updOnly', { insertable: false, deletable: false })));
  registry.registerType(registry.parseType(mk('delOnly', { insertable: false, updatable: false })));
  registry.finalize();
  return new QueryEngine(registry);
}

function arrEngine(): QueryEngine {
  const registry = createRegistry();
  const arr = registry.parseType({
    name: 'arr',
    fields: [
      { name: 'id', type: { kind: 'text' } },
      { name: 'items', type: { kind: 'array', item: { kind: 'text' } }, exprs: { not: ['array-op'] } },
    ],
    indexes: [{ exprs: [{ expr: ref('arr', 'id'), count: 1 }] }],
    count: 1,
    bytes: 8,
  });
  registry.registerType(arr);
  registry.finalize();
  return new QueryEngine(registry, { executors: { arr: arrayExecutor([]) } });
}

function computedOnlyEngine(): QueryEngine {
  const registry = createRegistry();
  const comp = registry.parseType({
    name: 'comp',
    fields: [{ name: 'c', type: { kind: 'text' } }],
    count: 1,
    bytes: 8,
  });
  registry.registerType(comp, { fields: { c: { compute: { expr: (alias) => registry.parseExpr(lit(`${alias}`)) } } } });
  registry.finalize();
  return new QueryEngine(registry);
}
