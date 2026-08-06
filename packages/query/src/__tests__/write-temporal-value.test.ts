/**
 * Writing a `date` / `timestamp` column — PINNING the behaviour, not changing it.
 *
 * A11 (filed against 0.6.1): a temporal column is writable ONLY through a
 * `param`. A9's `write.type` check compares the value's category against the
 * column's, and a `LiteralExpr`'s category comes from the value's JS type — so a
 * literal can only ever be `text` / `number` / `bool` / `json` / `array`, and
 * NO literal is assignable to `date` / `timestamp`. There is no third road:
 * `LiteralExpr.resolve()` has no arm yielding a temporal type, and no
 * `toDate` / `toTimestamp` builtin exists to wrap one.
 *
 * This file exists because the suite never wrote a temporal column at all —
 * which is why the hole shipped. It states BOTH halves as they are today:
 *  - the param road works, end to end (a bound ISO string, whose SQL parameter
 *    Postgres coerces to the target column's type);
 *  - a literal ISO string is `write.type`, EVEN THOUGH the model-facing
 *    `writes: 'typed'` schema offers exactly that value for the cell
 *    (`DateFieldType.toValueSchema()` IS an ISO-date string). That schema ⇄
 *    validator disagreement is the same shape as A9's, and is recorded here so
 *    that widening it later is a DELIBERATE change to a stated contract rather
 *    than an accident — see A11 in `design/query-library-asks.md`.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { buildSchemas } from '../llm/schemas';
import type { TypeDef, InsertDef, UpdateDef, JsonValue } from '../schema';

/** A Type with both temporal kinds, plus a `text` control column. */
const eventDef: TypeDef = {
  name: 'event',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'label', type: { kind: 'text' } },
    { name: 'day', type: { kind: 'date' } },
    { name: 'at', type: { kind: 'timestamp' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'event', field: 'id' }, count: 1 }] }],
  count: 100,
  bytes: 48,
};

const DAY = '2026-01-01';
const AT = '2026-01-01T09:30:00.000Z';

function engineOf(rows: readonly Record<string, JsonValue>[] = []): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(eventDef));
  registry.finalize();
  return new QueryEngine(registry, { executors: { event: arrayExecutor(rows) } });
}

describe('a temporal column is written through a PARAM', () => {
  const insert: InsertDef = {
    kind: 'insert',
    into: 'event',
    rows: [{ id: 1, label: 'launch', day: { kind: 'param', name: 'day' }, at: { kind: 'param', name: 'at' } }],
  };

  it('validates, and types each param from the COLUMN it assigns', () => {
    const engine = engineOf();
    const scope = engine.globalScope();
    expect(engine.validateQuery(insert, scope).list.map((p) => p.code)).toEqual([]);
    // The column is the only place a write param's type can come from.
    expect(scope.params.resolved('day')?.resolve()).toBe('date');
    expect(scope.params.resolved('at')?.resolve()).toBe('timestamp');
  });

  it('binds the ISO value in its own slot — no cast, no interpolation', () => {
    const { sql, params } = engineOf().toSQL(insert, 'postgres', { params: { day: DAY, at: AT } });
    expect(sql).toBe('INSERT INTO "event" ("id", "label", "day", "at") VALUES ($1, $2, $3, $4)');
    expect(params).toEqual([1, 'launch', DAY, AT]);
  });

  it('round-trips both temporal values through the runtime', async () => {
    const engine = engineOf();
    const withReturning: InsertDef = {
      ...insert,
      returning: [
        { expr: { kind: 'field-ref', source: 'event', field: 'day' }, as: 'day' },
        { expr: { kind: 'field-ref', source: 'event', field: 'at' }, as: 'at' },
      ],
    };
    expect((await engine.run(withReturning, { params: { day: DAY, at: AT } })).rows).toEqual([
      { day: DAY, at: AT },
    ]);
  });

  it('an UPDATE SET takes a temporal param too', () => {
    const update: UpdateDef = { kind: 'update', type: 'event', set: { at: { kind: 'param', name: 'at' } } };
    const engine = engineOf();
    expect(engine.validateQuery(update).list.map((p) => p.code)).toEqual([]);
    expect(engine.toSQL(update, 'postgres', { params: { at: AT } }).params).toEqual([AT]);
  });
});

describe('a temporal column REFUSES every literal (A11 — pinned as shipped)', () => {
  /**
   * An INSERT whose ONLY literal temporal cell is `field` — the other temporal
   * column (both are non-nullable) goes through a param, so the reported
   * problem can only be about the cell under test.
   */
  const literalInto = (field: 'day' | 'at', value: JsonValue): InsertDef => ({
    kind: 'insert',
    into: 'event',
    rows: [
      {
        id: 1,
        label: 'launch',
        day: field === 'day' ? value : { kind: 'param', name: 'day' },
        at: field === 'at' ? value : { kind: 'param', name: 'at' },
      },
    ],
  });

  it.each([
    ['day', DAY, 'text'],
    ['day', 0, 'number'],
    ['at', AT, 'text'],
    ['at', 0, 'number'],
  ] as const)('%s <- literal %j is write.type (a %s value)', (field, value, category) => {
    const problems = engineOf().validateQuery(literalInto(field, value)).list;
    expect(problems.map((p) => p.code)).toEqual(['write.type']);
    expect(problems[0]!.message).toContain(`Cannot write a ${category} value to field '${field}'`);
  });

  it('the model-facing write SCHEMA offers the value the validator then refuses', () => {
    // The disagreement, stated rather than implied: `writes: 'typed'` renders
    // each cell as `field.fieldType.toValueSchema() OR Expr`, and for a `date`
    // that schema IS an ISO-date string — so the model is invited to emit
    // exactly what `write.type` rejects. (A9 closed the same disagreement for
    // `json` / `array`; this one is still open, deliberately.)
    const engine = engineOf();
    expect(engine.type('event')!.field('day')!.fieldType.toValueSchema().safeParse(DAY).success).toBe(true);
    const schemas = buildSchemas(engine, { depth: { writes: 'typed' } });
    const row = { id: 1, label: 'launch', day: DAY, at: AT };
    expect(schemas.Insert.safeParse({ kind: 'insert', into: 'event', rows: [row] }).success).toBe(true);
    expect(engine.validateQuery({ kind: 'insert', into: 'event', rows: [row] }).list.map((p) => p.code))
      .toEqual(['write.type', 'write.type']);
  });
});
