import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';

/**
 * End-to-end integration: build a Person type whose fullName is a method
 * using a template expression, register it, instantiate, set the names,
 * and read fullName back out.
 *
 * TypeDef:
 *   Person = {
 *     firstName: string,
 *     lastName:  string,
 *     fullName:  () => string   // body is a template expr over `this`
 *   }
 */

describe('Person.fullName integration', () => {
  test('register Person, new it, set fields, invoke fullName via template', async () => {
    const r = createRegistry();

    // Person: extends an empty-object base with three props. `fullName` is a
    // method whose body is a template interpolating this.firstName/lastName.
    const Person = r.extend(r.obj({
      firstName: { type: r.text() },
      lastName:  { type: r.text() },
    }), {
      name: 'Person',
      props: {
        fullName: {
          type: r.fn(r.obj({}), r.text()),
          get: {
            kind: 'template',
            template: { kind: 'new', type: { name: 'text' }, value: '{first} {last}' },
            params: {
              kind: 'new',
              type: { name: 'object', props: {
                first: { type: { name: 'text' } },
                last:  { type: { name: 'text' } },
              } },
              value: {
                first: { kind: 'get', path: [{ prop: 'this' }, { prop: 'firstName' }] },
                last:  { kind: 'get', path: [{ prop: 'this' }, { prop: 'lastName' }] },
              },
            },
          },
        },
      },
    });
    r.register(Person);

    const e = new Engine(r);

    // Program:
    //   define p = new Person {firstName: '', lastName: ''};
    //   p["firstName"] = 'Ada';
    //   p["lastName"]  = 'Lovelace';
    //   return p.fullName({});
    const program = {
      kind: 'define',
      vars: [{
        name: 'p',
        value: {
          kind: 'new',
          type: { name: 'Person' },
          value: { firstName: '', lastName: '' },
        },
      }],
      body: {
        kind: 'block',
        lines: [
          {
            kind: 'set',
            path: [{ prop: 'p' }, { key: { kind: 'new', type: { name: 'text' }, value: 'firstName' } }],
            value: { kind: 'new', type: { name: 'text' }, value: 'Ada' },
          },
          {
            kind: 'set',
            path: [{ prop: 'p' }, { key: { kind: 'new', type: { name: 'text' }, value: 'lastName' } }],
            value: { kind: 'new', type: { name: 'text' }, value: 'Lovelace' },
          },
          {
            kind: 'get',
            path: [{ prop: 'p' }, { prop: 'fullName' }, { args: {} }],
          },
        ],
      },
    } as const;

    const result = await e.run(program);
    expect(result.raw).toBe('Ada Lovelace');
    expect(result.type.name).toBe('text');
  });

  test('validate + toCode of the Person program', async () => {
    const r = createRegistry();
    const Person = r.extend(r.obj({
      firstName: { type: r.text() },
      lastName:  { type: r.text() },
    }), {
      name: 'Person',
      props: {
        fullName: {
          type: r.fn(r.obj({}), r.text()),
          get: {
            kind: 'template',
            template: { kind: 'new', type: { name: 'text' }, value: '{first} {last}' },
            params: {
              kind: 'new',
              type: { name: 'object', props: {
                first: { type: { name: 'text' } },
                last:  { type: { name: 'text' } },
              } },
              value: {
                first: { kind: 'get', path: [{ prop: 'this' }, { prop: 'firstName' }] },
                last:  { kind: 'get', path: [{ prop: 'this' }, { prop: 'lastName' }] },
              },
            },
          },
        },
      },
    });
    r.register(Person);
    const e = new Engine(r);

    const program = {
      kind: 'get',
      path: [
        { prop: 'p' }, { prop: 'fullName' }, { args: {} },
      ],
    } as const;

    const code = e.toCode(program);
    expect(code).toBe('p.fullName({})');

    // typeOf on the method call should resolve to text via the Fn's returns.
    // (Requires a scope with p: Person; validate helps here.)
  });
});
