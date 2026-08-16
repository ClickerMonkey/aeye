import { describe, test, expect } from 'vitest';
import { createRegistry } from '../index';
import { Value } from '../value';

/**
 * An Extension's LOCAL props: which of them are DATA the value carries, and
 * which are pure SURFACE.
 *
 * WHAT WAS BROKEN. Nothing drew the line, so every local prop was surface to
 * `parse`/`valid`/`encode` and shape to `toValueSchema()`, and three surfaces
 * of one type disagreed:
 *
 *   const W = r.extend(r.obj({}), {name:'W', props:{id:{type:r.text()},
 *                                                   opt:{type:r.optional(r.text())}}});
 *   W.toValueSchema().safeParse({})   // FAILS: path ['id'] expected string
 *   W.parse({id:'i', opt:'o'}).raw    // {}      ← every field discarded
 *   W.valid({})                       // true    ← and the loss was blessed
 *   Object.keys(W.props())            // [... 'id', 'opt']  ← still advertised
 *
 * The schema told a model to emit `{id, opt}`; `parse` built that emission
 * into a value with nothing in it; `valid` called the result legal. Reading
 * either prop through the engine returned undefined.
 *
 * THE LINE. A local prop is SURFACE when something else computes it — a `get`
 * expression derives it from `this`, and a callable type carries its body in
 * `get`. Everything else is a field this type ADDS to its base, and the value
 * has to carry it. One predicate, consulted by `parse`, `valid`, `encode`,
 * `create`, `random` AND `toValueSchema`, so they cannot drift apart again.
 */

describe('a STORED local prop is data the value carries', () => {
  const r = createRegistry();
  const W = r.extend(r.obj({}), {
    name: 'W',
    props: { id: { type: r.text() }, opt: { type: r.optional(r.text()) } },
  });

  test('parse fills it', () => {
    // MEASURED BEFORE: `{}`.
    expect(W.parse({ id: 'i', opt: 'o' }).encodeLogical()).toEqual({ id: 'i', opt: 'o' });
  });

  test('valid requires it', () => {
    // MEASURED BEFORE: true.
    expect(W.valid(W.parse({ id: 'i', opt: 'o' }).raw)).toBe(true);
    expect(W.valid({})).toBe(false);
  });

  test('encode emits it, so the round trip keeps it', () => {
    const v = W.parse({ id: 'i', opt: 'o' });
    expect(W.parse(v.encodeLogical()).encodeLogical()).toEqual({ id: 'i', opt: 'o' });
  });

  test('toValueSchema still requires it — schema and parse now AGREE', () => {
    expect(W.toValueSchema().safeParse({}).success).toBe(false);
    expect(W.toValueSchema().safeParse({ id: 'i' }).success).toBe(true);
  });

  test('the prop reads back through the value', () => {
    const raw = W.parse({ id: 'i', opt: 'o' }).raw as Record<string, Value>;
    expect(raw.id).toBeInstanceOf(Value);
    expect(raw.id!.raw).toBe('i');
  });

  test('create() produces a value the type accepts — the sweep invariant', () => {
    expect(W.valid(W.parse(W.create()).raw)).toBe(true);
  });

  test('a stored local prop enforces its declared type', () => {
    expect(() => W.parse({ id: 5 })).toThrow();
  });

  test('an optional stored prop may be absent', () => {
    expect(W.valid(W.parse({ id: 'i' }).raw)).toBe(true);
  });
});

describe('a SURFACE local prop stays surface — no value carries a method', () => {
  const r = createRegistry();
  const res = r.extend(r.obj({ id: { type: r.text() } }), {
    name: 'Res',
    props: {
      url: { type: r.fn({ args: r.obj({}), returns: r.text() }) },
      derived: { type: r.text(), get: r.parseExpr({ kind: 'new', type: { name: 'text' }, value: 'x' }) },
    },
  });

  test('a METHOD is not required by the value schema', () => {
    // A `Resource` is supplied as a bare `{id}` handle and resolved
    // server-side. When its four methods rode local props the value schema
    // demanded `url`, `markdown`, `thumbnail` and `contentType` on every
    // handle — which no caller can supply and no value of the type carries.
    expect(res.toValueSchema().safeParse({ id: 'a' }).success).toBe(true);
  });

  test('a COMPUTED prop is not required either', () => {
    expect(res.valid(res.parse({ id: 'a' }).raw)).toBe(true);
  });

  test('...and neither shows up in the encoded value', () => {
    expect(res.parse({ id: 'a' }).encodeLogical()).toEqual({ id: 'a' });
  });

  test('both are still on the SURFACE — `props()` and the definition print them', () => {
    expect(Object.keys(res.props())).toEqual(expect.arrayContaining(['url', 'derived']));
    expect(res.toCodeDefinition()).toContain('url()');
  });
});

describe('the composition the product discovered by measurement still works', () => {
  const r = createRegistry();

  test('data on the BASE, methods in LOCAL props — unchanged', () => {
    const project = r.extend(r.obj({ id: { type: r.text() }, name: { type: r.text() } }), {
      name: 'project',
      props: { announce: { type: r.fn({ args: r.obj({ note: { type: r.text() } }), returns: r.text() }) } },
    });
    const v = project.parse({ id: 'p1', name: 'Apollo' });
    expect(v.encodeLogical()).toEqual({ id: 'p1', name: 'Apollo' });
    expect(project.valid(v.raw)).toBe(true);
    expect(project.toValueSchema().safeParse({ id: 'p1', name: 'Apollo' }).success).toBe(true);
  });

  test('an Extension over a NON-record base has nowhere to store one, and does not try', () => {
    const email = r.extend('text', { name: 'Email', options: { minLength: 3 } });
    expect(email.parse('a@b.c').raw).toBe('a@b.c');
    expect(email.valid('a@b.c')).toBe(true);
  });

  test('...and one DECLARED over a non-record base stays inhabitable', () => {
    // `parse` cannot create the slot on a string, so `valid` must not demand
    // it — otherwise the type would refuse the value its own `parse` just
    // produced and become uninhabitable. Every surface bails on the same
    // condition.
    const odd = r.extend('text', { name: 'Odd', props: { extra: { type: r.num() } } });
    const v = odd.parse('abc');
    expect(v.raw).toBe('abc');
    expect(odd.valid(v.raw)).toBe(true);
    expect(odd.toValueSchema().safeParse('abc').success).toBe(true);
    expect(odd.valid(odd.parse(odd.create()).raw)).toBe(true);
  });
});
