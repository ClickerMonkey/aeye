/**
 * buildSchemas GRADUATED DEPTH — each axis (refs / typeNames / functions /
 * filters) is dialed independently, plus `maxEnumSize` auto-degrade and the
 * deprecated `strict` sugar. The companion `schema-strict.test.ts` covers the
 * fully-paired (`strict: true`) preset end to end; here we assert the
 * INTERMEDIATE levels and the per-axis knobs.
 */
import { describe, it, expect } from 'vitest';
import { buildSchemas } from '../llm/schemas';
import type { SelectDef, ExprDef } from '../schema';
import { fixture, accepts, decode } from './_utils';

/** Wrap a single field-expression in a minimal SELECT over `user`. */
function selectOf(expr: ExprDef): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr }],
    from: { kind: 'type', type: 'user' },
  };
}

describe('buildSchemas depth — refs axis', () => {
  it("refs:'types' enumerates the source but leaves the field open", () => {
    const fx = fixture();
    const { Expr } = buildSchemas(fx.engine, { depth: { refs: 'types' } });
    // A known source + an arbitrary (unchecked) field name validates.
    expect(accepts(Expr, { kind: 'field-ref', source: 'user', field: 'anything' })).toBe(true);
    // An UNKNOWN source is rejected (source is enum-locked).
    expect(accepts(Expr, { kind: 'field-ref', source: 'ghost', field: 'name' })).toBe(false);
  });

  it("refs:'fields' enumerates the field but leaves the source open", () => {
    const fx = fixture();
    const { Expr } = buildSchemas(fx.engine, { depth: { refs: 'fields' } });
    // Arbitrary source + a known field name (from any Type) validates.
    expect(accepts(Expr, { kind: 'field-ref', source: 'anything', field: 'name' })).toBe(true);
    // An unknown field name is rejected (field is enum-locked).
    expect(accepts(Expr, { kind: 'field-ref', source: 'user', field: 'nope' })).toBe(false);
  });

  it("refs:'both' enumerates both but accepts a CROSS-type pairing", () => {
    const fx = fixture();
    const { Expr } = buildSchemas(fx.engine, { depth: { refs: 'both' } });
    // `total` is an `order` field; under `both` it is unpaired, so pairing it
    // with a `user` source still validates (both are individually known).
    expect(accepts(Expr, { kind: 'field-ref', source: 'user', field: 'total' })).toBe(true);
    // Unknown source AND unknown field are both rejected.
    expect(accepts(Expr, { kind: 'field-ref', source: 'ghost', field: 'name' })).toBe(false);
    expect(accepts(Expr, { kind: 'field-ref', source: 'user', field: 'nope' })).toBe(false);
  });

  it("refs:'paired' REJECTS a cross-type field", () => {
    const fx = fixture();
    const { Expr } = buildSchemas(fx.engine, { depth: { refs: 'paired' } });
    // `total` belongs to `order`, not `user` — the per-Type pairing rejects it.
    expect(accepts(Expr, { kind: 'field-ref', source: 'user', field: 'total' })).toBe(false);
    // …while the correct pairing validates.
    expect(accepts(Expr, { kind: 'field-ref', source: 'user', field: 'name' })).toBe(true);
  });
});

describe('buildSchemas depth — typeNames axis', () => {
  it("typeNames:'open' accepts an unknown Type name; 'enum' rejects it", () => {
    const fx = fixture();
    const open = buildSchemas(fx.engine, { depth: { typeNames: 'open' } });
    expect(accepts(open.Source, { kind: 'type', type: 'ghost' })).toBe(true);

    const locked = buildSchemas(fx.engine, { depth: { typeNames: 'enum' } });
    expect(accepts(locked.Source, { kind: 'type', type: 'ghost' })).toBe(false);
    expect(accepts(locked.Source, { kind: 'type', type: 'user' })).toBe(true);
  });
});

describe('buildSchemas depth — functions axis', () => {
  it("functions:'names' enum-locks the function name but accepts loose args", () => {
    const fx = fixture();
    const { Expr } = buildSchemas(fx.engine, { depth: { functions: 'names' } });
    // A real scalar fn with arbitrary (loose-record) args validates.
    const upper: ExprDef = {
      kind: 'function-call',
      function: 'upper',
      args: { value: { kind: 'field-ref', source: 'user', field: 'name' } },
    };
    expect(accepts(Expr, upper)).toBe(true);
    // An UNKNOWN function name is rejected.
    const bogus: ExprDef = { kind: 'function-call', function: 'no_such_fn', args: {} };
    expect(accepts(Expr, bogus)).toBe(false);
  });

  it("functions:'typed' builds a per-fn args object: rejects an unknown arg, accepts the declared one", () => {
    const fx = fixture();
    const { Expr } = buildSchemas(fx.engine, { depth: { functions: 'typed' } });
    const value: ExprDef = { kind: 'field-ref', source: 'user', field: 'name' };
    // `upper` declares a single `value` param — the right name validates.
    expect(
      accepts(Expr, { kind: 'function-call', function: 'upper', args: { value } }),
    ).toBe(true);
    // An UNDECLARED arg name is rejected by the strict per-fn args object.
    expect(
      accepts(Expr, { kind: 'function-call', function: 'upper', args: { wrong: value } }),
    ).toBe(false);
    // A typed aggregate branch carries the `distinct` extra.
    const countStar: ExprDef = { kind: 'aggregate', function: 'count', args: {}, distinct: true };
    expect(accepts(Expr, countStar)).toBe(true);
  });

  it("functions:'none' locks every function name out", () => {
    const fx = fixture();
    const { Expr } = buildSchemas(fx.engine, { depth: { functions: 'names' }, functions: 'none' });
    expect(
      accepts(Expr, { kind: 'function-call', function: 'upper', args: {} }),
    ).toBe(false);
  });
});

describe('buildSchemas depth — filters axis', () => {
  it("filters:'open' leaves source + fields free; 'paired' pins them to a Type", () => {
    const fx = fixture();
    // The `filters` placeholder is `{ source, fields? }` — NO clause shapes are
    // ever authored by the LLM (clauses are supplied at execution time).
    const open = buildSchemas(fx.engine, { depth: { filters: 'open' } });
    // `open` — any source + any field names validate.
    expect(
      accepts(open.Expr, { kind: 'filters', source: 'anything', fields: ['whatever'] }),
    ).toBe(true);

    const paired = buildSchemas(fx.engine, { depth: { filters: 'paired' } });
    // `paired` — `source` is a Type and each `fields` entry is one of ITS
    // filterable fields, so a genuine `user` field allowlist validates.
    expect(
      accepts(paired.Expr, { kind: 'filters', source: 'user', fields: ['email', 'age'] }),
    ).toBe(true);
    // An unknown source is rejected (source enum-locked under `paired`).
    expect(
      accepts(paired.Expr, { kind: 'filters', source: 'ghost', fields: ['email'] }),
    ).toBe(false);
    // A cross-Type field (`total` is an `order` field) is rejected for `user`.
    expect(
      accepts(paired.Expr, { kind: 'filters', source: 'user', fields: ['total'] }),
    ).toBe(false);
    // `fields` is optional — a bare source validates (no allowlist).
    expect(accepts(paired.Expr, { kind: 'filters', source: 'user' })).toBe(true);
  });
});

describe('buildSchemas depth — maxEnumSize auto-degrade', () => {
  it('a tiny maxEnumSize loosens paired refs so a cross-type field is accepted', () => {
    const fx = fixture();
    // Without degradation, `paired` rejects `user.total`.
    const tight = buildSchemas(fx.engine, { depth: { refs: 'paired' } });
    expect(
      accepts(tight.Expr, { kind: 'field-ref', source: 'user', field: 'total' }),
    ).toBe(false);
    // With maxEnumSize:1 the refs axis degrades to an open/looser shape, so the
    // same cross-type field-ref now validates.
    const loose = buildSchemas(fx.engine, { depth: { refs: 'paired' }, maxEnumSize: 1 });
    expect(
      accepts(loose.Expr, { kind: 'field-ref', source: 'user', field: 'total' }),
    ).toBe(true);
  });

  it('a tiny maxEnumSize loosens typed functions so an unknown arg is accepted', () => {
    const fx = fixture();
    const tight = buildSchemas(fx.engine, { depth: { functions: 'typed' } });
    const value: ExprDef = { kind: 'field-ref', source: 'user', field: 'name' };
    expect(
      accepts(tight.Expr, { kind: 'function-call', function: 'upper', args: { wrong: value } }),
    ).toBe(false);
    // Degraded (names/open), the strict per-fn arg object is gone → loose args.
    const loose = buildSchemas(fx.engine, { depth: { functions: 'typed' }, maxEnumSize: 1 });
    expect(
      accepts(loose.Expr, { kind: 'function-call', function: 'upper', args: { wrong: value } }),
    ).toBe(true);
  });

  it("maxEnumSize degrades the typeNames enum back to open", () => {
    const fx = fixture();
    const loose = buildSchemas(fx.engine, { depth: { typeNames: 'enum' }, maxEnumSize: 1 });
    // Two Types > max 1 ⇒ enum degrades to open ⇒ an unknown name is accepted.
    expect(accepts(loose.Source, { kind: 'type', type: 'ghost' })).toBe(true);
  });
});

describe('buildSchemas depth — strict sugar + presets', () => {
  it("strict:true behaves as depth 'paired' for refs", () => {
    const fx = fixture();
    const sugar = buildSchemas(fx.engine, { strict: true });
    expect(
      accepts(sugar.Expr, { kind: 'field-ref', source: 'user', field: 'total' }),
    ).toBe(false);
  });

  it("strict:false / depth:'open' accept free-string sources and fields", () => {
    const fx = fixture();
    for (const schemas of [
      buildSchemas(fx.engine, { strict: false }),
      buildSchemas(fx.engine, { depth: 'open' }),
    ]) {
      expect(
        accepts(schemas.Expr, { kind: 'field-ref', source: 'whatever', field: 'whatever' }),
      ).toBe(true);
    }
  });

  it("depth:'paired' preset locks every axis (typed functions reject unknown args)", () => {
    const fx = fixture();
    const { Expr } = buildSchemas(fx.engine, { depth: 'paired' });
    const value: ExprDef = { kind: 'field-ref', source: 'user', field: 'name' };
    expect(
      accepts(Expr, { kind: 'function-call', function: 'upper', args: { wrong: value } }),
    ).toBe(false);
    expect(
      accepts(Expr, { kind: 'function-call', function: 'upper', args: { value } }),
    ).toBe(true);
  });
});
