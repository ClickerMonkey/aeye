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
import { TextFieldType, NumberFieldType, MoneyFieldType } from '../field-types/index';
import { QueryTypeError } from '../problem';
import { EQ_SELECTIVITY } from '../cost';
import { describeTypes } from '../llm/index';
import { cctx } from './_utils';
import type { TypeDef, SelectDef, FieldTypeDef } from '../schema';

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

/**
 * A member of a closed set is a value of the OWNING KIND's scalar — the def
 * schema offers nothing else.
 *
 * The `values` slot is shared by `text` and `number`, and it used to declare its
 * member as `z.union([z.string(), z.number()])` for both. Measured on `0.6.5`:
 *
 *     parseFieldType({kind:'number', values:[{value:'a'},{value:2}]})  ->  ACCEPTED
 *       .validValue('a')  -> true    (a NUMBER column accepting the string 'a')
 *       .eqSelectivity()  -> 0.5
 *
 * For a package whose contract is that its generated schemas only ever offer
 * valid values, a `number` field-type schema offering a text member slot is the
 * defect — the def that took the offer was doing as it was told.
 */
describe('a closed set’s member type comes from the owning kind', () => {
  const parse = (s: { safeParse(v: unknown): { success: boolean } }, def: unknown): boolean => s.safeParse(def).success;

  it('the `text` def schema offers a STRING member, the `number` one a NUMBER', () => {
    expect(parse(TextFieldType.toSchema(), { kind: 'text', values: [{ value: 'a' }] })).toBe(true);
    expect(parse(TextFieldType.toSchema(), { kind: 'text', values: [{ value: 1 }] })).toBe(false);
    expect(parse(NumberFieldType.toSchema(), { kind: 'number', values: [{ value: 1 }] })).toBe(true);
    expect(parse(NumberFieldType.toSchema(), { kind: 'number', values: [{ value: 'a' }] })).toBe(false);
  });

  it('`money` inherits it through the inner NumberOptions bag — the indirection that hid its selectivity', () => {
    // `money`'s set lives one level down, which is exactly why it was missed
    // when `eqSelectivity` was asked per class. Reached through the same bag
    // here, so it cannot drift from `number`'s answer.
    expect(parse(MoneyFieldType.toSchema(), { kind: 'money', number: { values: [{ value: 10 }] } })).toBe(true);
    expect(parse(MoneyFieldType.toSchema(), { kind: 'money', number: { values: [{ value: 'ten' }] } })).toBe(false);
  });
});

/**
 * A closed set every member of which the type's OWN constraints reject is a
 * defect in the DECLARATION, and is refused where declarations are read.
 *
 * Satisfiability is decidable here, patterns included: the set is FINITE and
 * declared, so every per-member predicate is settled by EVALUATION — which this
 * package already did, in the meet (`narrowFieldValues` against the kind's
 * constraint schema). The check reuses that exact pair, so a def accepted at
 * parse time can never be narrowed by the meet afterwards.
 *
 * Sibling of `field-type.bad-pattern` in every respect: same road (`from`), same
 * `QueryTypeError`, same reason (nothing a query does can make the declaration
 * valid), and the same caveat — the public CONSTRUCTORS do not validate.
 */
describe('a closed set must be satisfiable by its own constraints', () => {
  const registry = createRegistry();

  /** The `QueryTypeError` `parseFieldType` threw for `def`, or a failure if it did not throw. */
  const refusal = (def: FieldTypeDef): QueryTypeError => {
    try {
      registry.parseFieldType(def);
      expect.unreachable('parseFieldType should have refused the declaration');
    } catch (err) {
      expect(err).toBeInstanceOf(QueryTypeError);
      return err as QueryTypeError;
    }
  };

  it('refuses a member a `pattern` excludes, naming the member AND what excluded it', () => {
    const err = refusal({ kind: 'text', pattern: '^a', values: [{ value: 'zz' }] });
    expect(err.problem.code).toBe('field-type.bad-values');
    expect(err.problem.path).toEqual(['values']);
    // The author's fix is to change ONE of the two, so the message has to name
    // both halves — and the reason comes from the same schema that rejected it.
    expect(err.problem.message).toContain('"zz"');
    expect(err.problem.message).toContain('must match pattern /^a/');
    expect(err.problem.message).toContain('1 closed-set member');
  });

  it('refuses a member a LENGTH bound excludes', () => {
    const err = refusal({ kind: 'text', minLength: 5, values: [{ value: 'ab' }] });
    expect(err.problem.message).toContain('to have >=5 characters');
  });

  it('refuses a NUMERIC member of a text set — the mixed-scalar shape, caught on the parse road too', () => {
    // The per-kind member schema removes this from what a def SCHEMA offers; the
    // schema is not on the `from` path, so the same fact is enforced here.
    const err = refusal({ kind: 'text', values: [{ value: 1 }, { value: 'a' }] });
    expect(err.problem.message).toContain('expected string, received number');
  });

  it('refuses a text member of a NUMBER set, and a fractional one under `whole`', () => {
    expect(refusal({ kind: 'number', values: [{ value: 'a' }] }).problem.message).toContain(
      'expected number, received string',
    );
    const err = refusal({ kind: 'number', whole: true, values: [{ value: 1 }, { value: 1.5 }] });
    expect(err.problem.message).toContain('1.5');
    expect(err.problem.message).toContain('expected int, received number');
    // The SURVIVING member is not the point — one rejected member is enough.
    expect(err.problem.message).toContain('1 closed-set member');
  });

  it('refuses a member outside declared BOUNDS, and reports a `money` set at `number.values`', () => {
    expect(refusal({ kind: 'number', min: 0, values: [{ value: -1 }] }).problem.message).toContain('to be >=0');
    const err = refusal({ kind: 'money', currency: 'USD', number: { min: 0, values: [{ value: 0 }, { value: -5 }] } });
    expect(err.problem.code).toBe('field-type.bad-values');
    // Where a money def actually declares one — a path a fix can be applied to.
    expect(err.problem.path).toEqual(['number', 'values']);
    expect(err.problem.message).toContain("A 'money' field");
  });

  it('refuses a PARTIALLY inconsistent set too — every member must satisfy, not merely one', () => {
    // `a` survives and `zz` does not, and that is still a broken declaration:
    // `validValue('zz')` answers true on the way in (a closed set IS the value
    // schema) while the meet drops `zz` on the way out. Requiring ALL members is
    // what makes `x ⊓ ⊤ = x` hold for every type a def can express.
    const err = refusal({ kind: 'text', pattern: '^a', values: [{ value: 'a' }, { value: 'zz' }] });
    expect(err.problem.message).toContain('1 closed-set member');
    expect(err.problem.message).toContain('"zz"');
    expect(err.problem.message).not.toContain('"a"');
  });

  it('names several offenders at once, and elides past the description budget', () => {
    const err = refusal({ kind: 'number', min: 0, values: Array.from({ length: 15 }, (_, i) => ({ value: -1 - i })) });
    expect(err.problem.message).toContain('15 closed-set members');
    // The same budget the model-facing description spends on a long set: a
    // longer list of offenders is not a more actionable message.
    expect(err.problem.message).toContain('…+3 more');
  });

  it('is refused at parseType and inside an ARRAY item, so no query path reaches the declaration', () => {
    const r = createRegistry();
    const bad: FieldTypeDef = { kind: 'text', pattern: '^a', values: [{ value: 'zz' }] };
    const typeWith = (type: FieldTypeDef): TypeDef => ({
      name: 'doc',
      fields: [{ name: 'id', type: { kind: 'number', whole: true } }, { name: 'code', type }],
      count: 1,
      bytes: 8,
    });
    expect(() => r.parseType(typeWith(bad))).toThrow(/closed-set member/);
    expect(() => r.parseType(typeWith({ kind: 'array', item: bad }))).toThrow(/closed-set member/);
  });

  it('still accepts every set its constraints DO admit', () => {
    expect(registry.parseFieldType({ kind: 'text', pattern: '^a', values: [{ value: 'a' }, { value: 'ab' }] }).validValue('ab')).toBe(true);
    expect(registry.parseFieldType({ kind: 'number', whole: true, min: 1, values: [{ value: 1 }, { value: 9 }] }).eqSelectivity()).toBeCloseTo(1 / 2);
    expect(registry.parseFieldType({ kind: 'money', number: { values: [{ value: 0 }, { value: 10 }] } }).values()).toHaveLength(2);
    // A set with NO constraints beside it is unconstrained by definition, and a
    // type with constraints and no set is untouched.
    expect(registry.parseFieldType({ kind: 'text', values: [{ value: 'anything' }] }).validValue('anything')).toBe(true);
    expect(registry.parseFieldType({ kind: 'text', minLength: 5 }).validValue('abcde')).toBe(true);
  });

  it('does NOT validate the public constructor — the same caveat every hand-supplied option carries', () => {
    // Stated as a test rather than only in prose: `FieldType.meet` is the
    // GREATEST lower bound for a registry-built type, and only a lower bound for
    // a hand-built one, and this is the road that keeps the second half true.
    const hand = new TextFieldType({ pattern: '^a', values: [{ value: 'zz' }] });
    expect(hand.validValue('zz')).toBe(true);
    expect(() => TextFieldType.from(hand.toJSON())).toThrow(/closed-set member/);
  });
});
