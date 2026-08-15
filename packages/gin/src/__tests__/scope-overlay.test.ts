/**
 * The scope OVERLAY — resolving a name WITHOUT claiming it.
 *
 * `Registry.parseInner`'s bare-name arm has always had two behaviours, and the
 * difference between them is a data-corruption story rather than a nuance:
 *
 *   a name bound in an overlay scope → `AliasType`, which re-serializes as
 *     `{name}` and delegates every value-side op to the target lazily;
 *   a name in `namedTypes` (`register`) → THE INSTANCE, whose `toJSON()`
 *     emits the full definition INLINE.
 *
 * A caller who wanted the first had no supported way to get it: `LocalScope`
 * and `TypeScope` were not exported, so `register` was the only door — and a
 * stored `{"name":"time"}` reference, re-serialized at an unrelated
 * read-modify-write after a boot had registered that name, came back out of the
 * database as an unrelated package's whole type definition. Wrong props, wrong
 * docs, no error at any layer.
 *
 * Second half: `toValueSchema` took no scope, unlike `valid` / `parse` /
 * `compatible` / `props`, so a signature naming a type the schema-building
 * registry does not hold produced a schema that accepts EVERY value — and
 * there was no parameter with which to fix it at the call site.
 */
import { describe, test, expect } from 'vitest';
import { createRegistry, LocalScope, type Type } from '../index';

/** The type a package contributes — the shape whose definition leaked. */
function timeType(r: ReturnType<typeof createRegistry>): Type {
  return r.extend(r.obj({ value: { type: r.num() }, unit: { type: r.text() } }), {
    name: 'time',
    docs: 'A time quantity — value + unit.',
  });
}

describe('registry.scope — an overlay above the registry', () => {
  test('the name resolves, and still round-trips AS A NAME', () => {
    const r = createRegistry();
    const session = r.scope({ time: timeType(r) });

    const ref = session.parse({ name: 'time' });
    expect(Object.keys(ref.props())).toEqual(expect.arrayContaining(['value', 'unit']));
    // The whole point: a reference stays a reference.
    expect(ref.toJSON()).toEqual({ name: 'time' });
  });

  test('the registry is NOT mutated — the overlay is the session, not the process', () => {
    const r = createRegistry();
    const session = r.scope({ time: timeType(r) });

    expect(session.lookup('time')).toBeDefined();
    expect(r.lookup('time')).toBeUndefined();
    expect(r.namedTypeList().map((t) => t.name)).not.toContain('time');
    // A second session sees nothing of the first.
    expect(r.scope().lookup('time')).toBeUndefined();
  });

  test('what `register` does instead — the second serialization that corrupted a row', () => {
    const r = createRegistry();
    r.register(timeType(r));

    // Same input def, same registry, one `register` apart.
    const inlined = r.parse({ name: 'time' }).toJSON();
    expect(inlined).not.toEqual({ name: 'time' });
    expect(inlined.extends).toBe('obj');
    expect(Object.keys(inlined.props ?? {})).toEqual(['value', 'unit']);
    // …which is exactly how a stored `{"name":"time"}` field came back out of a
    // read-modify-write carrying an unrelated package's definition.
    expect(r.scope({ time: timeType(r) })).toBeInstanceOf(LocalScope);
  });

  test('overlays layer, and an inner binding wins', () => {
    const r = createRegistry();
    const outer = r.scope({ T: r.num() });
    const inner = new LocalScope(outer, { T: r.text() });

    expect(outer.parse({ name: 'T' }).valid('x')).toBe(false);
    expect(inner.parse({ name: 'T' }).valid('x')).toBe(true);
    // Falls through for everything it does not bind.
    expect(inner.lookup('num')).toBeDefined();
    expect(inner.ownNames()).toEqual(['T']);
  });

  test('bindings can be added in dependency order after construction', () => {
    const r = createRegistry();
    const session = r.scope();
    session.bind('Id', r.text({ pattern: '^u-' }));
    session.bind('User', r.obj({ id: { type: session.parse({ name: 'Id' }) } }));

    const user = session.parse({ name: 'User' });
    expect(user.prop('id')?.type.valid('u-1')).toBe(true);
    expect(user.prop('id')?.type.valid('x-1')).toBe(false);
  });

  test('the overlay reaches nested slots, not just the top-level name', () => {
    const r = createRegistry();
    const session = r.scope({ time: timeType(r) });

    const listOfTime = session.parse({ name: 'list', generic: { V: { name: 'time' } } });
    expect(listOfTime.toJSON()).toEqual({ name: 'list', generic: { V: { name: 'time' } } });
    expect(listOfTime.toCode()).toContain('time');
  });
});

describe('toValueSchema(opts.scope)', () => {
  /** A stored signature that NAMES a type: the shape every fn argument gate is
   *  built from. Parsed in a registry that does not hold the name — which is
   *  the normal state of a bare revive registry. */
  const signature = () => {
    const r = createRegistry();
    return { r, args: r.parse({ name: 'obj', props: { at: { type: { name: 'time' } } } }) };
  };

  test('without a scope, an unbound name accepts EVERY value — the hole', () => {
    const { args } = signature();
    // Not a near miss: a string where an object was declared.
    expect(args.toValueSchema().safeParse({ at: 'nonsense' }).success).toBe(true);
  });

  test('with a scope, the same schema enforces the resolved type', () => {
    const { r, args } = signature();
    const session = r.scope({ time: timeType(r) });

    const schema = args.toValueSchema({ scope: session });
    expect(schema.safeParse({ at: 'nonsense' }).success).toBe(false);
    expect(schema.safeParse({ at: { value: 1, unit: 'h' } }).success).toBe(true);
    // Wrong shape THROUGH the resolved type, not merely wrong outer type.
    expect(schema.safeParse({ at: { value: 'soon', unit: 'h' } }).success).toBe(false);
  });

  test('the scope threads to every nested slot without each composite re-passing it', () => {
    const { r } = signature();
    const session = r.scope({ time: timeType(r) });
    // list<map<text, time>> — three composites deep, none of which knows about
    // the scope; it rides `opts`.
    const nested = r.parse({
      name: 'list',
      generic: { V: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'time' } } } },
    });

    const schema = nested.toValueSchema({ scope: session });
    expect(schema.safeParse([[{ key: 'a', value: { value: 1, unit: 'h' } }]]).success).toBe(true);
    expect(schema.safeParse([[{ key: 'a', value: 'nonsense' }]]).success).toBe(false);
    // …and without it, the same payload sails through.
    expect(nested.toValueSchema().safeParse([[{ key: 'a', value: 'nonsense' }]]).success).toBe(true);
  });

  test('a call-site scope beats the captured one, as it does for `valid` / `props`', () => {
    const r = createRegistry();
    const captured = r.scope({ T: r.num() });
    const alias = captured.parse({ name: 'T' });

    expect(alias.toValueSchema().safeParse(1).success).toBe(true);
    expect(alias.toValueSchema().safeParse('x').success).toBe(false);
    expect(alias.toValueSchema({ scope: r.scope({ T: r.text() }) }).safeParse('x').success).toBe(true);
  });
});
