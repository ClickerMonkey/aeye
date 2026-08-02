/**
 * Coverage for the redesigned INSERT-row / UPDATE-SET WRITE model: the keyed
 * `{ field: WriteValueDef }` records, the OpenAI-safe null-omit semantics (a raw
 * `null` / absent key OMITS; a literal-null expr sets SQL NULL), raw-scalar
 * values (→ a literal), the unsupported raw non-scalar guard, the defensive
 * `writeRecordShape` (`parseCheckedQuery`) branches, and the `writes` depth axis
 * (`names` schema + its `depthInstructions` note).
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import { buildSchemas, depthInstructions } from '../llm/schemas';
import { Problems } from '../problem';
import type { InsertDef, UpdateDef, ExprDef } from '../schema';

const lit = (value: string | number | boolean | null): ExprDef => ({ kind: 'literal', value });

describe('write model — raw values + null-omit semantics (throwing `from` path)', () => {
  it('accepts RAW scalar write values (each becomes a literal) and round-trips as such', () => {
    const fx = runtimeFixture();
    const def: InsertDef = { kind: 'insert', into: 'user', rows: [{ name: 'Ray', age: 40, email: 'r@x.com' }] };
    const q = fx.engine.parseQuery(def);
    // Raw scalars normalize to literal exprs on the way back out.
    expect(q.toJSON()).toEqual({
      kind: 'insert',
      into: 'user',
      rows: [{ name: lit('Ray'), age: lit(40), email: lit('r@x.com') }],
    });
  });

  it('OMITS an absent / JSON-null-valued key (drops it entirely)', () => {
    const fx = runtimeFixture();
    // `age: null` ⇒ OMIT — never a column, never SET NULL.
    const def: InsertDef = { kind: 'insert', into: 'user', rows: [{ id: 5, name: 'Zed', age: null, email: 'z@x.com' }] };
    const q = fx.engine.parseQuery(def);
    expect(q.toJSON()).toEqual({
      kind: 'insert',
      into: 'user',
      rows: [{ id: lit(5), name: lit('Zed'), email: lit('z@x.com') }],
    });
  });

  it('a literal-null EXPRESSION (unlike raw null) is kept and sets NULL', () => {
    const fx = runtimeFixture();
    const def: UpdateDef = { kind: 'update', type: 'user', set: { age: lit(null) } };
    const q = fx.engine.parseQuery(def);
    expect(q.toJSON()).toEqual({ kind: 'update', type: 'user', set: { age: lit(null) } });
  });

  it('A9: accepts a raw DOCUMENT write value (array / object) as a literal', () => {
    // Until 0.6.1 this threw `write.unsupported-value` — so a `json` / `array`
    // column could not be written at all, even though `WriteValueDef` has always
    // been documented as `JsonValue | ExprDef`. The parser now follows the type.
    const fx = runtimeFixture();
    const def = { kind: 'insert', into: 'user', rows: [{ tags: ['a', 'b'] }] } as unknown as InsertDef;
    expect(fx.engine.parseQuery(def).toJSON()).toEqual({
      kind: 'insert',
      into: 'user',
      rows: [{ tags: { kind: 'literal', value: ['a', 'b'] } }],
    });
  });

  it('still rejects a write value that is NOT JSON (a Date / a function / NaN)', () => {
    // The union widened to `JsonValue`, not to "anything": a value with no JSON
    // representation would stringify to something the caller never wrote, which
    // is the silent-corruption class this work exists to end.
    const fx = runtimeFixture();
    for (const bad of [new Date(), () => 1, Number.NaN]) {
      const def = { kind: 'insert', into: 'user', rows: [{ tags: bad }] } as unknown as InsertDef;
      expect(() => fx.engine.parseQuery(def)).toThrow(/Unsupported write value/);
    }
  });

  it('a document whose `kind` is not a REGISTERED expr kind stays DATA', () => {
    // The `JsonValue | ExprDef` union is only decidable if `{ kind }` means an
    // expression ONLY when the kind exists: a settings blob carrying a `kind`
    // key is data, and reading it as a malformed expr reported an error about a
    // construct the caller never wrote.
    const fx = runtimeFixture();
    const blob = { kind: 'section', title: 'General' };
    const def = { kind: 'insert', into: 'user', rows: [{ tags: blob }] } as unknown as InsertDef;
    expect(fx.engine.parseQuery(def).toJSON()).toEqual({
      kind: 'insert',
      into: 'user',
      rows: [{ tags: { kind: 'literal', value: blob } }],
    });
    // …while a REGISTERED kind is still parsed as the expression it names.
    const asExpr = { kind: 'insert', into: 'user', rows: [{ name: lit('Ray') }] } as unknown as InsertDef;
    expect(fx.engine.parseQuery(asExpr).toJSON()).toEqual({ kind: 'insert', into: 'user', rows: [{ name: lit('Ray') }] });
  });
});

describe('write model — defensive `writeRecordShape` (parseCheckedQuery)', () => {
  it('builds raw-scalar values and drops null-omitted keys with no problems', () => {
    const fx = runtimeFixture();
    const p = new Problems();
    const built = fx.registry.parseCheckedQuery(
      { kind: 'insert', into: 'user', rows: [{ name: 'Ray', age: null }] },
      p,
    );
    expect(p.hasErrors).toBe(false);
    expect(built?.toJSON()).toEqual({ kind: 'insert', into: 'user', rows: [{ name: lit('Ray') }] });
  });

  it('reports shape.not-object for a non-object row', () => {
    const fx = runtimeFixture();
    const p = new Problems();
    fx.registry.parseCheckedQuery({ kind: 'insert', into: 'user', rows: [5] }, p);
    expect(p.list.some((pr) => pr.code === 'shape.not-object' && pr.path.join('.') === 'rows.0')).toBe(true);
  });

  it('A9: builds a raw DOCUMENT write value, and still reports shape.type for a NON-JSON one', () => {
    const fx = runtimeFixture();
    const ok = new Problems();
    const built = fx.registry.parseCheckedQuery({ kind: 'insert', into: 'user', rows: [{ tags: ['a', 'b'] }] }, ok);
    expect(ok.hasErrors).toBe(false);
    expect(built?.toJSON()).toEqual({
      kind: 'insert',
      into: 'user',
      rows: [{ tags: { kind: 'literal', value: ['a', 'b'] } }],
    });
    // A value with no JSON representation is still refused, localized at its key.
    const bad = new Problems();
    fx.registry.parseCheckedQuery({ kind: 'insert', into: 'user', rows: [{ tags: [new Date()] }] }, bad);
    expect(bad.list.some((pr) => pr.code === 'shape.type' && pr.path.join('.') === 'rows.0.tags')).toBe(true);
  });
});

describe('write model — the `writes` depth axis', () => {
  it("writes:'names' pins per-Type field names (Expr values), rejecting unknown fields + raw values", () => {
    const fx = runtimeFixture();
    const schemas = buildSchemas(fx.engine, { depth: { writes: 'names' } });
    expect(schemas.Insert.safeParse({ kind: 'insert', into: 'user', rows: [{ name: lit('A') }] }).success).toBe(true);
    // Unknown field key ⇒ rejected (strict per-Type object).
    expect(schemas.Insert.safeParse({ kind: 'insert', into: 'user', rows: [{ bogus: lit('A') }] }).success).toBe(false);
    // A RAW value is not accepted at `names` (values must be expressions).
    expect(schemas.Insert.safeParse({ kind: 'insert', into: 'user', rows: [{ name: 'raw' }] }).success).toBe(false);
    // UPDATE set uses the same per-Type object.
    expect(schemas.Update.safeParse({ kind: 'update', type: 'user', set: { name: lit('A') } }).success).toBe(true);
    expect(schemas.Update.safeParse({ kind: 'update', type: 'user', set: { bogus: lit('A') } }).success).toBe(false);
  });

  it("depthInstructions notes the writes:'names' constraint", () => {
    const fx = runtimeFixture();
    const note = depthInstructions(fx.engine, { depth: { writes: 'names' } });
    expect(note).toContain('keyed field→value objects');
  });

  it('degrades writes typed → names → open when the field enum exceeds maxEnumSize', () => {
    const fx = runtimeFixture();
    // user has several fields ⇒ `typed` degrades two rungs to the loose open shape.
    const schemas = buildSchemas(fx.engine, { depth: { writes: 'typed' }, maxEnumSize: 1 });
    // Open ⇒ a free `{ field: Expr }` record accepting any field name.
    expect(schemas.Insert.safeParse({ kind: 'insert', into: 'user', rows: [{ anything: lit('x') }] }).success).toBe(true);
  });
});

describe('write model — SQL emit of an empty (no rows / no select) INSERT', () => {
  it('emits an empty column list', () => {
    const fx = runtimeFixture();
    const { sql } = fx.engine.toSQL({ kind: 'insert', into: 'user' }, 'base');
    expect(sql).toBe('INSERT INTO "user" ()');
  });

  it('an empty `rows` array inserts nothing (no columns)', async () => {
    const fx = runtimeFixture();
    expect((await fx.engine.run({ kind: 'insert', into: 'user', rows: [] })).affected).toBe(0);
  });
});
