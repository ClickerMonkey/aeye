/**
 * Coverage: describe.ts — field type tags, index rendering, function signatures,
 * dialect listing, and the engine/registry narrowing.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry, Registry } from '../registry';
import { QueryEngine } from '../engine';
import {
  describeType,
  describeTypes,
  describeFunctions,
  describeDialects,
  describeEngine,
  exampleQueriesText,
} from '../llm/describe';
import type { TypeDef } from '../schema';

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
    expect(describeEngine(engine)).toContain('dialects:');
    expect(exampleQueriesText()).toContain('field-ref');
  });
});
