/**
 * Coverage: describe.ts — field type tags, index rendering, function signatures,
 * dialect listing, and the engine/registry narrowing.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry, Registry } from '../registry';
import { QueryEngine } from '../engine';
import { Problems } from '../problem';
import { isRecord } from '../shape';
import { ExprQuery } from '../queries/index';
import {
  describeType,
  describeTypes,
  describeFunctions,
  describeExprs,
  describeQueryExamples,
  describeDialects,
  describeEngine,
  DEFAULT_MAX_EXAMPLES,
} from '../llm/describe';
import type { TypeDef } from '../schema';

/** Query `kind` discriminants — an example whose top-level `kind` is one of these
 *  is a FULL query (validated via `parseCheckedQuery`); otherwise an expr fragment. */
const QUERY_KINDS = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'union',
  'intersect',
  'except',
  'cte',
  'expr',
]);

const widgetDef: TypeDef = {
  name: 'widget',
  label: 'Widget',
  description: 'A widget row',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'price', type: { kind: 'money', currency: 'USD' } },
    { name: 'plainMoney', type: { kind: 'money' } }, // money, no currency
    { name: 'notes', type: { kind: 'text', search: true, semantic: true }, label: 'Notes' },
    { name: 'plain', type: { kind: 'text' }, nullable: true },
    { name: 'parentId', type: { kind: 'relation', to: 'widget', count: 1 } },
  ],
  indexes: [
    { exprs: [{ expr: { kind: 'field-ref', source: 'widget', field: 'id' }, count: 1 }] }, // unique field-ref
    {
      exprs: [
        { expr: { kind: 'field-ref', source: 'widget', field: 'price' }, count: 5 },
        { expr: { kind: 'literal', value: 1 }, count: 2 }, // non-field-ref part → indexExprText fallback
      ],
    },
  ],
  count: 100,
  bytes: 32,
};

function widgetEngine() {
  const registry = createRegistry();
  registry.registerType(registry.parseType(widgetDef));
  registry.registerFunction({ name: 'genRows', shape: 'tabular', params: [{ name: 'n', type: { kind: 'number' } }], output: { type: 'widget' } });
  registry.finalize();
  return new QueryEngine(registry);
}

describe('describeType', () => {
  it('renders header, fields, tags, relations, and indexes', () => {
    const out = describeType(widgetEngine().registry.type('widget')!);
    expect(out).toContain('## widget (Widget)');
    expect(out).toContain('A widget row');
    expect(out).toContain('price: money(USD)');
    expect(out).toContain('plainMoney: money');
    expect(out).toContain('notes: text(search,semantic)');
    expect(out).toContain('plain: text (nullable)');
    expect(out).toContain('— Notes'); // label docs
    expect(out).toContain('relation→widget');
    expect(out).toContain('relations:');
    expect(out).toContain('indexes:');
    expect(out).toContain('(unique)');
    expect(out).toContain('literal'); // the non-field-ref index part
  });
});

describe('describeFunctions / describeDialects / describeEngine / describeTypes', () => {
  it('lists signatures incl. tabular output + inferred, and handles none selected', () => {
    const engine = widgetEngine();
    const fns = describeFunctions(engine, 'all');
    expect(fns).toContain('scalar:');
    expect(fns).toContain('tabular:');
    expect(fns).toContain('genRows(n): widget'); // {type} output, no instructions
    expect(fns).toContain('sum(value): inferred — Sum of the non-null values.'); // inferred + instructions
    const none = describeFunctions(engine.registry, { scalar: 'none', aggregate: 'none', window: 'none', tabular: 'none' });
    expect(none).toBe('functions: (none selected)');
  });

  it('describeDialects handles empty + populated registries', () => {
    expect(describeDialects(widgetEngine())).toContain('dialects:');
    expect(describeDialects(new Registry())).toBe('dialects: (none registered)');
  });

  it('describeTypes accepts an engine or a registry; describeEngine combines', () => {
    const engine = widgetEngine();
    expect(describeTypes(engine)).toContain('## widget');
    expect(describeTypes(engine.registry)).toContain('## widget');
    const de = describeEngine(engine);
    expect(de).toContain('dialects:');
    expect(de).toContain('query examples:');
  });
});

/**
 * The SHIPPED examples (function `examples` + node `EXAMPLES`) are type-agnostic
 * and teach SHAPE, so they are validated STRUCTURALLY: each must `JSON.parse` and
 * pass a BARE registry's `parseCheckedQuery` (full-query examples) / `parseCheckedExpr`
 * (expr fragments) with ZERO structural problems. A malformed shipped example FAILS.
 */
describe('shipped examples are structurally valid', () => {
  const registry = createRegistry();

  /** Structurally validate one raw-JSON example; discriminates query vs expr by `kind`. */
  function validate(raw: string): Problems {
    const parsed = JSON.parse(raw);
    const kind = isRecord(parsed) && typeof parsed['kind'] === 'string' ? parsed['kind'] : '';
    const p = new Problems();
    if (QUERY_KINDS.has(kind)) registry.parseCheckedQuery(parsed, p);
    else registry.parseCheckedExpr(parsed, p);
    return p;
  }

  it('every FUNCTION example parses + validates with no structural problems', () => {
    let seen = 0;
    for (const fn of registry.functionList()) {
      for (const ex of fn.examples ?? []) {
        seen++;
        const p = validate(ex);
        expect(p.hasErrors, `${fn.name}: ${p.list.map((x) => x.code).join(', ')} — ${ex}`).toBe(false);
      }
    }
    expect(seen).toBeGreaterThan(0); // guard: the window family etc. ship examples
  });

  it('every EXPR-node example parses + validates with no structural problems', () => {
    let seen = 0;
    for (const cls of registry.exprClassList()) {
      for (const ex of cls.EXAMPLES ?? []) {
        seen++;
        const p = validate(ex);
        expect(p.hasErrors, `${cls.KIND}: ${p.list.map((x) => x.code).join(', ')} — ${ex}`).toBe(false);
      }
    }
    expect(seen).toBeGreaterThan(0); // guard: window / exists / in / subquery / function-call ship examples
  });

  it('every QUERY-node example parses + validates with no structural problems', () => {
    let seen = 0;
    for (const cls of registry.queryClassList()) {
      for (const ex of cls.EXAMPLES ?? []) {
        seen++;
        const p = validate(ex);
        expect(p.hasErrors, `${cls.KIND}: ${p.list.map((x) => x.code).join(', ')} — ${ex}`).toBe(false);
      }
    }
    expect(seen).toBeGreaterThan(0); // guard: select / union / cte ship examples
  });
});

describe('describeEngine example rendering + maxExamples', () => {
  const engine = widgetEngine();

  it('renders worked examples under exprs, functions, and the query-examples section', () => {
    const de = describeEngine(engine);
    // Expr-kind example (WindowExpr ships a worked rank SELECT). Rendered examples
    // begin `e.g. {` — distinct from the literal "e.g." some INSTRUCTIONS contain.
    expect(de).toContain('  - window —');
    expect(de).toContain('e.g. {');
    expect(de).toContain('"function":"rank"');
    // Query-examples section (SetOperationQuery / CTEStatementQuery / SelectQuery).
    expect(de).toContain('query examples:');
    expect(de).toContain('"kind":"union"');
    expect(de).toContain('"kind":"cte"');
  });

  it('maxExamples caps examples per node / function; 0 omits them entirely', () => {
    const none = describeEngine(engine, { maxExamples: 0 });
    expect(none).not.toContain('e.g. {');
    // The query-examples section header still renders (kinds + instructions), sans examples.
    expect(none).toContain('query examples:');

    // InExpr ships TWO examples; a cap of 1 shows only the first (the value LIST form).
    const capped = describeExprs(engine, undefined, 'all', 1);
    const inLine = capped.split('\n').filter((l) => l.includes('"kind":"in"'));
    expect(inLine.length).toBe(1);
    const full = describeExprs(engine, undefined, 'all', 2);
    expect(full.split('\n').filter((l) => l.includes('"kind":"in"')).length).toBe(2);
  });

  it('describeQueryExamples renders only kinds that ship EXAMPLES', () => {
    const qe = describeQueryExamples(engine);
    expect(qe).toContain('query examples:');
    expect(qe).toContain('  select —');
    expect(qe).toContain('  union —');
    expect(qe).toContain('  cte —');
    // insert/update/delete/expr ship no examples ⇒ absent.
    expect(qe).not.toContain('  insert');
    // An empty registry yields the "(none)" sentinel.
    expect(describeQueryExamples(new Registry())).toBe('query examples: (none)');
  });

  it('renders a query kind that ships EXAMPLES but no INSTRUCTIONS (no em-dash)', () => {
    const reg = createRegistry();
    // Override the `expr` kind with an entry that ships EXAMPLES but NO INSTRUCTIONS.
    reg.defineQuery({
      KIND: 'expr',
      from: ExprQuery.from,
      EXAMPLES: ['{"kind":"expr","expr":{"kind":"literal","value":1}}'],
    });
    const line = describeQueryExamples(reg)
      .split('\n')
      .find((l) => l.startsWith('  expr'));
    expect(line).toBe('  expr'); // no ` — <INSTRUCTIONS>` suffix
  });

  it('DEFAULT_MAX_EXAMPLES is a small positive cap', () => {
    expect(DEFAULT_MAX_EXAMPLES).toBeGreaterThan(0);
  });
});
