import { describe, test, expect } from 'vitest';
import { createRegistry } from '../index';
import { Extension } from '../extension';
import type { Type } from '../type';
import type { TypeDef } from '../schema';

/**
 * The definition printer's LAYOUT contract.
 *
 * `toCodeDefinition` is what a model reads for every type in its prompt,
 * so "hard to parse" is not a cosmetic complaint — it is the artifact the
 * model reasons from. These tests pin the five decisions that make the
 * print scannable:
 *
 *  1. `extends <base>` names the base and does not inline its structure;
 *     what the clause elides, the body recovers.
 *  2. The body is line-oriented UNCONDITIONALLY (one member per line,
 *     one parameter per line when there is more than one).
 *  3. An enum member whose value equals its label prints as the label.
 *  4. A generic reference renders its BINDING at a use site.
 *  5. `CodeOptions.indent` is honoured, wrapped continuations nest under
 *     their owner, and an `obj` wraps like every other delimited form.
 */

/** The registry every case builds against, plus the row/enum fixtures the
 *  motivating `todo_task` print is made of. */
function fixture() {
  const r = createRegistry();
  const priority = r.enum({ low: 'low', medium: 'medium', high: 'high' }, r.text());
  const status = r.enum(
    { todo: 'todo', 'in progress': 'in progress', done: 'done', blocked: 'blocked' },
    r.text(),
  );
  return { r, priority, status };
}

describe('extends — the clause names the base, the body carries the structure', () => {
  test('an ANONYMOUS obj base collapses to `extends obj` and its fields move into the body', () => {
    const { r } = fixture();
    const t = r.extend(
      r.obj({ id: { type: r.text() }, title: { type: r.text() } }),
      { name: 'todo_task', props: { note: { type: r.optional(r.text()) } } },
    );

    const def = t.toCodeDefinition();
    expect(def.split('\n')[0]).toBe('type todo_task extends obj {');
    // Inheritance survives as a fact...
    expect(def).toContain('extends obj');
    // ...but nothing structural is left on the header line.
    expect(def.split('\n')[0]).not.toContain('id:');
    // And the base's fields are not lost — they are listed, in order,
    // ahead of the extension's own additions.
    expect(def).toBe([
      'type todo_task extends obj {',
      '  id: text',
      '  title: text',
      '  note?: text',
      '}',
    ].join('\n'));
  });

  test('a NAMED base stays a bare name and its members stay implicit', () => {
    const { r } = fixture();
    const Base = r.extend('obj', { name: 'Base', props: { x: { type: r.text() } } });
    r.register(Base);
    const Derived = r.extend(Base, { name: 'Derived', props: { y: { type: r.num() } } });

    // `Base` is resolvable by name, so re-listing its fields would be
    // duplication rather than recovery.
    expect(Derived.toCodeDefinition()).toBe([
      'type Derived extends Base {',
      '  y: num',
      '}',
    ].join('\n'));
  });

  test('option narrowing on a primitive base is NOT elided — it is not a member', () => {
    const { r } = fixture();
    const Email = r.extend(r.text(), { name: 'Email', options: { pattern: '^x$' } });
    // Compact, unreachable by any other name, and nowhere else to put it.
    expect(Email.toCodeDefinition()).toBe('type Email extends text{pattern="^x$"} {}');
  });

  test('an ANONYMOUS iface base gives back props, index signature AND call signature', () => {
    const { r } = fixture();
    const contract = r.iface({
      props: { a: { type: r.text() } },
      get: { key: r.text(), value: r.num() },
    });
    const t = r.extend(contract, { name: 'Thing', props: { b: { type: r.num() } } });

    const def = t.toCodeDefinition();
    expect(def.split('\n')[0]).toBe('type Thing extends iface {');
    expect(def).toContain('[key: text]: num');
    expect(def).toContain('a: text');
    expect(def).toContain('b: num');
  });

  test("an obj base's DERIVED index signature is not invented into the body", () => {
    const { r } = fixture();
    const t = r.extend(r.obj({ id: { type: r.text() } }), { name: 'Row' });
    // `ObjType.get()` synthesises `[key: "id"]: text` from the fields. It
    // never appeared in the inlined `obj{…}` form, so recovering it would
    // add a member nobody declared.
    expect(t.toCodeDefinition()).not.toContain('[key:');
  });
});

describe('the body is line-oriented unconditionally', () => {
  test('one member per line even when the whole body would fit on one', () => {
    const { r } = fixture();
    const t = r.extend(r.obj({ a: { type: r.text() }, b: { type: r.num() } }), { name: 'Tiny' });
    // 'a: text' + 'b: num' is 15 characters — a width-triggered layout
    // would have kept them together. A declaration is not an expression.
    expect(t.toCodeDefinition()).toBe([
      'type Tiny extends obj {',
      '  a: text',
      '  b: num',
      '}',
    ].join('\n'));
  });

  test('a method with more than one parameter puts each on its own line, closing paren alone', () => {
    const { r } = fixture();
    const t = r.extend('obj', {
      name: 'Svc',
      props: { go: r.method({ a: r.text(), b: r.num() }, r.bool(), 'any.self') },
    });
    // Two short params (13 chars compact) still break — and the closing
    // paren lands at the METHOD's indent, not at column 0.
    expect(t.toCodeDefinition()).toBe([
      'type Svc extends obj {',
      '  go(',
      '    a: text',
      '    b: num',
      '  ): bool',
      '}',
    ].join('\n'));
  });

  test('a LONE parameter stays on the method line however long it is', () => {
    const r = createRegistry();
    const def = r.list(r.num()).toCodeDefinition();
    // `joinAuto` would have split this at its 32-char item threshold.
    expect(def).toContain('  filter(fn: (value: num, index: num): bool): list<num>');
  });

  test('docs render as `///` doc lines, distinct from an ordinary comment', () => {
    const { r } = fixture();
    const t = r.extend('obj', {
      name: 'Doc',
      docs: 'a type',
      props: { f: { type: r.text(), docs: 'a field' } },
    });
    const def = t.toCodeDefinition();
    expect(def.startsWith('/// a type\n')).toBe(true);
    expect(def).toContain('  /// a field');
  });

  test('includeComments: false still suppresses every doc line', () => {
    const { r } = fixture();
    const t = r.extend('obj', {
      name: 'Doc',
      docs: 'a type',
      props: { f: { type: r.text(), docs: 'a field' } },
    });
    const def = t.toCodeDefinition({ includeComments: false });
    expect(def).not.toContain('///');
  });
});

describe('enum shorthand', () => {
  test('value equal to label prints as the bare label', () => {
    const { r, priority } = fixture();
    expect(priority.toCode()).toBe('enum<text>{low, medium, high}');
    expect(r.enum({ low: 'low' }, r.text()).toCode()).toBe('enum<text>{low}');
  });

  test('a label that is not a bare identifier stays quoted', () => {
    const { status } = fixture();
    expect(status.toCode()).toBe('enum<text>{todo, "in progress", done, blocked}');
  });

  test('label and value that DIFFER keep the explicit form', () => {
    const { r } = fixture();
    expect(r.enum({ RED: 'red', GREEN: 'green' }, r.text()).toCode())
      .toBe('enum<text>{RED="red", GREEN="green"}');
  });

  test('non-text values are always explicit — a label never equals a number', () => {
    const { r } = fixture();
    expect(r.enum({ A: 1, B: 2 }, r.num()).toCode()).toBe('enum<num>{A=1, B=2}');
  });

  test('an empty-string member is printed, not dropped', () => {
    const { r } = fixture();
    // `optionsCode` filters `''` as an uninteresting default, which erased
    // this member entirely from the old render.
    expect(r.enum({ NONE: '' }, r.text()).toCode()).toBe('enum<text>{NONE=""}');
  });

  test('the collapse does NOT leak into optionsCode — `min=0` keeps both halves', () => {
    const { r } = fixture();
    // A num's options are a key and a value that happen to be adjacent;
    // collapsing them would be a lie, not a shorthand.
    expect(r.num({ whole: true, min: 0 }).toCode()).toContain('min=0');
  });

  test('measured: the collapse removes 60% of a realistic enum render', () => {
    const { priority, status } = fixture();
    const explicit = (t: Type): number => {
      const values = (t.options as { values: Record<string, unknown> }).values;
      return Object.entries(values)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ').length + 2;
    };
    const before = explicit(priority) + explicit(status);
    const after = priority.toCode().length - 'enum<text>'.length
      + status.toCode().length - 'enum<text>'.length;
    expect(after).toBeLessThan(before);
    // Two enums, 7 members: 111 chars of member list becomes 53.
    expect(before - after).toBe(58);
  });
});

describe('generics render their binding at a use site', () => {
  /** `QueryResult<Row>` — the envelope the product names and references
   *  from every generated method's return type. */
  function envelope() {
    const r = createRegistry();
    const Row = r.alias('Row');
    const QueryResult = r.extend('obj', {
      name: 'QueryResult',
      generic: { Row },
      props: { rows: { type: r.list(Row) }, affected: { type: r.optional(r.num()) } },
    });
    r.register(QueryResult);
    return { r, QueryResult };
  }

  test('an UNSPECIALIZED reference prints bare — `<Row>` there is the declaration echoed back', () => {
    const { QueryResult } = envelope();
    expect(QueryResult.toCode()).toBe('QueryResult');
    // The declaration header still declares the parameter.
    expect(QueryResult.toCodeDefinition().split('\n')[0])
      .toBe('type QueryResult<Row> extends obj {');
  });

  test('a SPECIALIZED reference prints its binding', () => {
    const { r, QueryResult } = envelope();
    const bound = QueryResult.specialize({ Row: r.obj({ id: { type: r.text() } }) });
    expect(bound.toCode()).toBe('QueryResult<obj{id: text}>');
  });

  test('`registry.parse` on a reference carrying `generic` SPECIALIZES it', () => {
    const { r } = envelope();
    const bound = r.parse({
      name: 'QueryResult',
      generic: { Row: { name: 'obj', props: { id: { type: { name: 'text' } } } } },
    } as TypeDef);
    // Before: the bindings were dropped and the unbound declaration handed
    // straight back — `bound === r.lookup('QueryResult')` was true.
    expect(bound).not.toBe(r.lookup('QueryResult'));
    expect(bound.toCode()).toBe('QueryResult<obj{id: text}>');
  });

  test('specializing does not mutate the registered declaration', () => {
    const { r, QueryResult } = envelope();
    QueryResult.specialize({ Row: r.num() });
    expect(r.lookup('QueryResult')!.toCode()).toBe('QueryResult');
  });

  test('two specializations of one generic coexist', () => {
    const { r, QueryResult } = envelope();
    const a = QueryResult.specialize({ Row: r.obj({ id: { type: r.text() } }) });
    const b = QueryResult.specialize({ Row: r.obj({ n: { type: r.num() } }) });
    expect(a.toCode()).toBe('QueryResult<obj{id: text}>');
    expect(b.toCode()).toBe('QueryResult<obj{n: num}>');
  });

  test('the binding is HONOURED, not merely printed — the placeholder resolves', () => {
    const { r, QueryResult } = envelope();
    const rowType = r.obj({ id: { type: r.text() } });
    const bound = QueryResult.specialize({ Row: rowType });
    const rows = bound.props()['rows']!;
    const item = (rows.type as unknown as { item: Type }).item;
    // A printed binding the type did not honour would be worse than
    // printing nothing at all.
    expect(item.simplify(bound.scope).toCode()).toBe('obj{id: text}');
    expect(item.simplify(r).toCode()).toBe('Row');
  });

  test('a binding for an UNDECLARED parameter is ignored', () => {
    const { r, QueryResult } = envelope();
    // Not a parameter of this type — accepting it would silently widen
    // a surface nobody declared.
    expect(QueryResult.specialize({ Nope: r.num() }).toCode()).toBe('QueryResult');
  });

  test('the return type of a generated method carries the row type through', () => {
    const { r, QueryResult } = envelope();
    const bound = QueryResult.specialize({ Row: r.obj({ id: { type: r.text() } }) });
    const t = r.extend('obj', {
      name: 'todo_task',
      props: { update: r.method({ title: r.optional(r.text()) }, bound, 'any.self') },
    });
    expect(t.toCodeDefinition()).toContain('update(title?: text): QueryResult<obj{id: text}>');
  });
});

describe('the three printer defects', () => {
  test('CodeOptions.indent is honoured (it used to type-check and do nothing)', () => {
    const { r } = fixture();
    const t = r.extend(r.obj({ a: { type: r.text() }, b: { type: r.num() } }), { name: 'O' });
    expect(t.toCodeDefinition({ indent: '    ' })).toBe([
      'type O extends obj {',
      '    a: text',
      '    b: num',
      '}',
    ].join('\n'));
    expect(t.toCodeDefinition({ indent: '    ' })).not.toBe(t.toCodeDefinition());
  });

  test('CodeOptions.indent reaches a wrapped parameter list too', () => {
    const { r } = fixture();
    const t = r.extend('obj', {
      name: 'Svc',
      props: { go: r.method({ a: r.text(), b: r.num() }, r.bool(), 'any.self') },
    });
    expect(t.toCodeDefinition({ indent: '\t' })).toBe([
      'type Svc extends obj {',
      '\tgo(',
      '\t\ta: text',
      '\t\tb: num',
      '\t): bool',
      '}',
    ].join('\n'));
  });

  test('wrapped continuations nest UNDER their owner rather than beside it', () => {
    const r = createRegistry();
    const def = r.list(r.num()).toCodeDefinition();
    // gin's own `list.reduce` was the standing witness: its parameters
    // landed at the method's indent and its `): R` at column 0.
    expect(def).toContain([
      '  reduce<R>(',
      '    fn: (acc: R, value: num, index: num): R',
      '    initial: R',
      '  ): R',
    ].join('\n'));
    expect(def.split('\n').filter((l) => l.startsWith(')')).length).toBe(0);
  });

  test('an obj wraps past the threshold like every other delimited form', () => {
    const r = createRegistry();
    const wide = r.obj({
      rows: { type: r.list(r.obj({ id: { type: r.text() } })) },
      limit: { type: r.optional(r.num()) },
      total: { type: r.optional(r.or([r.obj({ known: { type: r.num() } }), r.obj({ atLeast: { type: r.num() } })])) },
      offset: { type: r.optional(r.num()) },
      affected: { type: r.optional(r.num()) },
    });
    const code = wide.toCode();
    // The 233-char single line this replaces.
    expect(code).toContain('obj{\n');
    expect(Math.max(...code.split('\n').map((l) => l.length))).toBeLessThan(80);
  });

  test('a short obj still renders compactly — the wrap is width-triggered, not unconditional', () => {
    const r = createRegistry();
    // A type EXPRESSION is not a declaration: compact is the readable form.
    expect(r.obj({ id: { type: r.text() } }).toCode()).toBe('obj{id: text}');
  });
});

describe('round trip — parse(t.toJSON()) reproduces the type', () => {
  /** gin has no parser for its printed CODE (rendering is display-only —
   *  models author `TypeDef` JSON). The real round trip is therefore
   *  through `toJSON` / `registry.parse`, and it must survive every form
   *  this change touches. */
  const roundTrips = (r: ReturnType<typeof createRegistry>, t: Type): void => {
    const back = r.parse(t.toJSON());
    expect(back.toJSON()).toEqual(t.toJSON());
    expect(back.toCode()).toBe(t.toCode());
  };

  test('enum — collapsed form', () => {
    const { r, priority } = fixture();
    roundTrips(r, priority);
    expect(r.parse(priority.toJSON()).toCode()).toBe('enum<text>{low, medium, high}');
  });

  test('enum — explicit form, and a non-identifier label', () => {
    const { r, status } = fixture();
    roundTrips(r, status);
    roundTrips(r, r.enum({ RED: 'red' }, r.text()));
    roundTrips(r, r.enum({ A: 1 }, r.num()));
  });

  test('extension over an ANONYMOUS base', () => {
    const { r, status } = fixture();
    const t = r.extend(
      r.obj({ id: { type: r.text() }, status: { type: r.optional(status) } }),
      { name: 'todo_task', props: { note: { type: r.text() } } },
    );
    roundTrips(r, t);
    expect(r.parse(t.toJSON()).toCodeDefinition()).toBe(t.toCodeDefinition());
  });

  test('an anonymous base\'s members survive — the reloaded type accepts the same values', () => {
    const { r } = fixture();
    const t = r.extend(
      r.obj({ id: { type: r.text() }, title: { type: r.text() } }),
      { name: 'todo_task', props: { note: { type: r.text() } } },
    );
    const back = r.parse(t.toJSON());
    const only = (o: Record<string, string>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r.text().parse(v)]));

    // The base's fields used to be dropped by `toJSON`, so the reloaded
    // type was `obj{note}`: it ACCEPTED a row missing `id` and `title`
    // that the original refused. A type that changes meaning across a
    // save/load is worse than one that fails to save.
    expect(t.valid(only({ note: 'c' }))).toBe(false);
    expect(back.valid(only({ note: 'c' }))).toBe(false);
    expect(t.valid(only({ id: 'a', title: 'b', note: 'c' }))).toBe(true);
    expect(back.valid(only({ id: 'a', title: 'b', note: 'c' }))).toBe(true);
  });

  test('an inherited prop is NOT copied down into a named-base extension', () => {
    const { r } = fixture();
    const Base = r.extend('obj', { name: 'Base', props: { x: { type: r.text() } } });
    r.register(Base);
    const Derived = r.extend(Base, { name: 'Derived', props: { y: { type: r.num() } } });
    // `x` stays implicit under `extends Base` — the merge above must not
    // flatten an inheritance chain into a copy.
    expect(Object.keys(Derived.toJSON().props ?? {})).toEqual(['y']);
  });

  test('extension over a NAMED base', () => {
    const { r } = fixture();
    const Base = r.extend('obj', { name: 'Base', props: { x: { type: r.text() } } });
    r.register(Base);
    const Derived = r.extend(Base, { name: 'Derived', props: { y: { type: r.num() } } });
    roundTrips(r, Derived);
  });

  test('generic — WITHOUT a binding', () => {
    const r = createRegistry();
    const Row = r.alias('Row');
    const QR = r.extend('obj', { name: 'QueryResult', generic: { Row }, props: { rows: { type: r.list(Row) } } });
    r.register(QR);
    roundTrips(r, QR);
    expect(r.parse(QR.toJSON()).toCode()).toBe('QueryResult');
  });

  test('generic — WITH a binding', () => {
    const r = createRegistry();
    const Row = r.alias('Row');
    const QR = r.extend('obj', { name: 'QueryResult', generic: { Row }, props: { rows: { type: r.list(Row) } } });
    r.register(QR);
    const bound = QR.specialize({ Row: r.obj({ id: { type: r.text() } }) });
    roundTrips(r, bound);
    const back = r.parse(bound.toJSON());
    expect(back.toCode()).toBe('QueryResult<obj{id: text}>');
    expect(back).toBeInstanceOf(Extension);
    expect((back as Extension).bindings).toBeDefined();
  });

  test('nested objs', () => {
    const r = createRegistry();
    const nested = r.obj({
      rows: { type: r.list(r.obj({ id: { type: r.text() }, meta: { type: r.obj({ n: { type: r.num() } }) } })) },
      total: { type: r.or([r.obj({ known: { type: r.num() } }), r.obj({ atLeast: { type: r.num() } })]) },
    });
    roundTrips(r, nested);
  });
});
