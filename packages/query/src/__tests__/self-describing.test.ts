/**
 * The function + expression catalog is self-describing for an LLM: every
 * builtin `FunctionDef` carries a non-empty `instructions`, every registered
 * Expr class carries a non-empty `static INSTRUCTIONS`, and
 * `QueryFunction` round-trips `instructions` (plus every param / output shape)
 * through `from` / `toJSON`.
 */
import { describe, it, expect } from 'vitest';
import { fixture } from './_utils';
import { createRegistry } from '../registry';
import { QueryFunction } from '../function';
import { BUILTIN_LIBRARY } from '../runtime/builtins';
import type { FunctionDef } from '../schema';

describe('self-describing catalog', () => {
  it('every builtin function has a non-empty instructions', () => {
    expect(BUILTIN_LIBRARY.length).toBeGreaterThan(0);
    for (const { def } of BUILTIN_LIBRARY) {
      expect(typeof def.instructions).toBe('string');
      expect((def.instructions ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('every registered expr class has a non-empty static INSTRUCTIONS', () => {
    const classes = createRegistry().exprClassList();
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(typeof cls.INSTRUCTIONS).toBe('string');
      expect(cls.INSTRUCTIONS.trim().length).toBeGreaterThan(0);
    }
  });

  it('QueryFunction round-trips instructions + every param / output shape', () => {
    const reg = createRegistry();
    for (const { def } of BUILTIN_LIBRARY) {
      const fn = QueryFunction.from(def, reg);
      expect(fn.instructions).toBe(def.instructions);
      const json = fn.toJSON();
      expect(json.instructions).toBe(def.instructions);
      expect(fn.examples).toEqual(def.examples);
      expect(json.examples).toEqual(def.examples);
      expect(json.name).toBe(def.name);
      expect(json.shape).toBe(def.shape);
      expect(json.params).toEqual(def.params);
      expect(json.output).toEqual(def.output);
      expect(json.sql).toEqual(def.sql);
      expect(json.rawArgs).toEqual(def.rawArgs);
    }
  });

  it('toJSON re-emits a tabular {type} output and omits an absent instructions', () => {
    const fx = fixture(); // fx.user is a Type registered in fx.registry
    const def: FunctionDef = { name: 'rows', shape: 'tabular', params: [], output: { type: 'user' } };
    const fn = QueryFunction.from(def, fx.registry);
    const json = fn.toJSON();
    expect(json.output).toEqual({ type: 'user' });
    expect(json.instructions).toBeUndefined();
    expect(fn.instructions).toBeUndefined();
  });
});
