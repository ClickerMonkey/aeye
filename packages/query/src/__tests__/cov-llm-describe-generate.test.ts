/**
 * Coverage: describe-generate.ts (default label/description GENERATION for every
 * FieldType incl. relation / array / sensitive / nullable, dev-provided winning
 * verbatim) + the Pass-2 describe surface (`describeExprs` capability gating, the
 * enhanced `describeFunctions`, and `describeEngine` composition).
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import {
  describeType,
  describeExprs,
  describeFunctions,
  describeEngine,
} from '../llm/describe';
import {
  humanize,
  fieldMeta,
  typeMeta,
  generatedFieldLabel,
  generatedFieldDescription,
  generatedTypeLabel,
  generatedTypeDescription,
} from '../llm/describe-generate';
import type { TypeDef } from '../schema';

// A Type exercising every FieldType branch (bounds, currency, text flags,
// belongs-to / has-many relations, array item present/absent, nullability) plus
// one field carrying a DEV-supplied label + description (which must win).
const gadgetDef: TypeDef = {
  name: 'gadget',
  fields: [
    { name: 'wholeBounded', type: { kind: 'number', whole: true, min: 0, max: 100 } },
    { name: 'minOnly', type: { kind: 'number', min: 5 } },
    { name: 'maxOnly', type: { kind: 'number', max: 9 } },
    { name: 'plainNum', type: { kind: 'number' } },
    { name: 'usd', type: { kind: 'money', currency: 'USD' } },
    { name: 'bareMoney', type: { kind: 'money' } },
    { name: 'richText', type: { kind: 'text', search: true, semantic: true, sensitive: true } },
    { name: 'plainText', type: { kind: 'text' }, nullable: true },
    { name: 'flag', type: { kind: 'bool' }, label: 'On?', description: 'Whether enabled.' },
    { name: 'ownerId', type: { kind: 'relation', to: 'gadget', count: 1 } },
    { name: 'partIds', type: { kind: 'relation', to: 'gadget', count: 5 } },
    { name: 'when', type: { kind: 'date' } },
    { name: 'at', type: { kind: 'timestamp' } },
    { name: 'meta', type: { kind: 'json' } },
    { name: 'tagsTyped', type: { kind: 'array', item: { kind: 'text' }, minItems: 1, maxItems: 5 } },
    { name: 'tagsPlain', type: { kind: 'array' } },
  ],
  indexes: [
    { exprs: [{ expr: { kind: 'field-ref', source: 'gadget', field: 'wholeBounded' }, count: 1 }] },
  ],
  count: 500,
  bytes: 64,
};

// A minimal Type: no relations, no indexes, not searchable / semantic — the
// FALSE branches of the Type-summary + the capability gate.
const plainDef: TypeDef = {
  name: 'plainThing',
  fields: [{ name: 'ok', type: { kind: 'bool' } }],
  count: 3,
  bytes: 8,
};

// A Type WITH dev label + description (both must be used verbatim).
const docDef: TypeDef = {
  name: 'doc',
  label: 'Document',
  description: 'A stored document.',
  fields: [{ name: 'id', type: { kind: 'number' } }],
  count: 1,
  bytes: 8,
};

function gadgetEngine() {
  const r = createRegistry();
  r.registerType(r.parseType(gadgetDef));
  r.registerType(r.parseType(plainDef));
  r.registerType(r.parseType(docDef));
  // A tabular function so `tabular-function-call` is gated IN.
  r.registerFunction({
    name: 'genRows',
    shape: 'tabular',
    params: [{ name: 'n', type: { kind: 'number' } }],
    output: { type: 'gadget' },
  });
  r.finalize();
  return new QueryEngine(r);
}

describe('humanize', () => {
  it('splits camelCase / snake / kebab, drops trailing Id, falls back to raw', () => {
    expect(humanize('parentId')).toBe('Parent'); // camel + trailing Id dropped
    expect(humanize('unit_price')).toBe('Unit Price'); // snake, last word kept
    expect(humanize('user')).toBe('User'); // single word
    expect(humanize('partIds')).toBe('Part Ids'); // last word ≠ 'Id' → kept
    expect(humanize('_')).toBe('_'); // humanizes to empty → raw name
  });
});

describe('generated field label / description (each FieldType branch)', () => {
  const gadget = gadgetEngine().registry.type('gadget')!;
  const f = (name: string) => gadget.field(name)!;

  it('derives a sensible one-line description per field type', () => {
    expect(generatedFieldDescription(f('wholeBounded'))).toBe('A whole number (0–100).');
    expect(generatedFieldDescription(f('minOnly'))).toBe('A number (≥ 5).');
    expect(generatedFieldDescription(f('maxOnly'))).toBe('A number (≤ 9).');
    expect(generatedFieldDescription(f('plainNum'))).toBe('A number.');
    expect(generatedFieldDescription(f('usd'))).toBe('A monetary amount in USD.');
    expect(generatedFieldDescription(f('bareMoney'))).toBe('A monetary amount.');
    expect(generatedFieldDescription(f('richText'))).toBe(
      'Text (full-text searchable, semantic-search eligible, case-sensitive).',
    );
    expect(generatedFieldDescription(f('plainText'))).toBe('Text. Optional (may be null).');
    expect(generatedFieldDescription(f('flag'))).toBe('A true/false flag.');
    expect(generatedFieldDescription(f('ownerId'))).toBe('Belongs to one gadget.');
    expect(generatedFieldDescription(f('partIds'))).toBe('Has many gadget (≈5 per row).');
    expect(generatedFieldDescription(f('when'))).toBe('A calendar date.');
    expect(generatedFieldDescription(f('at'))).toBe('A date and time.');
    expect(generatedFieldDescription(f('meta'))).toBe('A JSON document.');
    expect(generatedFieldDescription(f('tagsTyped'))).toBe('A list of text (1–5 items).');
    expect(generatedFieldDescription(f('tagsPlain'))).toBe('A list.');
  });

  it('labels from the humanized name; dev-provided label/description win verbatim', () => {
    expect(generatedFieldLabel(f('ownerId'))).toBe('Owner');
    // Dev-supplied on `flag`: both used verbatim.
    expect(fieldMeta(f('flag'))).toEqual({ label: 'On?', description: 'Whether enabled.' });
    // Nothing supplied on `usd`: both generated.
    expect(fieldMeta(f('usd'))).toEqual({ label: 'Usd', description: 'A monetary amount in USD.' });
  });
});

describe('generated type label / description', () => {
  const engine = gadgetEngine();

  it('summarizes fields / relations / indexes / capabilities; dev wins', () => {
    const gadget = engine.registry.type('gadget')!;
    const plain = engine.registry.type('plainThing')!;
    const doc = engine.registry.type('doc')!;

    expect(generatedTypeLabel(gadget)).toBe('Gadget');
    expect(generatedTypeDescription(gadget)).toBe(
      'Gadget: 16 fields, 2 relations, 1 indexes, full-text/semantic searchable; ~500 rows.',
    );
    // All the FALSE branches: no relations, no indexes, not searchable/semantic.
    expect(generatedTypeLabel(plain)).toBe('Plain Thing');
    expect(generatedTypeDescription(plain)).toBe('Plain Thing: 1 fields; ~3 rows.');
    // Dev label + description win verbatim.
    expect(typeMeta(doc)).toEqual({ label: 'Document', description: 'A stored document.' });
    // Generated pair for a Type with neither.
    expect(typeMeta(gadget).label).toBe('Gadget');
  });

  it('describeType renders generated + dev-supplied docs inline', () => {
    const out = describeType(engine.registry.type('gadget')!);
    expect(out).toContain('## gadget (Gadget)');
    expect(out).toContain('Gadget: 16 fields, 2 relations');
    expect(out).toContain('— On?: Whether enabled.'); // dev label + description
    expect(out).toContain('— Owner: Belongs to one gadget.'); // generated
  });
});

describe('describeExprs (capability-gated)', () => {
  const engine = gadgetEngine();
  const gadget = engine.registry.type('gadget')!;
  const plain = engine.registry.type('plainThing')!;

  it('lists kind — INSTRUCTIONS, gating IN eligible kinds for a rich Type', () => {
    const out = describeExprs(engine, [gadget]);
    expect(out.startsWith('expressions:')).toBe(true);
    // Always-usable core kinds are never gated.
    expect(out).toContain('  - literal —');
    expect(out).toContain('  - comparison —');
    // Gated IN: gadget is semantic / searchable / has an array / has relations.
    expect(out).toContain('  - semantic —');
    expect(out).toContain('  - text-search —');
    expect(out).toContain('  - text-score —');
    expect(out).toContain('  - array-op —');
    expect(out).toContain('  - relation-path —');
    expect(out).toContain('  - tabular-function-call —'); // genRows is tabular
    // The INSTRUCTIONS one-liner is included on each line.
    expect(out).toContain('[NOT] EXISTS');
    // `excluded` / `output` are position-only — never in the general catalog.
    expect(out).not.toContain('  - excluded —');
    expect(out).not.toContain('  - output —');
  });

  it('gates OUT kinds when no eligible Type is in scope', () => {
    const out = describeExprs(engine, [plain]);
    expect(out).not.toContain('  - semantic —');
    expect(out).not.toContain('  - text-search —');
    expect(out).not.toContain('  - text-score —');
    expect(out).not.toContain('  - array-op —');
    expect(out).not.toContain('  - relation-path —');
    expect(out).toContain('  - comparison —'); // core still present
  });

  it('the function selector gates the function-shaped kinds', () => {
    const noTab = describeExprs(engine, [gadget], { tabular: 'none' });
    expect(noTab).not.toContain('  - tabular-function-call —');
    // Default types (every registered Type) still surface the gated-in kinds.
    expect(describeExprs(engine)).toContain('  - semantic —');
  });
});

describe('describeFunctions (enhanced) + describeEngine composition', () => {
  const engine = gadgetEngine();

  it('renders named params (a, b?), output, and instructions', () => {
    const fns = describeFunctions(engine, 'all');
    expect(fns).toContain('count(value?): number — Count rows'); // optional param + instructions
    expect(fns).toContain('sum(value): inferred — Sum of the non-null values.'); // inferred + instructions
    expect(fns).toContain('genRows(n): gadget'); // {type} output, no instructions
  });

  it('composes Types + exprs + functions + dialects into one block', () => {
    const gadget = engine.registry.type('gadget')!;
    const de = describeEngine(engine, { types: [gadget] });
    expect(de).toContain('## gadget');
    expect(de).toContain('expressions:');
    expect(de).toContain('functions:');
    expect(de).toContain('dialects:');
    // Default options: every registered Type.
    expect(describeEngine(engine)).toContain('expressions:');
  });
});
