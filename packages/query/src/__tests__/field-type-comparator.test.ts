/**
 * THE IN-MEMORY HALF of a registered field type — step 4.
 *
 * A refinement declares a SQL half (`sql` / `cast`, per dialect) and, from this
 * release, an in-memory half (`registerFieldTypeImpl`'s `compareValues`). The
 * agreement BETWEEN the two is `runtime-sql-agreement.test.ts`'s property; this
 * file is about the mechanism that makes it expressible at all:
 *
 *  - `Value.compareTo` consults the declared comparator, and NULL placement is
 *    still decided before it (a comparator is never handed one);
 *  - a comparator out-ranks case folding, and two DIFFERENT comparators fall
 *    back to the builtin rule rather than letting operand order decide;
 *  - a produced `Value` carries its callable's DECLARED output type, so the same
 *    comparator applies to a computed value as to a column;
 *  - `checkFieldType` holds a supplied comparator to the ORDER laws, since none
 *    of the sites that reach it has an error channel;
 *  - `differentialCheck` reports what only a live database can settle.
 */
import { describe, it, expect } from 'vitest';
import { checkFieldType, differentialCheck, type DifferentialExecute } from '../conformance';
import { QueryEngine } from '../engine';
import { QueryTypeError } from '../problem';
import { createRegistry, type Registry } from '../registry';
import { arrayExecutor } from '../runtime/executor';
import { Value } from '../runtime/value';
import type { FieldTypeRefinementDef, ValueComparator } from '../refinement';
import type { JsonValue, SelectDef } from '../schema';

// ─── The worked declaration: an IPv4 address stored as `inet` ────────────────
//
// Chosen because the divergence it exists to close is a documented fact rather
// than an invention: PostgreSQL's `inet` orders by ADDRESS, and the same values
// as text order LEXICOGRAPHICALLY, so the two roads disagree on `10.0.0.2` vs
// `10.0.0.10` until the type declares how it compares.

/** `10.0.0.2` → `[10, 0, 0, 2]`, or `undefined` for anything that is not one. */
function octets(v: JsonValue): number[] | undefined {
  if (typeof v !== 'string') return undefined;
  const parts = v.split('.');
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return nums.some((n) => Number.isNaN(n) || n > 255) ? undefined : nums;
}

/** Order two IPv4 strings by address; total over every value a cell can hold. */
const byAddress: ValueComparator = (a, b) => {
  const x = octets(a);
  const y = octets(b);
  if (!x || !y) return !x && !y ? String(a).localeCompare(String(b)) : x ? -1 : 1;
  for (let i = 0; i < 4; i += 1) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return 0;
};

const IP_ADDRESS: FieldTypeRefinementDef = {
  name: 'IpAddress',
  base: 'text',
  instructions: 'An IPv4 address, stored as `inet` and ordered by address rather than by spelling.',
  options: { casing: 'exact', maxLength: 15 },
  sql: { postgres: 'inet', base: 'varchar(15)' },
};

/** A registry carrying `IpAddress`, with the code half attached when asked. */
function ipRegistry(impl: { compareValues?: ValueComparator } = { compareValues: byAddress }): Registry {
  const registry = createRegistry().registerFieldType(IP_ADDRESS);
  registry.registerFieldTypeImpl('IpAddress', impl);
  return registry;
}

/** A `Value` of the `IpAddress` type, as a field-ref produces one. */
function ipValue(registry: Registry, raw: JsonValue): Value {
  return Value.of(raw, undefined, registry.parseFieldType({ kind: 'text', as: 'IpAddress' }));
}

describe('`Value.compareTo` consults the type a refinement declared', () => {
  it('orders by the declared comparator instead of by the stringified form', () => {
    const registry = ipRegistry();
    const small = ipValue(registry, '10.0.0.2');
    const large = ipValue(registry, '10.0.0.10');
    expect(small.compareTo(large)).toBe(-1);
    expect(large.compareTo(small)).toBe(1);
    // The control: the SAME strings, untyped, order the other way.
    expect(Value.of('10.0.0.2').compareTo(Value.of('10.0.0.10'))).toBe(1);
  });

  it('governs EQUALITY too, because `equals` / `identical` are `compareTo === 0`', () => {
    const registry = ipRegistry({
      // A comparator that treats every address in a /24 as one value — nothing
      // realistic, but it makes "equality goes through the comparator" visible
      // rather than coincidental.
      compareValues: (a, b) => byAddress(String(a).replace(/\.\d+$/, '.0'), String(b).replace(/\.\d+$/, '.0')),
    });
    const a = ipValue(registry, '10.0.0.2');
    const b = ipValue(registry, '10.0.0.10');
    expect(a.equals(b)).toBe(true);
    expect(a.identical(b)).toBe(true);
  });

  it('is NOT consulted for a NULL operand — placement belongs to the sort, not the type', () => {
    const registry = ipRegistry({
      compareValues: () => {
        throw new Error('a comparator must never be handed a NULL');
      },
    });
    const value = ipValue(registry, '10.0.0.2');
    const nul = ipValue(registry, null);
    expect(value.compareTo(nul)).toBe(1);
    expect(nul.compareTo(value)).toBe(-1);
    expect(nul.compareTo(nul)).toBe(0);
    // …and the SQL-equality rules over NULL are unchanged.
    expect(value.equals(nul)).toBe(false);
    expect(nul.identical(nul)).toBe(true);
  });

  it('OUT-RANKS case folding: a type that says how it compares has said so including case', () => {
    const registry = ipRegistry({ compareValues: (a, b) => String(a).length - String(b).length });
    const a = ipValue(registry, 'AA');
    const b = ipValue(registry, 'aa');
    // By length they are EQUAL; a case-folded text comparison would also say
    // equal, so the discriminating pair is a longer lower-case string.
    expect(a.compareToCase(b, false)).toBe(0);
    expect(a.compareToCase(ipValue(registry, 'aaa'), false)).toBe(-1);
    // Untyped, the same call folds and compares lexicographically.
    expect(Value.of('AA').compareToCase(Value.of('aaa'), false)).toBe(-1);
    expect(Value.of('AA').compareToCase(Value.of('aa'), false)).toBe(0);
    expect(Value.of('AA').compareToCase(Value.of('aa'), true)).toBe(-1);
  });

  it('a NON-NUMERIC or NaN answer reads as EQUAL rather than corrupting a sort', () => {
    // `Array.prototype.sort` is free to produce any permutation for a comparator
    // that answers NaN, and does so without failing — so the answer is
    // normalised at the one place that sees it.
    const registry = ipRegistry({ compareValues: () => Number.NaN });
    expect(ipValue(registry, 'a').compareTo(ipValue(registry, 'b'))).toBe(0);
  });

  it('TWO DIFFERENT comparators fall back to the builtin rule, so operand order cannot decide', () => {
    const registry = createRegistry()
      .registerFieldType(IP_ADDRESS)
      .registerFieldType({
        name: 'Backwards',
        base: 'text',
        instructions: 'A text type that orders in reverse, so the two declarations genuinely disagree.',
        comparableWith: ['IpAddress'],
      });
    registry.registerFieldTypeImpl('IpAddress', { compareValues: byAddress });
    registry.registerFieldTypeImpl('Backwards', { compareValues: (a, b) => String(b).localeCompare(String(a)) });
    const ip = ipValue(registry, '10.0.0.2');
    const back = Value.of('10.0.0.10', undefined, registry.parseFieldType({ kind: 'text', as: 'Backwards' }));
    // Neither declaration wins, so both directions answer the STRING order —
    // which is what the pair already did, and is symmetric.
    expect(ip.compareTo(back)).toBe(1);
    expect(back.compareTo(ip)).toBe(-1);
  });

  it('an UNIMPLEMENTED refinement, and a plain builtin, still compare the builtin way', () => {
    const bare = createRegistry().registerFieldType(IP_ADDRESS);
    const typed = Value.of('10.0.0.2', undefined, bare.parseFieldType({ kind: 'text', as: 'IpAddress' }));
    expect(typed.comparator()).toBeUndefined();
    expect(typed.compareTo(Value.of('10.0.0.10'))).toBe(1);
    expect(Value.of(1).comparator()).toBeUndefined();
  });
});

describe('`Value.withType` — the seam a declared output reaches a produced value through', () => {
  it('carries the type, and is a no-op for `undefined` or for the type it already has', () => {
    const registry = ipRegistry();
    const type = registry.parseFieldType({ kind: 'text', as: 'IpAddress' });
    const bare = Value.of('10.0.0.2');
    const tagged = bare.withType(type);
    expect(tagged.type).toBe(type);
    expect(tagged.raw).toBe('10.0.0.2');
    expect(bare.withType(undefined)).toBe(bare);
    expect(tagged.withType(type)).toBe(tagged);
  });

  it('the DECLARATION wins over whatever a run tagged, so `resolve` and the cell agree', () => {
    const registry = ipRegistry();
    const declared = registry.parseFieldType({ kind: 'text', as: 'IpAddress' });
    const other = registry.parseFieldType({ kind: 'text' });
    expect(Value.of('x', undefined, other).withType(declared).type).toBe(declared);
  });
});

describe('`registerFieldTypeImpl` checks the code half it is handed', () => {
  it('REFUSES a `compareValues` that is not a function, naming why it is checked', () => {
    const registry = createRegistry().registerFieldType(IP_ADDRESS);
    let problem: { code: string; path: (string | number)[]; message: string } | undefined;
    try {
      // The shape a JSON round-trip of an impl produces — the failure this check
      // exists for, since a stored declaration cannot carry a closure.
      registry.registerFieldTypeImpl('IpAddress', { compareValues: 'byAddress' as unknown as ValueComparator });
    } catch (err) {
      if (!(err instanceof QueryTypeError)) throw err;
      problem = err.problem;
    }
    expect(problem?.code).toBe('field-type.bad-refinement');
    expect(problem?.path).toEqual(['registerFieldTypeImpl', 'IpAddress', 'compareValues']);
    expect(problem?.message).toContain('must be a function');
  });

  it('accepts a comparator, and `FieldType.valueComparator` is how it reaches a comparison', () => {
    const registry = ipRegistry();
    expect(registry.parseFieldType({ kind: 'text', as: 'IpAddress' }).valueComparator()).toBe(byAddress);
    expect(registry.parseFieldType({ kind: 'text' }).valueComparator()).toBeUndefined();
  });
});

describe('`checkFieldType` holds a supplied comparator to the ORDER laws', () => {
  const samples: JsonValue[] = ['10.0.0.2', '10.0.0.10', '10.0.1.1'];

  it('PASSES a real total order', () => {
    const report = checkFieldType(IP_ADDRESS, { compareValues: byAddress, samples });
    expect(report.problems).toEqual([]);
  });

  it('catches a comparator that THROWS on a value that is not of the type', () => {
    // The realistic failure: a comparator written as though it will only ever
    // see its own type. `Value.compareTo` does not catch it, so it surfaces from
    // inside a sort with no declaration in sight.
    const report = checkFieldType(IP_ADDRESS, {
      compareValues: (a, b) => octets(a)![0]! - octets(b)![0]!,
      samples,
    });
    const codes = report.problems.map((p) => p.code);
    expect(codes).toContain('conformance.comparator-not-total');
    expect(report.problems.find((p) => p.code === 'conformance.comparator-not-total')?.message)
      .toContain('did not ANSWER for every pair');
  });

  it('catches a NaN answer, which the runtime reads as "equal" and never reports', () => {
    const report = checkFieldType(IP_ADDRESS, { compareValues: (a, b) => Number(a) - Number(b), samples });
    expect(report.problems.map((p) => p.code)).toContain('conformance.comparator-not-total');
  });

  it('catches a comparator that is not ANTISYMMETRIC', () => {
    const report = checkFieldType(IP_ADDRESS, { compareValues: () => 1, samples });
    const problem = report.problems.find((p) => p.code === 'conformance.comparator-not-an-order');
    expect(problem?.message).toContain('not a total order');
    // Reflexivity is broken by the same comparator, and both are reported —
    // a broken order usually breaks in a family.
    expect(problem?.message).toContain('compareValues(x, x)');
  });

  it('catches a comparator that is not TRANSITIVE', () => {
    // Rock-paper-scissors over three strings: each beats the next, cyclically.
    const cycle = ['a', 'b', 'c'];
    const report = checkFieldType(IP_ADDRESS, {
      compareValues: (a, b) => {
        const i = cycle.indexOf(String(a));
        const j = cycle.indexOf(String(b));
        if (i < 0 || j < 0 || i === j) return String(a).localeCompare(String(b));
        return (j - i + 3) % 3 === 1 ? -1 : 1;
      },
      samples: cycle,
    });
    expect(report.problems.map((p) => p.code)).toContain('conformance.comparator-not-an-order');
  });

  it('runs NOTHING when no comparator is supplied — a SQL-road-only type is legitimate', () => {
    expect(checkFieldType(IP_ADDRESS, { samples }).problems).toEqual([]);
    expect(checkFieldType(IP_ADDRESS).problems).toEqual([]);
  });
});

// ─── `differentialCheck` ─────────────────────────────────────────────────────

const HOSTS = [
  { id: 1, addr: '10.0.0.10', other: '10.0.0.2' },
  { id: 2, addr: '10.0.0.2', other: '10.0.1.1' },
  { id: 3, addr: '10.0.1.1', other: '10.0.0.10' },
];
/** The three `addr` values, ascending BY ADDRESS — what an `inet` column answers. */
const BY_ADDRESS = ['10.0.0.2', '10.0.0.10', '10.0.1.1'];

/** An engine over `host`, with or without the code half. */
function hostEngine(withComparator: boolean): QueryEngine {
  const registry = withComparator ? ipRegistry() : createRegistry().registerFieldType(IP_ADDRESS);
  registry.registerType(
    registry.parseType({
      name: 'host',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'addr', type: { kind: 'text', as: 'IpAddress' } },
        { name: 'other', type: { kind: 'text', as: 'IpAddress' } },
      ],
      count: 100,
      bytes: 48,
    }),
  );
  registry.finalize();
  return new QueryEngine(registry, { executors: { host: arrayExecutor(HOSTS) } });
}

/**
 * A SCRIPTED stand-in for the database: each call takes the next answer and
 * records the statement it was given.
 *
 * Deliberately a script rather than a simulator. What is under test here is the
 * HARNESS — which statements it emits, how it compares two answers, and what it
 * reports when they differ — and a simulator would put a second implementation
 * of PostgreSQL's `inet` ordering in this file to check the first one against.
 * The real thing runs against a real server, in a consumer's integration suite,
 * which is the whole reason `differentialCheck` takes an `execute` callback.
 */
function scriptedDb(
  answers: readonly (readonly JsonValue[] | Error)[],
  /**
   * Answers keyed by a SUBSTRING of the statement, consulted before the
   * sequence. A probe's position moves whenever the harness gains one (the
   * `distinct` / `group by` probes moved every index once already), so anything
   * asserted about a SPECIFIC probe is matched rather than counted. FIRST match
   * wins, so list the most specific needle first — every probe over one column
   * ends in the same `ORDER BY`.
   */
  matches: Readonly<Record<string, readonly JsonValue[]>> = {},
): { execute: DifferentialExecute; statements: string[] } {
  const statements: string[] = [];
  let i = 0;
  const execute: DifferentialExecute = async (sql) => {
    statements.push(sql);
    const matched = Object.entries(matches).find(([needle]) => sql.includes(needle));
    if (matched) return matched[1].map((probe) => ({ probe }));
    const next = answers[i] ?? [];
    i += 1;
    if (next instanceof Error) throw next;
    return next.map((probe) => ({ probe }));
  };
  return { execute, statements };
}

describe('`differentialCheck` — the run-vs-SQL question nothing static can answer', () => {
  it('AGREES when the declared comparator matches what the database does', async () => {
    const db = scriptedDb([BY_ADDRESS, [...BY_ADDRESS].reverse(), BY_ADDRESS, BY_ADDRESS]);
    const report = await differentialCheck({
      engine: hostEngine(true),
      dialect: 'postgres',
      execute: db.execute,
      columns: { type: 'host', field: 'addr' },
    });
    // The only problem is the SKIP note: no `other` column was named, so the
    // single-column probes are all that could run.
    expect(report.problems.map((p) => p.code)).toEqual(['conformance.differential-skipped']);
    expect(report.probes.map((p) => p.label)).toEqual(['order asc', 'order desc', 'distinct', 'group by']);
    expect(report.probes.every((p) => p.agreed)).toBe(true);
    // The ORDER probes compare the SEQUENCE; everything else compares the
    // multiset, so a tie in the driving column cannot read as a disagreement.
    expect(report.probes.map((p) => p.comparison)).toEqual(['sequence', 'sequence', 'multiset', 'multiset']);
    expect(db.statements[0]).toContain('ORDER BY "host"."addr" ASC');
    expect(db.statements[1]).toContain('ORDER BY "host"."addr" DESC');
    expect(db.statements[2]).toContain('SELECT DISTINCT');
    expect(db.statements[3]).toContain('GROUP BY "host"."addr"');
  });

  it('REPORTS the disagreement, both answers and the statement, when the halves differ', async () => {
    // The same database, an engine with NO comparator — which is exactly the
    // state every registered type was in before this release.
    const db = scriptedDb([BY_ADDRESS, [...BY_ADDRESS].reverse(), BY_ADDRESS, BY_ADDRESS]);
    const report = await differentialCheck({
      engine: hostEngine(false),
      dialect: 'postgres',
      execute: db.execute,
      columns: { type: 'host', field: 'addr' },
    });
    const failures = report.problems.filter((p) => p.code === 'conformance.differential-disagreement');
    expect(failures).toHaveLength(2);
    expect(failures[0]!.message).toContain('answers differently in memory and at the database');
    expect(failures[0]!.message).toContain('10.0.0.10');
    expect(failures[0]!.message).toContain('compareValues');
    expect(report.probes.every((p) => p.agreed)).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('probes every ADMITTED comparison arm, plus the named operators and functions', async () => {
    const engine = hostEngine(true);
    engine.registry.registerFunction({
      name: 'sameAddr',
      shape: 'scalar',
      params: [{ name: 'a', type: { kind: 'text' } }, { name: 'b', type: { kind: 'text' } }],
      output: { kind: 'text', as: 'IpAddress' },
      instructions: 'Identity over its first argument.',
    });
    engine.registry.registerFunctionRun('sameAddr', { shape: 'scalar', run: (args) => Value.of(args['a']!.raw) });
    const db = scriptedDb([]);
    const report = await differentialCheck({
      engine,
      dialect: 'postgres',
      execute: db.execute,
      columns: { type: 'host', field: 'addr', other: 'other' },
      functions: ['sameAddr'],
    });
    expect(report.probes.map((p) => p.label)).toEqual([
      'order asc', 'order desc', 'distinct', 'group by',
      'addr = other', 'addr <> other', 'addr < other', 'addr <= other', 'addr > other', 'addr >= other',
      'addr like other', 'addr notLike other', 'addr ilike other',
      'sameAddr',
    ]);
    // A function's arguments ALTERNATE between the two columns, so a
    // non-commutative callable is probed with an asymmetric argument list.
    expect(db.statements.at(-1)).toContain('sameAddr("host"."addr", "host"."other")');
  });

  it('skips a comparison arm the type REFUSES, so the package\'s own refusal is not read as a divergence', async () => {
    const registry = createRegistry().registerFieldType({
      ...IP_ADDRESS,
      compare: { equality: true, ordering: false, textMatch: false },
    });
    registry.registerFieldTypeImpl('IpAddress', { compareValues: byAddress });
    registry.registerType(
      registry.parseType({
        name: 'host',
        fields: [
          { name: 'addr', type: { kind: 'text', as: 'IpAddress' } },
          { name: 'other', type: { kind: 'text', as: 'IpAddress' } },
        ],
        count: 100,
        bytes: 48,
      }),
    );
    registry.finalize();
    const engine = new QueryEngine(registry, { executors: { host: arrayExecutor(HOSTS) } });
    const report = await differentialCheck({
      engine,
      dialect: 'postgres',
      execute: scriptedDb([]).execute,
      columns: { type: 'host', field: 'addr', other: 'other' },
    });
    expect(report.probes.map((p) => p.label)).toEqual([
      'order asc', 'order desc', 'distinct', 'group by', 'addr = other', 'addr <> other',
    ]);
    // A DECLARED refusal is the consumer's own statement that the arm is
    // meaningless, so it is skipped silently — it is not a blind spot.
    expect(report.unprobeable).toEqual([]);
  });

  it('reports a statement the DATABASE refused as a divergence of its own', async () => {
    const db = scriptedDb([new Error('operator does not exist: inet < text')]);
    const report = await differentialCheck({
      engine: hostEngine(true),
      dialect: 'postgres',
      execute: db.execute,
      columns: { type: 'host', field: 'addr' },
    });
    const problem = report.problems.find((p) => p.code === 'conformance.differential-threw');
    expect(problem?.message).toContain('operator does not exist');
    expect(problem?.message).toContain('the strongest kind');
  });

  it('reports a statement this PACKAGE refused to emit, rather than throwing out of the harness', async () => {
    const report = await differentialCheck({
      engine: hostEngine(true),
      dialect: 'nonesuch',
      execute: scriptedDb([]).execute,
      columns: { type: 'host', field: 'addr' },
    });
    expect(report.problems.map((p) => p.code)).toContain('conformance.differential-threw');
    expect(report.probes).toEqual([]);
  });

  it('reports an unknown Type, field, or callable instead of silently probing nothing', async () => {
    const engine = hostEngine(true);
    const execute = scriptedDb([]).execute;
    const base = { engine, dialect: 'postgres', execute } as const;
    for (const columns of [
      { type: 'nope', field: 'addr' },
      { type: 'host', field: 'nope' },
      { type: 'host', field: 'addr', other: 'nope' },
    ]) {
      const report = await differentialCheck({ ...base, columns });
      expect(report.ok).toBe(false);
      expect(report.problems.map((p) => p.code)).toContain('conformance.differential-unknown-column');
    }
    const report = await differentialCheck({
      ...base,
      columns: { type: 'host', field: 'addr', other: 'other' },
      operators: ['&&'],
      functions: ['ST_Nope'],
    });
    const unknown = report.problems.filter((p) => p.code === 'conformance.differential-unknown-callable');
    expect(unknown).toHaveLength(2);
    expect(unknown[0]!.message).toContain("No operator '&&' is registered");
    expect(unknown[1]!.message).toContain("No function 'ST_Nope' is registered");
  });

  it('probes a registered OPERATOR over the two columns', async () => {
    const registry = ipRegistry();
    registry.registerOperator({
      name: '<->',
      operands: [
        { name: 'left', type: { kind: 'text', as: 'IpAddress' } },
        { name: 'right', type: { kind: 'text', as: 'IpAddress' } },
      ],
      output: { kind: 'number' },
      instructions: 'The numeric distance between two addresses.',
      emit: { postgres: '({left} <-> {right})' },
    });
    registry.registerOperatorRun('<->', (args) =>
      Value.of(Math.abs(byAddress(args['left']!.raw, args['right']!.raw))));
    registry.registerType(
      registry.parseType({
        name: 'host',
        fields: [
          { name: 'addr', type: { kind: 'text', as: 'IpAddress' } },
          { name: 'other', type: { kind: 'text', as: 'IpAddress' } },
        ],
        count: 100,
        bytes: 48,
      }),
    );
    registry.finalize();
    const db = scriptedDb([]);
    const report = await differentialCheck({
      engine: new QueryEngine(registry, { executors: { host: arrayExecutor(HOSTS) } }),
      dialect: 'postgres',
      execute: db.execute,
      columns: { type: 'host', field: 'addr', other: 'other' },
      operators: ['<->'],
    });
    expect(report.probes.map((p) => p.label)).toContain('<->');
    expect(db.statements.at(-1)).toContain('("host"."addr" <-> "host"."other")');
  });
});

// ─── The whole mechanism, end to end ─────────────────────────────────────────

describe('a registered type is no longer a SQL-road-only feature', () => {
  it('one declaration + one impl makes `engine.run` and the emitted column agree', async () => {
    const engine = hostEngine(true);
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'host', field: 'addr' }, as: 'addr' }],
      from: { kind: 'type', type: 'host' },
      order: [{ expr: { kind: 'field-ref', source: 'host', field: 'addr' }, dir: 'asc' }],
    };
    expect((await engine.run(def)).rows.map((r) => r['addr'])).toEqual(BY_ADDRESS);
    // …and the declaration that makes the DATABASE agree is the same one file.
    const addr = engine.registry.type('host')!.field('addr')!.fieldType;
    expect(engine.registry.dialect('postgres')!.sqlTypeFor(addr)).toBe('inet');
  });
});

describe('the harness answers for its own edges as well as the type\'s', () => {
  it('runs on the DEFAULT corpus when the declarer supplies no samples of their own', () => {
    // The cubic loop takes the declarer's samples FIRST; with none it falls back
    // to the default corpus rather than to nothing.
    expect(checkFieldType(IP_ADDRESS, { compareValues: byAddress }).problems).toEqual([]);
  });

  it('reports a comparator that throws a NON-Error, and lists a short failure set in full', () => {
    const report = checkFieldType(IP_ADDRESS, {
      compareValues: (a, b) => {
        if (a === 'boom' && b === 'boom') throw 'not an Error at all';
        return byAddress(a, b);
      },
      samples: ['boom'],
    });
    const problem = report.problems.find((p) => p.code === 'conformance.comparator-not-total');
    expect(problem?.message).toContain('not an Error at all');
    // Exactly one failing pair, so the message is complete rather than elided.
    expect(problem?.message).not.toContain('…');
  });

  it('reports a SHORT order failure in full, and elides a long one', () => {
    const oneBadValue = checkFieldType(IP_ADDRESS, {
      compareValues: (a, b) => (a === 'x' && b === 'x' ? 1 : byAddress(a, b)),
      samples: ['x'],
    }).problems.find((p) => p.code === 'conformance.comparator-not-an-order');
    expect(oneBadValue?.message).toContain('compareValues(x, x) = 1');
    expect(oneBadValue?.message).not.toContain('…');
    // The `() => 1` comparator breaks every pair, so the list is capped.
    const everyPair = checkFieldType(IP_ADDRESS, { compareValues: () => 1, samples: ['10.0.0.2'] })
      .problems.find((p) => p.code === 'conformance.comparator-not-an-order');
    expect(everyPair?.message).toContain('…');
  });

  it('reads a DRIVER row with no `probe` column as NULL, so the disagreement is visible', async () => {
    const execute: DifferentialExecute = async () => [{ PROBE: 'wrong case' }];
    const report = await differentialCheck({
      engine: hostEngine(true),
      dialect: 'postgres',
      execute,
      columns: { type: 'host', field: 'addr' },
    });
    expect(report.probes[0]!.sqlValues).toEqual([null]);
    expect(report.problems.map((p) => p.code)).toContain('conformance.differential-disagreement');
  });

  it('survives a driver that throws a NON-Error', async () => {
    const execute: DifferentialExecute = async () => {
      throw 'ECONNRESET';
    };
    const report = await differentialCheck({
      engine: hostEngine(true),
      dialect: 'postgres',
      execute,
      columns: { type: 'host', field: 'addr' },
    });
    expect(report.problems[0]!.message).toContain('ECONNRESET');
  });
});

// ─── The two facts a correct ORDER can still be wrong about ──────────────────

describe('`checkFieldType` warns about what a correct comparator can still break', () => {
  it('WARNS when a TEXT refinement declares a comparator and no `casing`', () => {
    // The comparator governs `= <> < <= > >=` on both roads; the LIKE family,
    // `text-search`, `text-score` and array containment keep folding per the
    // ENGINE default. One column, two case policies, and the declaration says
    // neither — which is how the blocker reached review.
    const warning = checkFieldType(
      { name: 'Tag', base: 'text', instructions: 'A tag ordered by its own rules.' },
      { compareValues: (a, b) => String(a).localeCompare(String(b)), samples: ['V1'] },
    ).problems.find((p) => p.code === 'conformance.comparator-without-casing');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('LIKE family');
    expect(warning?.message).toContain("casing: 'exact'");
  });

  it('is SILENT once the declaration narrows `casing` to `exact`', () => {
    const report = checkFieldType(
      { name: 'Tag', base: 'text', instructions: 'x', options: { casing: 'exact' } },
      { compareValues: (a, b) => String(a).localeCompare(String(b)), samples: ['V1'] },
    );
    expect(report.problems).toEqual([]);
  });

  it('does not fire for a NON-text base, where no road folds at all', () => {
    expect(
      checkFieldType(
        { name: 'Version', base: 'number', instructions: 'A version number.' },
        { compareValues: (a, b) => Number(a) - Number(b), samples: [1, 2] },
      ).problems.map((p) => p.code),
    ).not.toContain('conformance.comparator-without-casing');
  });

  it('WARNS when a comparator merges two values the type ADMITS', () => {
    // The `DISTINCT` / `GROUP BY` boundary, caught statically: those roads key on
    // the raw value and never reach a comparator (`runtime/record.ts`), so a
    // comparator whose equality is coarser than raw identity splits the package
    // in half.
    const warning = checkFieldType(
      { name: 'Net', base: 'text', instructions: 'An address whose /24 is its identity.', options: { casing: 'exact' } },
      {
        compareValues: (a, b) => String(a).replace(/\.\d+$/, '').localeCompare(String(b).replace(/\.\d+$/, '')),
        samples: ['10.0.0.1', '10.0.0.9'],
      },
    ).problems.find((p) => p.code === 'conformance.comparator-coarser-than-identity');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('"10.0.0.1" and "10.0.0.9"');
    expect(warning?.message).toContain('DISTINCT');
    // Two merged pairs list in full; a comparator that merges EVERYTHING elides.
    expect(warning?.message).not.toContain('…');
    const everything = checkFieldType(
      { name: 'One', base: 'text', instructions: 'Every value is the same value.', options: { casing: 'exact' } },
      { compareValues: () => 0 },
    ).problems.find((p) => p.code === 'conformance.comparator-coarser-than-identity');
    expect(everything?.message).toContain('…');
  });

  it('does NOT fire for a comparator that only re-orders — the common case', () => {
    // `byAddress` gives `inet` ordering and raw-identical equality, so DISTINCT
    // and `=` agree and there is nothing to say.
    expect(
      checkFieldType(IP_ADDRESS, { compareValues: byAddress, samples: ['10.0.0.2', '10.0.0.10'] }).problems,
    ).toEqual([]);
  });

  it('ignores a merge between values the type could never STORE', () => {
    // A comparator that stringifies quite properly calls `'a'` and `['a']` equal.
    // A `text` column cannot hold `['a']`, so reporting it would be a finding no
    // declarer can act on — the coarseness check filters the corpus by the
    // declaration's own gate, unlike the ORDER laws above it.
    expect(
      checkFieldType(
        { name: 'Loose', base: 'text', instructions: 'x', options: { casing: 'exact' } },
        { compareValues: (a, b) => String(a).localeCompare(String(b)) },
      ).problems.map((p) => p.code),
    ).not.toContain('conformance.comparator-coarser-than-identity');
  });
});

describe('`differentialCheck` asks THIS PACKAGE whether a probe is legal', () => {
  /** A `json`-based type: every comparison arm defaults to admitted, and LIKE is still illegal. */
  function geoEngine(): QueryEngine {
    const registry = createRegistry().registerFieldType({
      name: 'Geometry',
      base: 'json',
      instructions: 'A geometry. Declares no `compare`, so every arm defaults to admitted.',
    });
    registry.registerType(
      registry.parseType({
        name: 'parcel',
        fields: [
          { name: 'shape', type: { kind: 'json', as: 'Geometry' } },
          { name: 'nextShape', type: { kind: 'json', as: 'Geometry' } },
        ],
        count: 10,
        bytes: 96,
      }),
    );
    registry.finalize();
    return new QueryEngine(registry, { executors: { parcel: arrayExecutor([]) } });
  }

  it('does not EMIT an arm `validateQuery` refuses, and names it in `unprobeable`', async () => {
    // Measured before the gate: the harness emitted `like` / `notLike` / `ilike`
    // over a `json` column, the server refused all three, and each landed as
    // `differential-threw` — "the strongest kind" of divergence — on a correct
    // declaration's FIRST run.
    const db = scriptedDb([]);
    const report = await differentialCheck({
      engine: geoEngine(),
      dialect: 'postgres',
      execute: db.execute,
      columns: { type: 'parcel', field: 'shape', other: 'nextShape' },
    });
    expect(report.unprobeable.map((s) => s.label)).toEqual([
      'shape like nextShape', 'shape notLike nextShape', 'shape ilike nextShape',
    ]);
    expect(report.unprobeable[0]!.codes).toContain('comparison.like');
    expect(report.probes.map((p) => p.label)).not.toContain('shape like nextShape');
    expect(db.statements.some((sql) => sql.includes('LIKE'))).toBe(false);
    // An arm the HARNESS enumerated is a probe that does not exist for this
    // type, not a finding — a correct declaration still passes the documented
    // `expect(report.problems).toEqual([])`.
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('WARNS when a probe the CALLER named is refused, because that is theirs to fix', async () => {
    const engine = geoEngine();
    engine.registry.registerFunction({
      name: 'needsText',
      shape: 'scalar',
      params: [{ name: 'a', type: { kind: 'text' } }],
      output: { kind: 'bool' },
      instructions: 'Takes text, so a geometry column cannot be handed to it.',
    });
    const report = await differentialCheck({
      engine,
      dialect: 'postgres',
      execute: scriptedDb([]).execute,
      columns: { type: 'parcel', field: 'shape', other: 'nextShape' },
      functions: ['needsText'],
    });
    const warning = report.problems.find((p) => p.code === 'conformance.differential-unprobeable');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('needsText');
    expect(warning?.message).toContain('refused by this package');
    expect(report.unprobeable.map((s) => s.label)).toContain('needsText');
  });
});

describe('`differentialCheck` probes the roads a comparator is NOT wired into', () => {
  /** A comparator whose EQUALITY is coarser than raw identity — the case DISTINCT diverges on. */
  const by24: ValueComparator = (a, b) =>
    String(a).replace(/\.\d+$/, '').localeCompare(String(b).replace(/\.\d+$/, ''));

  function netEngine(): QueryEngine {
    const registry = createRegistry().registerFieldType({
      name: 'Net',
      base: 'text',
      instructions: 'An address whose /24 is its identity.',
      options: { casing: 'exact' },
    });
    registry.registerFieldTypeImpl('Net', { compareValues: by24 });
    registry.registerType(
      registry.parseType({
        name: 'host',
        fields: [
          { name: 'id', type: { kind: 'number', whole: true } },
          { name: 'addr', type: { kind: 'text', as: 'Net' } },
        ],
        count: 10,
        bytes: 32,
      }),
    );
    registry.finalize();
    return new QueryEngine(registry, {
      executors: { host: arrayExecutor([{ id: 1, addr: '10.0.0.1' }, { id: 2, addr: '10.0.0.9' }]) },
    });
  }

  it('reports the DISTINCT and GROUP BY divergence a coarse comparator produces', async () => {
    // The database's column type agrees with the comparator and collapses the
    // two addresses; this package keys `DISTINCT` / `GROUP BY` on the raw value
    // and keeps them apart (`runtime/record.ts` states the boundary). Before
    // these probes existed the mechanism's gap and the harness's blind spot were
    // the same shape.
    // BOTH addresses tie under this comparator, so a stable sort returns them in
    // insertion order for asc AND desc — the "tie-break inside the comparator"
    // consequence `FieldTypeImpl.compareValues` records, here as a fixture.
    // Most specific FIRST: every probe here ends in the same `ORDER BY`, so the
    // DISTINCT and GROUP BY keys have to be consulted before it.
    const db = scriptedDb([], {
      'SELECT DISTINCT': ['10.0.0.1'],
      'GROUP BY': ['10.0.0.1'],
      'ORDER BY "host"."addr" ASC': ['10.0.0.1', '10.0.0.9'],
      'ORDER BY "host"."addr" DESC': ['10.0.0.1', '10.0.0.9'],
    });
    const report = await differentialCheck({
      engine: netEngine(),
      dialect: 'postgres',
      execute: db.execute,
      columns: { type: 'host', field: 'addr' },
    });
    const failed = report.probes.filter((p) => !p.agreed).map((p) => p.label);
    expect(failed).toEqual(['distinct', 'group by']);
    expect(db.statements[2]).toContain('SELECT DISTINCT "host"."addr" AS "probe"');
    expect(db.statements[3]).toContain('GROUP BY "host"."addr"');
  });

  it('compares a VALUE probe as a MULTISET, so a tie in the driving column is not a disagreement', async () => {
    // `valueProbe` projects an expression and orders by the driving FIELD, so two
    // rows with equal driving values may come back in either order. Positionally
    // that reads as a divergence for an operator that agrees; as a multiset it
    // does not, and no "your driving column must be unique" precondition is owed.
    const engine = netEngine();
    engine.registry.registerFunction({
      name: 'tail',
      shape: 'scalar',
      params: [{ name: 'a', type: { kind: 'text' } }],
      output: { kind: 'text' },
      instructions: 'The last octet, so two rows of one /24 project different values.',
    });
    engine.registry.registerFunctionRun('tail', {
      shape: 'scalar',
      run: (args) => Value.of(String(args['a']!.raw).split('.').pop() ?? ''),
    });
    // The same two values the run produced, in the OTHER order — which is what a
    // server is free to return under an ORDER BY whose key ties.
    const db = scriptedDb([], { 'tail(': ['9', '1'] });
    const report = await differentialCheck({
      engine,
      dialect: 'postgres',
      execute: db.execute,
      columns: { type: 'host', field: 'addr', other: 'addr' },
      functions: ['tail'],
    });
    const probe = report.probes.find((p) => p.label === 'tail');
    expect(probe?.comparison).toBe('multiset');
    expect(probe?.runValues).toEqual(['1', '9']);
    expect(probe?.sqlValues).toEqual(['9', '1']);
    expect(probe?.agreed).toBe(true);
  });

  it('an ORDER probe still compares the SEQUENCE — that is the property under test', async () => {
    const db = scriptedDb([], { 'ORDER BY "host"."addr" ASC': ['10.0.0.9', '10.0.0.1'] });
    const report = await differentialCheck({
      engine: netEngine(),
      dialect: 'postgres',
      execute: db.execute,
      columns: { type: 'host', field: 'addr' },
    });
    const asc = report.probes.find((p) => p.label === 'order asc');
    expect(asc?.comparison).toBe('sequence');
    // The same MULTISET, a different sequence — and the ordering probe says so.
    expect(asc?.agreed).toBe(false);
  });

  it('reads a driver value that is not JSON as itself, so an artifact shows as one', async () => {
    // `pg` hands back a `Date` for `timestamptz` and a string for `numeric`. The
    // row type says `unknown` rather than pretending otherwise, and the
    // comparison renders both sides the same way — so the report shows the driver
    // artifact instead of silently agreeing or silently blaming the type.
    const when = new Date('2026-01-01T00:00:00.000Z');
    const execute: DifferentialExecute = async () => [{ probe: when }];
    const report = await differentialCheck({
      engine: netEngine(),
      dialect: 'postgres',
      execute,
      columns: { type: 'host', field: 'addr' },
    });
    expect(report.probes[0]!.sqlValues).toEqual([when]);
    expect(report.problems.some((p) => p.message.includes('what your driver deserialises'))).toBe(true);
  });
});
