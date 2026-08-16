import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';
import { Value } from '../value';
import type { ExprDef } from '../schema';

/**
 * A named generic envelope — `HttpResponse<T>`, `QueryResult<Row>` — read
 * through a PATH.
 *
 * Everything about specialization worked except the one thing it exists for:
 *
 *   bound.toCode()                                 'HttpResponse<obj{USD: num, EUR: num}>'   ok
 *   r.parse(bound.toJSON()).toCode()               same — survives the round trip            ok
 *   bound.props()['data'].type.simplify(scope)     'obj{USD: num, EUR: num}'                 ok
 *   e.typeOf({get: res.data}, {res: bound})        'T'      ← an unresolved AliasType        BROKEN
 *   e.typeOf({get: res.data.USD}, {res: bound})    'any'
 *   e.validate({get: res.data.USD}, {res: bound})  ["prop.unknown — no prop 'USD' on type 'alias'"]
 *
 * TWO independent misses, and the second is the general one.
 *
 * (a) THE DECLARED SIDE. A generic's props are declared against its type
 *     PARAMETERS, so `props()['data'].type` is still `AliasType('T')`. The
 *     binding is not lost — `specialize` layers a `LocalScope` over the
 *     instance's own scope, and `valid`/`parse`/`encode` all route through it
 *     — but the path walk had nowhere to receive it and used the alias as-is.
 *
 * (b) THE VALUE SIDE, which no flattening can fix. At run time the `Value`
 *     under `data` holds `{USD: Value(num, 1.1), …}`: the concrete type of
 *     every slot is sitting in the raw, one dereference away, and the walk
 *     consulted only `dv.type`. A `Value` whose declared type is an
 *     unresolved placeholder but whose raw holds typed cells is not an error
 *     — it is a value carrying MORE information than its declaration.
 */

const envelopeRegistry = () => {
  const r = createRegistry();
  const envelope = r.extend(r.obj({}), {
    name: 'HttpResponse',
    generic: { T: r.alias('T') },
    props: { status: { type: r.num() }, data: { type: r.alias('T') } },
  });
  r.register(envelope);
  const rates = r.obj({ USD: { type: r.num() }, EUR: { type: r.num() } });
  return { r, e: new Engine(r), envelope, rates, bound: envelope.specialize({ T: rates }) };
};

const GET_DATA = { kind: 'get', path: [{ prop: 'res' }, { prop: 'data' }] } as ExprDef;
const GET_USD = { kind: 'get', path: [{ prop: 'res' }, { prop: 'data' }, { prop: 'USD' }] } as ExprDef;

describe('the path walk resolves a specialization through the receiver', () => {
  test('the control the defect was measured against still holds', () => {
    const { bound } = envelopeRegistry();
    expect(bound.toCode()).toBe('HttpResponse<obj{USD: num, EUR: num}>');
  });

  test('typeOf follows the binding into the prop', () => {
    const { e, bound } = envelopeRegistry();
    // MEASURED BEFORE: 'T'.
    expect(e.typeOf(GET_DATA, new Map([['res', bound]])).toCode()).toBe('obj{USD: num, EUR: num}');
  });

  test('...and one step further, into the bound type\'s own field', () => {
    const { e, bound } = envelopeRegistry();
    // MEASURED BEFORE: 'any'.
    expect(e.typeOf(GET_USD, new Map([['res', bound]])).toCode()).toBe('num');
  });

  test('validate reports nothing — it used to refuse the whole path', () => {
    const { e, bound } = envelopeRegistry();
    // MEASURED BEFORE: ["prop.unknown — no prop 'USD' on type 'alias'"].
    expect(e.validate(GET_USD, new Map([['res', bound]])).list).toEqual([]);
  });

  test('run reads the value, with the concrete type', async () => {
    const { e, bound } = envelopeRegistry();
    const rv = bound.parse({ status: 200, data: { USD: 1.1, EUR: 0.9 } });
    const out = await e.run(GET_USD, { res: rv });
    expect(out.raw).toBe(1.1);
    expect(out.type.name).toBe('num');
  });

  test('an UNSPECIALIZED generic still reads as its placeholder — nothing was invented', () => {
    const { e, envelope } = envelopeRegistry();
    // No binding exists, so there is nothing to resolve to and the alias
    // stands. The fix reads the receiver's bindings; it does not guess.
    expect(e.typeOf(GET_DATA, new Map([['res', envelope]])).toCode()).toBe('T');
  });

  test('a specialization does not leak between two instances of one generic', () => {
    const { r, e, envelope } = envelopeRegistry();
    const a = envelope.specialize({ T: r.text() });
    const b = envelope.specialize({ T: r.num() });
    expect(e.typeOf(GET_DATA, new Map([['res', a]])).toCode()).toBe('text');
    expect(e.typeOf(GET_DATA, new Map([['res', b]])).toCode()).toBe('num');
  });
});

describe('the runtime falls back to the type the VALUE carries', () => {
  test('a slot reachable only through the raw is still readable', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    // A value whose DECLARED type cannot answer for `USD`, but whose raw
    // holds a typed cell there. The declaration gets first refusal; the value
    // answers only when the declaration cannot.
    const opaque = new Value(r.any(), { USD: new Value(r.num(), 1.1) });
    const out = await e.run({ kind: 'get', path: [{ prop: 'res' }, { prop: 'USD' }] } as ExprDef, { res: opaque });
    expect(out.raw).toBe(1.1);
    expect(out.type.name).toBe('num');
  });

  test('a genuinely absent prop is still an error, with the same message', async () => {
    const r = createRegistry();
    const e = new Engine(r);
    const v = r.obj({ a: { type: r.text() } }).parse({ a: 'x' });
    await expect(e.run({ kind: 'get', path: [{ prop: 'o' }, { prop: 'nope' }] } as ExprDef, { o: v }))
      .rejects.toThrow(/no prop 'nope' on type 'obj'/);
  });

  test('the DECLARATION wins where it has an opinion', async () => {
    // The fallback is consulted only after `type.prop()` has failed, so a
    // declared prop with a `get` expression is not bypassed by a same-named
    // slot in the raw.
    const r = createRegistry();
    const e = new Engine(r);
    const t = r.obj({ a: { type: r.text() } });
    const v = t.parse({ a: 'declared' });
    const out = await e.run({ kind: 'get', path: [{ prop: 'o' }, { prop: 'a' }] } as ExprDef, { o: v });
    expect(out.raw).toBe('declared');
  });
});
