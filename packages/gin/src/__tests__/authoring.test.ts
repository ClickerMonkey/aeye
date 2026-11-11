import { describe, expect, it } from 'vitest';
import { createRegistry } from '../registry';
import { createEngine } from '../engine';
import { argProblems, disclose, exprProblems, missingArgs, typeSurface } from '../authoring';
import type { TypeDef } from '../schema';

const Address: TypeDef = { name: 'obj', props: { city: { type: { name: 'text' } }, zip: { type: { name: 'text' } } } };
const Person: TypeDef = { name: 'obj', docs: 'A person.', props: { name: { type: { name: 'text' } }, home: { type: { name: 'Address' } } } };
const named: Record<string, TypeDef> = { Address, Person };

describe('gin authoring aids', () => {
  it('prints a type and names the types it refers to without inlining them', () => {
    const r = createRegistry();
    const surface = typeSurface(r, Person);
    expect(surface.code).toContain('name');
    expect(surface.refs).toEqual(['Address']);
    expect(surface.cut).toBe(false);
    expect(typeSurface(r, Person, 10).cut).toBe(true);
  });

  it('discloses referenced types a step at a time, never twice', () => {
    const r = createRegistry();
    const seen = new Set<string>();
    const first = disclose(r, ['Person', 'Nope'], (n) => named[n], seen);
    expect(first.shown.map((s) => s.name)).toEqual(['Person', 'Address']);
    expect(first.missing).toEqual(['Nope']);
    const again = disclose(r, ['Person'], (n) => named[n], seen);
    expect(again.shown).toEqual([]);
  });

  it('keeps what does not fit for the next step', () => {
    const r = createRegistry();
    const step = disclose(r, ['Person'], (n) => named[n], new Set(), 5);
    expect(step.shown.map((s) => s.name)).toEqual(['Person']);
    expect(step.next).toEqual(['Address']);
  });

  it('refuses missing required args, unknown args and bad values', () => {
    const r = createRegistry();
    const args: TypeDef = { name: 'obj', props: { n: { type: { name: 'num', options: { whole: true, min: 1 } } }, tag: { type: { name: 'optional', generic: { T: { name: 'text' } } } } } };
    expect(missingArgs(args, {})).toEqual(['n']);
    expect(argProblems(r, args, {})).toEqual(['n is required: give a value for it.']);
    expect(argProblems(r, args, { n: 2 })).toEqual([]);
    expect(argProblems(r, args, { n: 2, extra: 1 }).length).toBeGreaterThan(0);
    expect(argProblems(r, args, { n: 0 }).length).toBeGreaterThan(0);
  });

  it('checks an expression and what it produces', () => {
    const e = createEngine(createRegistry());
    const ok = exprProblems(e, { kind: 'new', type: { name: 'num' }, value: 3 }, { expect: { name: 'num' } });
    expect(ok.ok).toBe(true);
    const wrong = exprProblems(e, { kind: 'new', type: { name: 'num' }, value: 3 }, { expect: { name: 'text' } });
    expect(wrong.ok).toBe(false);
    expect(wrong.report).toContain('expected');
    const unknown = exprProblems(e, { kind: 'get', path: [{ prop: 'nothing' }] });
    expect(unknown.ok).toBe(false);
  });
});
