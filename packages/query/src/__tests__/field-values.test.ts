/**
 * A5 — a CLOSED VALUE SET on the existing scalars (`values`), not a new `kind`.
 *
 * An enum is a constraint ON a text/number column, so lifting it as a new
 * field-type kind would fork every comparison / SQL-type / value-schema path for
 * one extra fact. Three things depend on it and none are reachable from outside
 * the library: equality SELECTIVITY (a defensible `1/n` instead of the fixed
 * guess), the MODEL-FACING description, and `toValueSchema()`.
 *
 * The per-member `label` rides along, because `FieldDef` already carries a label
 * the library renders — splitting membership from presentation would put one
 * closed set in two places that can drift.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { TextFieldType, NumberFieldType } from '../field-types/index';
import { EQ_SELECTIVITY } from '../cost';
import { describeTypes } from '../llm/index';
import { cctx } from './_utils';
import type { TypeDef, SelectDef } from '../schema';

const applicationDef: TypeDef = {
  name: 'application',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    {
      name: 'status',
      type: {
        kind: 'text',
        values: [
          { value: 'applied' },
          { value: 'screening', label: 'In screening' },
          { value: 'hired' },
          { value: 'rejected' },
          { value: 'withdrawn' },
        ],
      },
    },
    { name: 'priority', type: { kind: 'number', whole: true, values: [{ value: 1, label: 'Low' }, { value: 2, label: 'High' }] } },
    { name: 'notes', type: { kind: 'text' }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'application', field: 'id' }, count: 1 }] }],
  count: 1_000_000,
  bytes: 64,
};

function engineOf(): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(applicationDef));
  registry.finalize();
  return new QueryEngine(registry);
}

/** `SELECT id FROM application WHERE <field> = <value>`. */
function eqWhere(field: string, value: string | number): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'application', field: 'id' }, as: 'id' }],
    from: { kind: 'type', type: 'application' },
    where: [
      {
        kind: 'comparison',
        op: '=',
        left: { kind: 'field-ref', source: 'application', field: field },
        right: { kind: 'literal', value },
      },
    ],
  };
}

describe('A5 — closed value sets', () => {
  it('round-trips through the def, keeping labels and dropping an empty set', () => {
    const registry = createRegistry();
    const type = registry.parseType(applicationDef);
    const status = type.field('status')!.fieldType;
    expect(status).toBeInstanceOf(TextFieldType);
    expect(type.field('status')!.toJSON().type).toEqual(applicationDef.fields[1]!.type);
    // A member with no label serializes WITHOUT one (no `label: undefined` noise).
    expect(status instanceof TextFieldType && status.options.values?.[0]).toEqual({ value: 'applied' });
    // An EMPTY array is an absent declaration, not "a set of nothing" — which
    // would make `1/n` divide by zero and reject every value.
    const empty = new TextFieldType({ values: [] });
    expect(empty.toJSON().values).toBeUndefined();
    expect(empty.eqSelectivity()).toBeUndefined();
  });

  it('clone deep-copies the members (mutating a clone cannot reach the original)', () => {
    const original = new NumberFieldType({ values: [{ value: 1, label: 'Low' }] });
    const copy = original.clone();
    copy.options.values![0]!.label = 'CHANGED';
    expect(original.options.values![0]!.label).toBe('Low');
  });

  it('toValueSchema narrows to the members instead of "any string" / "any number"', () => {
    const engine = engineOf();
    const status = engine.type('application')!.field('status')!.fieldType;
    expect(status.validValue('hired')).toBe(true);
    expect(status.validValue('HIRED')).toBe(false);
    expect(status.validValue('promoted')).toBe(false);
    const priority = engine.type('application')!.field('priority')!.fieldType;
    expect(priority.validValue(2)).toBe(true);
    expect(priority.validValue(3)).toBe(false);
    // A single-member set is a bare literal (zod's union wants two or more).
    expect(new TextFieldType({ values: [{ value: 'only' }] }).validValue('only')).toBe(true);
    expect(new TextFieldType({ values: [{ value: 'only' }] }).validValue('other')).toBe(false);
    // An UNCONSTRAINED text field is unchanged.
    expect(engine.type('application')!.field('notes')!.fieldType.validValue('anything')).toBe(true);
  });

  it('eqSelectivity is 1/n, and an `=` on the field costs accordingly', () => {
    const engine = engineOf();
    const type = engine.type('application')!;
    expect(type.field('status')!.fieldType.eqSelectivity()).toBeCloseTo(1 / 5);
    expect(type.field('priority')!.fieldType.eqSelectivity()).toBeCloseTo(1 / 2);
    expect(type.field('notes')!.fieldType.eqSelectivity()).toBeUndefined();

    const scope = engine.globalScope();
    const rows = (def: SelectDef): number => engine.parseQuery(def).cost(cctx(engine), scope).rows;
    // 5 statuses ⇒ 200_000; 2 priorities ⇒ 500_000; unconstrained ⇒ the fixed guess.
    expect(rows(eqWhere('status', 'hired'))).toBe(1_000_000 / 5);
    expect(rows(eqWhere('priority', 2))).toBe(1_000_000 / 2);
    expect(rows(eqWhere('notes', 'x'))).toBe(Math.max(1, Math.floor(1_000_000 * EQ_SELECTIVITY)));
  });

  it('the model-facing description says `one of …`, with labels only where they add something', () => {
    const engine = engineOf();
    const text = describeTypes(engine, [engine.type('application')!]);
    // The VALUE is what a `where` clause must contain, so it leads; a label is
    // appended only when it says something the value does not.
    expect(text).toContain('status: text one of applied|screening (In screening)|hired|rejected|withdrawn');
    expect(text).toContain('priority: number one of 1 (Low)|2 (High)');
    // An unconstrained field is described exactly as before.
    expect(text).toContain('notes: text');
  });

  it('shows a MONEY column’s set too — a model must be told what a write will be refused for', () => {
    // `fieldTypeTag` used to dispatch per class and read `ft.options.values`, so
    // `money` — whose set lives in its inner `NumberOptions` bag — rendered as a
    // bare `money(USD)`. Once writes enforce membership (`write.value`) that
    // becomes a requirement the model is STRUCTURALLY never told about: it
    // authors `SET fee = 7`, is refused with a members list it had no way to
    // know, and can only guess and retry. The set is now appended from the total
    // `FieldType.values()`, so every kind that declares one renders it.
    const registry = createRegistry();
    registry.registerType(
      registry.parseType({
        name: 'invoice',
        fields: [
          { name: 'id', type: { kind: 'number', whole: true } },
          { name: 'fee', type: { kind: 'money', currency: 'USD', number: { values: [{ value: 0 }, { value: 10 }] } } },
        ],
        count: 10,
        bytes: 16,
      }),
    );
    registry.finalize();
    const engine = new QueryEngine(registry);
    expect(describeTypes(engine, [engine.type('invoice')!])).toContain('fee: money(USD) one of 0|10');
    // The SAME declaration drives selectivity and the write check — which is the
    // point of asking one accessor rather than three per-class ones.
    expect(engine.type('invoice')!.field('fee')!.fieldType.eqSelectivity()).toBeCloseTo(1 / 2);
    expect(
      engine.validateQuery({ kind: 'update', type: 'invoice', set: { fee: 7 } }).list.map((p) => p.code),
    ).toEqual(['write.value']);
  });

  it('elides a long set rather than spending the whole prompt budget on it', () => {
    const many = new TextFieldType({ values: Array.from({ length: 20 }, (_, i) => ({ value: `v${i}` })) });
    const registry = createRegistry();
    registry.registerType(
      registry.parseType({
        name: 'big',
        fields: [{ name: 'id', type: { kind: 'number', whole: true } }, { name: 'code', type: many.toJSON() }],
        count: 10,
        bytes: 8,
      }),
    );
    registry.finalize();
    const bigEngine = new QueryEngine(registry);
    const text = describeTypes(bigEngine, [bigEngine.type('big')!]);
    expect(text).toContain('v0|');
    expect(text).toContain('+8 more');
    expect(text).not.toContain('v19');
  });

  it('`values` and `pattern` are different facts and may BOTH be declared', () => {
    const both = new TextFieldType({ pattern: '^[a-z]+$', values: [{ value: 'a' }, { value: 'b' }] });
    const json = both.toJSON();
    expect(json.pattern).toBe('^[a-z]+$');
    expect(json.values).toHaveLength(2);
    // Membership is the stricter fact, so it is what the value schema enforces.
    expect(both.validValue('a')).toBe(true);
    expect(both.validValue('zzz')).toBe(false);
  });
});
