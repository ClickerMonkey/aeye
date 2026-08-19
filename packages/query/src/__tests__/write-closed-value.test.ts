/**
 * A WRITE to a column declaring a CLOSED VALUE SET must be one of the members.
 *
 * Measured against 0.6.5, over a `status` declaring `todo|in progress|done|blocked`:
 *
 *     UPDATE task SET status = LITERAL "bogus"   ->  ACCEPTED
 *     INSERT task (status)   = LITERAL "bogus"   ->  ACCEPTED
 *     UPDATE task SET status = LITERAL 42        ->  REFUSED (write.type)
 *
 * So the write model already read the column's declared type and refused a value
 * that did not fit its CATEGORY — and `values` is part of that same declaration.
 * Membership is the identical check one notch narrower, and it had no
 * enforcement anywhere: `toValueSchema()` knew the members, the model-facing
 * description listed them, cost estimation divided by them, and a write could
 * still store anything.
 *
 * It gets its OWN problem code because the remedy differs. `write.type` says
 * "change the type of this value"; `write.value` says "use one of these", and so
 * it names them — the members ARE the fix, and the library already renders a
 * closed set to models in exactly that form.
 *
 * The wrong-CATEGORY case is kept here as a negative control, so the two codes
 * stay distinguishable and a future change cannot quietly merge them.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { closedSetValueSchema, isClosedSetMember } from '../field-types/_values';
import { describeTypes } from '../llm/index';
import { ArrayFieldType, TextFieldType } from '../field-types/index';
import type { TypeDef, InsertDef, UpdateDef, SelectDef, JsonValue, WriteValueDef, FieldValueDef } from '../schema';

/** A Type with a closed set on each field type that can declare one, plus unconstrained controls. */
const taskDef: TypeDef = {
  name: 'task',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    {
      name: 'status',
      type: {
        kind: 'text',
        values: [
          { value: 'todo' },
          { value: 'in progress', label: 'In progress' },
          { value: 'done' },
          { value: 'blocked' },
        ],
      },
    },
    { name: 'priority', type: { kind: 'number', whole: true, values: [{ value: 1, label: 'Low' }, { value: 2 }, { value: 3 }] } },
    // `money` declares its set through the inner numeric bag — the same
    // declaration, reached by a different road.
    { name: 'fee', type: { kind: 'money', currency: 'USD', number: { values: [{ value: 0 }, { value: 10 }] } } },
    { name: 'title', type: { kind: 'text' } },
    { name: 'note', type: { kind: 'text' }, nullable: true },
    // A CONTAINER over a closed set: the array declares none of its own, its
    // ITEM does. Nullable so it stays optional on insert.
    {
      name: 'tags',
      type: { kind: 'array', item: { kind: 'text', values: [{ value: 'red' }, { value: 'blue' }] } },
      nullable: true,
    },
    {
      name: 'grid',
      type: { kind: 'array', item: { kind: 'array', item: { kind: 'number', values: [{ value: 1 }, { value: 2 }] } } },
      nullable: true,
    },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'task', field: 'id' }, count: 1 }] }],
  count: 1000,
  bytes: 64,
};

function engineOf(): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(taskDef));
  registry.finalize();
  return new QueryEngine(registry);
}

/** `UPDATE task SET <field> = <value>`. */
const setTo = (field: string, value: WriteValueDef): UpdateDef => ({
  kind: 'update',
  type: 'task',
  set: { [field]: value },
});

/** A full valid INSERT row, with ONE cell overridden — so any problem is about that cell. */
const insertWith = (field: string, value: WriteValueDef): InsertDef => ({
  kind: 'insert',
  into: 'task',
  rows: [{ id: 1, status: 'todo', priority: 1, fee: 0, title: 'ship it', [field]: value }],
});

const codes = (engine: QueryEngine, def: InsertDef | UpdateDef | SelectDef): string[] =>
  engine.validateQuery(def).list.map((p) => p.code);

describe('write.value — a literal must be a member of the column’s closed set', () => {
  it.each([
    ['status', 'bogus', 'one of todo|in progress (In progress)|done|blocked'],
    ['priority', 4, 'one of 1 (Low)|2|3'],
    ['fee', 7, 'one of 0|10'],
  ] as const)('UPDATE SET %s = %j is write.value, and the message NAMES the members', (field, value, members) => {
    const problems = engineOf().validateQuery(setTo(field, value)).list;
    expect(problems.map((p) => p.code)).toEqual(['write.value']);
    expect(problems[0]!.message).toContain(`Cannot write ${JSON.stringify(value)} to field '${field}'`);
    expect(problems[0]!.message).toContain(members);
  });

  it.each([
    ['status', 'bogus'],
    ['priority', 4],
    ['fee', 7],
  ] as const)('INSERT %s = %j is write.value too — the same check on the other write road', (field, value) => {
    expect(codes(engineOf(), insertWith(field, value))).toEqual(['write.value']);
  });

  it.each([
    ['status', 'in progress'],
    ['priority', 3],
    ['fee', 10],
  ] as const)('a DECLARED member is accepted (%s = %j)', (field, value) => {
    expect(codes(engineOf(), setTo(field, value))).toEqual([]);
    expect(codes(engineOf(), insertWith(field, value))).toEqual([]);
  });

  it('checks a CONTAINER element-wise — the set is declared by the ITEM type', () => {
    // A column declaring `array<text one of red|blue>` used to accept
    // `['bogus']` SILENTLY, while that same column's `toValueSchema()` rejected
    // the identical array. The check asked `values()` — which an array correctly
    // answers `undefined`, since an array admits ARRAYS, not members — so it
    // could only ever see a set one accessor deep.
    const engine = engineOf();
    expect(engine.type('task')!.field('tags')!.fieldType.validValue(['bogus'])).toBe(false);
    const problems = engine.validateQuery(setTo('tags', ['red', 'bogus'])).list;
    expect(problems.map((p) => p.code)).toEqual(['write.value']);
    // The message points at the ELEMENT, since that is what has to change.
    expect(problems[0]!.message).toBe(
      `Cannot write "bogus" to element 1 of field 'tags' — it declares a closed set of values, one of red|blue.`,
    );
    expect(codes(engine, setTo('tags', ['red', 'blue']))).toEqual([]);
    expect(codes(engine, setTo('tags', []))).toEqual([]);
  });

  it('recurses, so a NESTED container reports the whole index path', () => {
    const problems = engineOf().validateQuery(setTo('grid', [[1, 2], [1, 9]])).list;
    expect(problems.map((p) => p.code)).toEqual(['write.value']);
    expect(problems[0]!.message).toContain("to element 1.1 of field 'grid'");
    expect(codes(engineOf(), setTo('grid', [[1], [2, 1]]))).toEqual([]);
  });

  it('a container with nothing to check answers cleanly', () => {
    // A heterogeneous array declares no element type, so there is no set to
    // check against; and a non-array value in an array column is a CATEGORY
    // error (`write.type`), never this check's business — asked directly here
    // because the write path refuses both before they can reach it.
    const enumItem = new TextFieldType({ values: [{ value: 'red' }] });
    expect(new ArrayFieldType().closedSetViolation(['anything'])).toBeUndefined();
    expect(new ArrayFieldType(enumItem).closedSetViolation('not-an-array')).toBeUndefined();
    expect(new ArrayFieldType(enumItem).closedSetViolation(['red'])).toBeUndefined();
    expect(new ArrayFieldType(enumItem).closedSetViolation(['blue'])).toEqual({
      at: [0],
      value: 'blue',
      values: [{ value: 'red' }],
    });
  });

  it('shows the model the element type AND its set, so the refusal is recoverable', () => {
    // The pair rule: enforcing membership without rendering it refuses a model
    // against a set it was never told about. An array column rendered as a bare
    // `array`, which did not even name the ELEMENT type.
    const text = describeTypes(engineOf(), [engineOf().type('task')!]);
    expect(text).toContain('tags: array<text one of red|blue>');
    expect(text).toContain('grid: array<array<number one of 1|2>>');
  });

  it('an ON CONFLICT update cell is checked on the same path', () => {
    const def: InsertDef = {
      ...insertWith('status', 'todo'),
      onConflict: { fields: ['id'], update: { status: 'bogus' } },
    };
    expect(codes(engineOf(), def)).toEqual(['write.value']);
  });

  it('an UNCONSTRAINED column is unaffected — no set, nothing to enforce', () => {
    expect(codes(engineOf(), setTo('title', 'anything at all'))).toEqual([]);
  });
});

describe('write.value stays distinct from write.type (the negative control)', () => {
  it('a wrong-CATEGORY value on the same column is write.type, NOT write.value', () => {
    const problems = engineOf().validateQuery(setTo('status', 42)).list;
    expect(problems.map((p) => p.code)).toEqual(['write.type']);
    expect(problems[0]!.message).toContain("Cannot write a number value to field 'status' (text)");
  });

  it('ONE cell reports ONE problem — a wrong category never also reports membership', () => {
    // 42 is not a member of the status set either; reporting both would give the
    // author two remedies for one mistake, only one of which is the real one.
    expect(codes(engineOf(), insertWith('status', 42))).toEqual(['write.type']);
  });
});

describe('the exemptions, each for its own stated reason', () => {
  it('a PARAM cell is exempt — it has no value at validate time', () => {
    // It is not unchecked, only checked LATER: the column types the param, and
    // `checkParams` compares the supplied value against that type.
    const def = setTo('status', { kind: 'param', name: 'next' });
    const engine = engineOf();
    expect(codes(engine, def)).toEqual([]);
    expect(engine.checkParams(def, { next: 'bogus' }).list.map((p) => p.code)).toEqual(['param.value']);
    expect(engine.checkParams(def, { next: 'done' }).list.map((p) => p.code)).toEqual([]);
  });

  it('a NULL literal is exempt — it matches Postgres, where NULL passes a CHECK', () => {
    expect(codes(engineOf(), setTo('note', { kind: 'literal', value: null }))).toEqual([]);
    // And on the constrained column itself (nullability is the field's business,
    // not the value set's).
    expect(codes(engineOf(), setTo('status', { kind: 'literal', value: null }))).toEqual([]);
  });

  it('a NON-LITERAL expr is exempt — a field ref / case has no statically knowable value', () => {
    expect(codes(engineOf(), setTo('status', { kind: 'field-ref', source: 'task', field: 'title' }))).toEqual([]);
    const caseExpr: WriteValueDef = {
      kind: 'case',
      branches: [
        {
          when: { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'task', field: 'id' }, right: { kind: 'literal', value: 1 } },
          then: { kind: 'literal', value: 'done' },
        },
      ],
      else: { kind: 'literal', value: 'bogus' },
    };
    expect(codes(engineOf(), setTo('status', caseExpr))).toEqual([]);
  });

  it('the READ side still accepts a non-member — deliberately', () => {
    // Querying for a value that should not exist is how you find the rows a bad
    // migration wrote, so `where status = 'bogus'` is legitimate and stays legal.
    const read: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'task', field: 'id' } }],
      from: { kind: 'type', type: 'task' },
      where: [
        {
          kind: 'comparison',
          op: '=',
          left: { kind: 'field-ref', source: 'task', field: 'status' },
          right: { kind: 'literal', value: 'bogus' },
        },
      ],
    };
    expect(codes(engineOf(), read)).toEqual([]);
  });
});

describe('membership has ONE definition', () => {
  // `0` and `-0` are in the members AND in the cases on purpose: they are one of
  // exactly two pairs of values on which `Object.is` and `===` disagree, and the
  // original comparator here was `Object.is` — so `SET n = -0` against
  // `values:[{value:0}]` was refused with a member list containing the very
  // value being written, and no case in this table could see it. `NaN` is the
  // other pair, covered separately below since it cannot survive JSON.
  const members: FieldValueDef[] = [{ value: 'a' }, { value: 2 }, { value: 'b', label: 'Bee' }, { value: 0 }];
  const cases: JsonValue[] = ['a', 'b', 2, 'c', 3, '2', 0, -0, true, null, [], {}];

  it('isClosedSetMember agrees with closedSetValueSchema on every value', () => {
    // Two answers to one question is how they drift; the write check reads the
    // cheap one (once per cell), so this pins them together.
    const schema = closedSetValueSchema(members)!;
    for (const value of cases) {
      expect({ value, member: isClosedSetMember(members, value) }).toEqual({
        value,
        member: schema.safeParse(value).success,
      });
    }
  });

  it('uses ZOD’S comparator — SameValueZero, which is neither `Object.is` nor `===`', () => {
    // Measured, not assumed: zod accepts `-0` for `literal(0)` (so it is not
    // `Object.is`) AND `NaN` for `literal(NaN)` (so it is not `===` either).
    // Matching either operator alone leaves a value on which the two membership
    // answers disagree, which is precisely the drift the test above exists to
    // prevent — and which it could not see while `-0` was absent from `cases`.
    expect(isClosedSetMember([{ value: 0 }], -0)).toBe(true);
    expect(closedSetValueSchema([{ value: 0 }])!.safeParse(-0).success).toBe(true);
    expect(isClosedSetMember([{ value: NaN }], NaN)).toBe(true);
    expect(closedSetValueSchema([{ value: NaN }])!.safeParse(NaN).success).toBe(true);
    // …while every genuinely different value is still refused by both.
    expect(isClosedSetMember([{ value: 0 }], NaN)).toBe(false);
    expect(isClosedSetMember([{ value: NaN }], 0)).toBe(false);
  });

  it('a `-0` write is ACCEPTED against a `0` member (the reported symptom)', () => {
    // `fee` declares `one of 0|10`. `UPDATE task SET fee = -0` used to be
    // refused with a message naming a member list containing the very value
    // being written.
    expect(codes(engineOf(), setTo('fee', -0))).toEqual([]);
  });

  it('an ABSENT set constrains nothing — every value is a member of it', () => {
    for (const value of cases) expect(isClosedSetMember(undefined, value)).toBe(true);
    // An EMPTY array is an absent declaration (see `compactFieldValues`), so it
    // must not be read as "a set of nothing" that rejects everything.
    for (const value of cases) expect(isClosedSetMember([], value)).toBe(true);
  });

  it('the model-facing description offers exactly the values the validator accepts', () => {
    // The schema ⇄ validator agreement A11 records as OPEN for temporal columns
    // is CLOSED here: `writes: 'typed'` renders this cell from
    // `toValueSchema()`, which is the closed set itself.
    const status = engineOf().type('task')!.field('status')!.fieldType;
    expect(status.validValue('done')).toBe(true);
    expect(status.validValue('bogus')).toBe(false);
    expect(codes(engineOf(), setTo('status', 'done'))).toEqual([]);
  });
});
