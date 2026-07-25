/**
 * Coverage: llm/schemas depth resolution + auto-degrade, depthInstructions
 * notes per axis, and the tabular function source branch.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import {
  buildSchemas,
  resolveSchemaDepth,
  depthInstructions,
  shouldUseStringSchema,
  querySchema,
} from '../llm/schemas';
import type { TypeDef } from '../schema';

/** N types, each with a single field named `id` → typeCount N, fieldCount 1. */
function manyTypes(n: number): QueryEngine {
  const registry = createRegistry();
  for (let i = 0; i < n; i++) {
    const def: TypeDef = { name: `t${i}`, fields: [{ name: 'id', type: { kind: 'number', whole: true } }], count: 1, bytes: 1 };
    registry.registerType(registry.parseType(def));
  }
  registry.finalize();
  return new QueryEngine(registry);
}

/** 1 type with `n` distinct fields → typeCount 1, fieldCount n. */
function manyFields(n: number): QueryEngine {
  const registry = createRegistry();
  const fields = Array.from({ length: n }, (_, i) => ({ name: `f${i}`, type: { kind: 'number' as const, whole: true } }));
  registry.registerType(registry.parseType({ name: 't', fields, count: 1, bytes: 1 }));
  registry.finalize();
  return new QueryEngine(registry);
}

describe('resolveSchemaDepth auto-degrade (degradeRefs / degradeFns / typeNames / filters)', () => {
  it('paired refs degrade per which axis is over budget', () => {
    // types over only → keep field enum → 'fields'
    expect(resolveSchemaDepth(manyTypes(3), { depth: { refs: 'paired' }, maxEnumSize: 2 }).refs).toBe('fields');
    // fields over only → keep type enum → 'types'
    expect(resolveSchemaDepth(manyFields(3), { depth: { refs: 'paired' }, maxEnumSize: 2 }).refs).toBe('types');
    // both over → 'open'
    expect(resolveSchemaDepth(manyTypes(3), { depth: { refs: 'paired' }, maxEnumSize: 0 }).refs).toBe('open');
    // both, neither over → stays 'both'
    expect(resolveSchemaDepth(manyTypes(3), { depth: { refs: 'both' }, maxEnumSize: 100 }).refs).toBe('both');
    // single-axis levels drop to open when over
    expect(resolveSchemaDepth(manyTypes(3), { depth: { refs: 'types' }, maxEnumSize: 2 }).refs).toBe('open');
    expect(resolveSchemaDepth(manyFields(3), { depth: { refs: 'fields' }, maxEnumSize: 2 }).refs).toBe('open');
  });

  it('typeNames + filters + functions degrade when over budget', () => {
    expect(resolveSchemaDepth(manyTypes(3), { depth: { typeNames: 'enum' }, maxEnumSize: 2 }).typeNames).toBe('open');
    expect(resolveSchemaDepth(manyFields(3), { depth: { filters: 'paired' }, maxEnumSize: 2 }).filters).toBe('open');
    // Many builtin functions → typed degrades all the way to open at max 2.
    expect(resolveSchemaDepth(manyTypes(1), { depth: { functions: 'typed' }, maxEnumSize: 2 }).functions).toBe('open');
    // No maxEnumSize → the resolved depth passes through untouched.
    expect(resolveSchemaDepth(manyTypes(1), { depth: 'paired' }).refs).toBe('paired');
  });
});

describe('depthInstructions notes per axis', () => {
  const engine = manyFields(2);
  it('emits the right note for each refs / functions / typeNames / filters depth', () => {
    expect(depthInstructions(engine, { depth: { refs: 'paired' } })).toMatch(/CONSTRAINED/);
    expect(depthInstructions(engine, { depth: { refs: 'both' } })).toMatch(/known Type names/);
    expect(depthInstructions(engine, { depth: { refs: 'types' } })).toMatch(/`source` must be/);
    expect(depthInstructions(engine, { depth: { refs: 'fields' } })).toMatch(/`field` must be/);
    expect(depthInstructions(engine, { depth: 'open' })).toBe(''); // all axes open → no notes
    expect(depthInstructions(engine, { depth: { typeNames: 'enum' } })).toMatch(/Type-name positions/);
    expect(depthInstructions(engine, { depth: { functions: 'typed' } })).toMatch(/declared NAMED parameters/);
    expect(depthInstructions(engine, { depth: { functions: 'names' } })).toMatch(/Function names/);
    expect(depthInstructions(engine, { depth: { filters: 'paired' } })).toMatch(/`filters` placeholder/);
  });
});

describe('tabular function source branch', () => {
  function tabularEngine() {
    const registry = createRegistry();
    registry.registerType(registry.parseType({ name: 'user', fields: [{ name: 'id', type: { kind: 'number', whole: true } }], count: 1, bytes: 1 }));
    registry.registerFunction({ name: 'genRows', shape: 'tabular', params: [{ name: 'n', type: { kind: 'number' } }], output: { type: 'user' } });
    registry.finalize();
    return new QueryEngine(registry);
  }

  it('Source accepts a function source in both open (string) and enum modes', () => {
    const openS = buildSchemas(tabularEngine(), { depth: 'open' });
    expect(openS.Source.safeParse({ kind: 'function', function: 'genRows', args: { n: { kind: 'literal', value: 1 } }, as: 'g' }).success).toBe(true);
    const pairedS = buildSchemas(tabularEngine(), { depth: 'paired' });
    expect(pairedS.Source.safeParse({ kind: 'function', function: 'genRows', args: { n: { kind: 'literal', value: 1 } }, as: 'g' }).success).toBe(true);
  });

  it('shouldUseStringSchema flags over-budget Type counts', () => {
    expect(shouldUseStringSchema(manyTypes(6).registry.typeList(), 5)).toBe(true);
    expect(shouldUseStringSchema(manyTypes(2).registry.typeList(), 5)).toBe(false);
  });

  it('the `max` threshold option raises the structured-schema budget (default 5)', () => {
    const eight = manyTypes(8);
    const types = eight.registry.typeList();
    // Default budget (5): 8 Types ⇒ string fallback.
    expect(shouldUseStringSchema(types)).toBe(true);
    // Raised to 10 (the downstream's case): 8 Types stays STRUCTURED.
    expect(shouldUseStringSchema(types, 10)).toBe(false);
    // `querySchema` honors the same `max` — structured `{ query: <object> }` vs prose `{ query: string }`.
    const structured = querySchema(eight, { max: 10 });
    expect(structured.safeParse({ query: 'a natural-language description' }).success).toBe(false);
    const prose = querySchema(eight); // default max 5 ⇒ string schema
    expect(prose.safeParse({ query: 'a natural-language description' }).success).toBe(true);
  });
});
