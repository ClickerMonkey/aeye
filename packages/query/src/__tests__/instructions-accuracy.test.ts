/**
 * 0.6.1 — the shipped INSTRUCTIONS must describe what the library ACTUALLY does.
 *
 * `describeEngine` / `describeExprs` render every node's `static INSTRUCTIONS`
 * into the prompt a model reads before it authors a query, so an instruction
 * that lags a behaviour change is not a typo: it is the library actively
 * teaching models to avoid (or to reach for) something its own code no longer
 * refuses (or no longer offers). `FieldRefExpr.INSTRUCTIONS` shipped 0.6.0
 * still saying a relation ref "resolves to the whole related row, NOT a scalar"
 * — after A8 made a belongs-to ref project the relation's IDENTITY.
 *
 * Two halves, and the NEGATIVE half is what catches the next regression:
 *  - the RENDERED description states the current rule, and no longer contains
 *    any retired phrase (swept across every expr / query node, not just the one
 *    that was wrong);
 *  - every ERROR CODE an instruction names is the code validation actually
 *    emits for the case the instruction describes — so a behaviour change that
 *    renames or removes a refusal fails here, next to the prose that promised it.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { describeEngine, describeExprs } from '../llm/describe';
import { generatedFieldDescription } from '../llm/describe-generate';
import type { TypeDef, SelectDef, ExprDef } from '../schema';
import type { TypeBacking } from '../backing';

/** `person` — the relation TARGET, identity declared, one searchable text field. */
const personDef: TypeDef = {
  name: 'person',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text', search: true } },
  ],
  identity: 'id',
  // Deliberately EQUAL to `ticket.count`, so the materialized inverse
  // (`person.tickets`) is estimated at a row ratio of exactly 1 — the A1 shape
  // whose direction `count` alone cannot tell (see the describe-generate case).
  count: 1000,
  bytes: 32,
};

/** `ticket` — belongs-to `owner`, materializing the has-many `person.tickets`. */
const ticketDef: TypeDef = {
  name: 'ticket',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text' } },
    { name: 'owner', type: { kind: 'relation', to: 'person', count: 1, inverseRelation: 'tickets' }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'ticket', field: 'id' }, count: 1 }] }],
  count: 1000,
  bytes: 48,
};

/** A COMPOSITE-identity target + a relation into it (the `in` subquery refusal). */
const tenantUserDef: TypeDef = {
  name: 'tenantUser',
  fields: [
    { name: 'tenantId', type: { kind: 'number', whole: true } },
    { name: 'userId', type: { kind: 'number', whole: true } },
  ],
  identity: ['tenantId', 'userId'],
  count: 50,
  bytes: 16,
};

const taskDef: TypeDef = {
  name: 'task',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'ownerTenant', type: { kind: 'number', whole: true } },
    { name: 'ownerUser', type: { kind: 'number', whole: true } },
    { name: 'assignee', type: { kind: 'relation', to: 'tenantUser', count: 1 }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'task', field: 'id' }, count: 1 }] }],
  count: 500,
  bytes: 24,
};

/** `task.assignee`'s physical composite FK — a multi-column key has no name convention. */
const taskBacking: TypeBacking = {
  fields: {
    assignee: {
      relation: {
        keys: [
          { local: 'ownerTenant', foreign: 'tenantId' },
          { local: 'ownerUser', foreign: 'userId' },
        ],
      },
    },
  },
};

function engineOf(): QueryEngine {
  const registry = createRegistry();
  for (const def of [personDef, ticketDef, tenantUserDef]) {
    registry.registerType(registry.parseType(def));
  }
  registry.registerType(registry.parseType(taskDef), taskBacking);
  registry.finalize();
  return new QueryEngine(registry);
}

const ref = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });

/** The problem codes a query validates to (empty = clean). */
function codes(engine: QueryEngine, query: SelectDef): string[] {
  return engine.validateQuery(query).list.map((p) => p.code);
}

/** `SELECT <expr> AS v FROM <type>` — the smallest carrier for one expression. */
function selectOne(type: string, expr: ExprDef): SelectDef {
  return { kind: 'select', fields: [{ expr, as: 'v' }], from: { kind: 'type', type } };
}

/** `SELECT <type>.id FROM <type> WHERE <pred>`. */
function whereOne(type: string, pred: ExprDef): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: ref(type, 'id'), as: 'id' }],
    from: { kind: 'type', type },
    where: [pred],
  };
}

// ─── The rendered description states 0.6.0's rule ────────────────────────────

describe('the rendered field-ref description states the identity rule', () => {
  const engine = engineOf();

  it('describes a belongs-to ref as a projectable IDENTITY needing no join', () => {
    const out = describeExprs(engine);
    const line = out.split('\n').find((l) => l.startsWith('  - field-ref —'))!;
    expect(line).toContain('BELONGS-TO');
    expect(line).toContain('IDENTITY');
    expect(line).toContain('NO join');
    // The has-many refusal, by the code the model will actually receive.
    expect(line).toContain('ref.relation-has-many');
    // Crossing the relation is still how you read the target's OTHER fields.
    expect(line).toContain("joins:[{on:{kind:'relation',source,field,as}}]");
  });

  it('no longer teaches the retired "whole related row" rule', () => {
    const line = describeExprs(engine)
      .split('\n')
      .find((l) => l.startsWith('  - field-ref —'))!;
    expect(line).not.toContain('whole related row');
    expect(line).not.toContain('may only be compared to ANOTHER relation');
  });
});

/**
 * The retired statements, swept across EVERY shipped instruction / example and
 * the composed `describeEngine` block — the half that catches the next node to
 * go stale, not just the one that was wrong this time. Each entry is a claim
 * 0.6.0 made false; a node that reintroduces one fails here.
 */
const RETIRED_PHRASES: readonly string[] = [
  // A8 — a belongs-to ref IS a value (its identity), so this is now backwards.
  'whole related row',
  'may only be compared to ANOTHER relation',
  // The expr kind removed with the named-join model.
  'relation-path',
];

describe('no shipped instruction or example teaches a retired rule', () => {
  const engine = engineOf();

  it('the composed describeEngine block contains no retired phrase', () => {
    const block = describeEngine(engine);
    for (const phrase of RETIRED_PHRASES) {
      expect(block, `describeEngine still teaches "${phrase}"`).not.toContain(phrase);
    }
  });

  it('every expr / query node INSTRUCTIONS + EXAMPLES is free of them', () => {
    const registry = engine.registry;
    const texts: { where: string; text: string }[] = [];
    for (const cls of registry.exprClassList()) {
      texts.push({ where: `expr ${cls.KIND} INSTRUCTIONS`, text: cls.INSTRUCTIONS });
      for (const [i, ex] of (cls.EXAMPLES ?? []).entries()) {
        texts.push({ where: `expr ${cls.KIND} EXAMPLES[${i}]`, text: ex });
      }
    }
    for (const cls of registry.queryClassList()) {
      texts.push({ where: `query ${cls.KIND} INSTRUCTIONS`, text: cls.INSTRUCTIONS ?? '' });
      for (const [i, ex] of (cls.EXAMPLES ?? []).entries()) {
        texts.push({ where: `query ${cls.KIND} EXAMPLES[${i}]`, text: ex });
      }
    }
    for (const fn of registry.functionList()) {
      texts.push({ where: `function ${fn.name} instructions`, text: fn.instructions ?? '' });
      for (const [i, ex] of (fn.examples ?? []).entries()) {
        texts.push({ where: `function ${fn.name} examples[${i}]`, text: ex });
      }
    }
    expect(texts.length).toBeGreaterThan(0);
    for (const { where, text } of texts) {
      for (const phrase of RETIRED_PHRASES) {
        expect(text, `${where} still teaches "${phrase}"`).not.toContain(phrase);
      }
    }
  });
});

// ─── Every code an instruction NAMES is the code validation emits ────────────

describe('the codes the instructions name are the codes validation emits', () => {
  const engine = engineOf();

  it('field-ref: a belongs-to projects clean; a has-many is `ref.relation-has-many`', () => {
    expect(codes(engine, selectOne('ticket', ref('ticket', 'owner')))).toEqual([]);
    expect(codes(engine, selectOne('person', ref('person', 'tickets')))).toContain('ref.relation-has-many');
  });

  it('is-null: a belongs-to is a legal UNSET test; a has-many is refused', () => {
    expect(codes(engine, whereOne('ticket', { kind: 'is-null', value: ref('ticket', 'owner') }))).toEqual([]);
    expect(
      codes(engine, whereOne('person', { kind: 'is-null', value: ref('person', 'tickets') })),
    ).toContain('ref.relation-has-many');
  });

  it('aggregate: a relation identity is not aggregable (`ref.relation-aggregate`)', () => {
    const agg: ExprDef = { kind: 'aggregate', function: 'max', args: { value: ref('ticket', 'owner') } };
    expect(codes(engine, selectOne('ticket', agg))).toContain('ref.relation-aggregate');
  });

  it('in: a COMPOSITE-key relation may not use the subquery form (`in.relation-composite`)', () => {
    const pred: ExprDef = {
      kind: 'in',
      value: ref('task', 'assignee'),
      in: {
        kind: 'select',
        fields: [{ expr: ref('tenantUser', 'userId') }],
        from: { kind: 'type', type: 'tenantUser' },
      },
    };
    expect(codes(engine, whereOne('task', pred))).toContain('in.relation-composite');
  });

  it('text-search / text-score: an unbacked whole-source form is refused, a narrowed one is not', () => {
    expect(codes(engine, whereOne('person', { kind: 'text-search', source: 'person', query: 'ada' })))
      .toContain('text-search.unbacked');
    expect(codes(engine, whereOne('person', { kind: 'text-search', source: 'person', field: 'name', query: 'ada' })))
      .toEqual([]);
    expect(codes(engine, selectOne('person', { kind: 'text-score', source: 'person', query: 'ada' })))
      .toContain('text-score.unbacked');
  });

  /**
   * The `comparison` INSTRUCTIONS' PARAM-ONLY rule, verified rather than
   * assumed: a relation's RHS is a `{ pk }` (or single-key scalar) bind PARAM,
   * or another relation of the same target — a LITERAL is not exempt from the
   * relation-vs-value guard and is refused.
   */
  it('comparison: a relation compares against a PARAM, not a literal', () => {
    const withParam: ExprDef = {
      kind: 'comparison',
      op: '=',
      left: ref('ticket', 'owner'),
      right: { kind: 'param', name: 'who' },
    };
    expect(codes(engine, whereOne('ticket', withParam))).toEqual([]);

    const withLiteral: ExprDef = {
      kind: 'comparison',
      op: '=',
      left: ref('ticket', 'owner'),
      right: { kind: 'literal', value: 5 },
    };
    expect(codes(engine, whereOne('ticket', withLiteral))).toContain('compare.relation-vs-value');

    // Ordering a relation is refused too, exactly as the instruction says.
    const ordered: ExprDef = {
      kind: 'comparison',
      op: '>',
      left: ref('ticket', 'owner'),
      right: { kind: 'param', name: 'who' },
    };
    expect(codes(engine, whereOne('ticket', ordered))).toContain('comparison.relation-order');
  });
});

// ─── The GENERATED per-field docs describe the right direction ───────────────

/**
 * The same defect one layer down: `describeField`'s generated sentence read
 * `count === 1` to decide belongs-to, so a MATERIALIZED INVERSE whose estimated
 * count came out as 1 (a 1:1 pair, or two Types sharing one row estimate) was
 * described to the model as a belongs-to — i.e. as a projectable identity that
 * a field-ref to it is refused for.
 */
describe('a materialized inverse is described as a HAS-MANY, whatever its count', () => {
  const engine = engineOf();

  it('does not call a count-1 inverse a belongs-to', () => {
    const person = engine.registry.type('person')!;
    const tickets = person.field('tickets')!;
    // The precondition this test exists for: the estimate really is 1 here.
    expect(generatedFieldDescription(tickets)).toContain('Has many ticket');
    expect(generatedFieldDescription(tickets)).not.toContain('Belongs to one');
  });

  it('still calls a declared belongs-to a belongs-to', () => {
    const ticket = engine.registry.type('ticket')!;
    expect(generatedFieldDescription(ticket.field('owner')!)).toBe('Belongs to one person. Optional (may be null).');
  });
});
