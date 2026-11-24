/**
 * Gin fixtures shared by the gin and ginny corpus tests: gin's own test
 * registries and programs (person.test.ts, build-schemas-named.test.ts,
 * new-strict-schema.test.ts, code-render-demo.test.ts), plus TypeDefs a
 * model writes. Runtime-only use of `@aeye/gin` (its Registry type).
 */
import { createRegistry, type Registry } from '@aeye/gin';
import type { GinRegistryLike, GinTypeDef } from '../../index';
import type { ExprDefT, NewExprT, TypeDefT } from './gin-grammar';

/** A gin Registry as the dynamic step reads it; version = what gin's keptLazy keys by (counts). */
export const asGrammarRegistry = (r: Registry): GinRegistryLike => ({
  version: r.namedTypeList().length,
  named: () => new Map(r.namedTypeList().map((t) => [t.name, t.toJSON() as GinTypeDef])),
});

/** person.test.ts:20 Person, build-schemas-named.test.ts:12 Task, new-strict-schema.test.ts:24 Pair. */
export function fixtureRegistry(): Registry {
  const r = createRegistry();
  r.register(r.extend(r.obj({ firstName: { type: r.text() }, lastName: { type: r.text() } }), {
    name: 'Person',
    props: {
      fullName: {
        type: r.fn({ args: r.obj({}), returns: r.text() }),
        get: {
          kind: 'template',
          template: { kind: 'new', type: { name: 'text' }, value: '{first} {last}' },
          params: {
            kind: 'new',
            type: { name: 'obj', props: { first: { type: { name: 'text' } }, last: { type: { name: 'text' } } } },
            value: {
              first: { kind: 'get', path: [{ prop: 'this' }, { prop: 'firstName' }] },
              last: { kind: 'get', path: [{ prop: 'this' }, { prop: 'lastName' }] },
            },
          },
        },
      },
    },
  } as never));
  r.register(r.extend('obj', { name: 'Task', docs: 'a work item', props: { title: { type: r.text({ minLength: 1 }), docs: 'short summary' }, done: { type: r.bool() } } }));
  r.register(r.extend(r.tuple([r.text(), r.num()]), { name: 'Pair', docs: 'a (label, value) pair' }));
  return r;
}

/** A `new` of a builtin with a raw value (the common leaf of gin's fixtures). */
export const t = (name: string, value?: unknown): NewExprT => (value === undefined ? { kind: 'new', type: { name } } : { kind: 'new', type: { name }, value });

/** person.test.ts:55 — define p = new Person; p["firstName"] = 'Ada'; ...; p.fullName({}). */
export const personProgram = {
  kind: 'define',
  vars: [{ name: 'p', value: { kind: 'new', type: { name: 'Person' }, value: { firstName: '', lastName: '' } } }],
  body: {
    kind: 'block',
    lines: [
      { kind: 'set', path: [{ prop: 'p' }, { key: t('text', 'firstName') }], value: t('text', 'Ada') },
      { kind: 'set', path: [{ prop: 'p' }, { key: t('text', 'lastName') }], value: t('text', 'Lovelace') },
      { kind: 'get', path: [{ prop: 'p' }, { prop: 'fullName' }, { args: {} }] },
    ],
  },
} satisfies ExprDefT;

/** code-render-demo.test.ts:106 — switch with a flow (return) body. */
export const switchProgram = {
  kind: 'switch',
  value: { kind: 'get', path: [{ prop: 'x' }] },
  cases: [{ equals: [t('num', 1)], body: { kind: 'flow', action: 'return', value: t('num', 99) } }],
  else: t('num', 0),
} satisfies ExprDefT;

/** code-render-demo.test.ts:181 — template with scope fallback. */
export const templateProgram = {
  kind: 'block',
  lines: [
    { kind: 'define', vars: [{ name: 'host', value: t('text', 'api.example.com') }], body: { kind: 'new', type: { name: 'void' } } },
    { kind: 'template', template: t('text', 'https://{host}/v1') },
  ],
} satisfies ExprDefT;

/** code-render-demo.test.ts:194 — loop over a list. */
export const loopProgram = {
  kind: 'loop',
  over: { kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2, 3] },
  body: { kind: 'flow', action: 'continue' },
} satisfies ExprDefT;

/** code-render-demo.test.ts:204 — lambda with a call step. */
export const lambdaProgram = {
  kind: 'lambda',
  type: { name: 'fn', call: { args: { name: 'obj', props: { x: { type: { name: 'num' } } } }, returns: { name: 'num' } } },
  body: { kind: 'get', path: [{ prop: 'args' }, { prop: 'x' }, { prop: 'mul' }, { args: { other: t('num', 2) } }] },
} satisfies ExprDefT;

/** Every other field the grammar has, in one program: if/else, comments, loop parallel + key/value names,
 *  a call step with generic + catch, flow throw with error, native, lambda constraint, typed define var,
 *  a string template with params, and every TypeDef class inside `new`/`define`. */
export const everythingProgram = {
  kind: 'block',
  comment: 'fetch every page, at most 4 at a time',
  lines: [
    {
      kind: 'define',
      vars: [
        { name: 'urls', type: { name: 'list', generic: { V: { name: 'text', options: { pattern: '^https://' } } }, options: { maxLength: 10 } }, value: t('list', [t('text', 'https://a.dev')]) },
        { name: 'byId', value: { kind: 'new', type: { name: 'map', generic: { K: { name: 'num' }, V: { name: 'Task' } } }, value: [] } },
        { name: 'cfg', value: { kind: 'new', type: { name: 'obj', props: { host: { type: { name: 'text' }, docs: 'Host name.' }, port: { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true, min: 1, max: 65535 } } } } } } }, value: { host: 'x' } } },
      ],
      body: {
        kind: 'loop',
        comment: 'fan out',
        over: { kind: 'get', path: [{ prop: 'urls' }] },
        key: 'i',
        value: 'url',
        parallel: { concurrent: t('num', 4), rate: t('duration', { ms: 250 }) },
        body: {
          kind: 'if',
          ifs: [{
            condition: { kind: 'get', path: [{ prop: 'url' }, { prop: 'startsWith' }, { args: { prefix: t('text', 'https://') } }] },
            body: {
              kind: 'get',
              path: [
                { prop: 'fns' }, { prop: 'fetch' },
                { args: { url: { kind: 'get', path: [{ prop: 'url' }] } }, generic: { R: { name: 'text' } }, catch: { kind: 'flow', action: 'throw', error: t('text', 'fetch failed') } },
              ],
            },
          }],
          else: { kind: 'flow', action: 'continue' },
        },
      },
    },
    { kind: 'native', id: 'list.push', type: { name: 'void' } },
    { kind: 'template', template: 'Got {n} pages', params: { kind: 'new', type: { name: 'obj', props: { n: { type: { name: 'num' } } } }, value: { n: 1 } } },
    {
      kind: 'lambda',
      comment: 'positive only',
      type: { name: 'fn', call: { args: { name: 'obj', props: { n: { type: { name: 'num', options: { min: 1 } } } } }, returns: { name: 'num' } } },
      constraint: { kind: 'get', path: [{ prop: 'args' }, { prop: 'n' }, { prop: 'gt' }, { args: { other: t('num', 0) } }] },
      body: { kind: 'get', path: [{ prop: 'args' }, { prop: 'n' }] },
    },
    { kind: 'new', type: { name: 'tuple', options: { elements: [{ name: 'text' }, { name: 'num' }] } }, value: ['a', 1] },
    { kind: 'new', type: { name: 'enum', options: { values: { LOW: 'low', HIGH: 'high' } } }, value: 'low' },
    { kind: 'new', type: { name: 'or', options: { types: [{ name: 'text' }, { name: 'null' }] } }, value: null },
    { kind: 'new', type: { name: 'typ', generic: { T: { name: 'obj' } } }, value: { name: 'obj', props: {} } },
    { kind: 'new', type: { name: 'timestamp', options: { utc: true, precision: 'ms' } }, value: '2024-01-15T10:30:00Z' },
    { kind: 'new', type: { name: 'color', options: { hasAlpha: true } }, value: { r: 255, g: 0, b: 0 } },
    { kind: 'flow', action: 'exit', value: t('bool', true) },
  ],
} satisfies ExprDefT;

export const PROGRAMS = { personProgram, switchProgram, templateProgram, loopProgram, lambdaProgram, everythingProgram } as const;

/** TypeDefs a model writes (architect create[], edit_type def, designer args/returns). */
export const TYPEDEFS = {
  taskRef: { name: 'Task' },
  listOfTasks: { name: 'list', generic: { V: { name: 'Task' } } },
  // An Extension declared inline (schemas.ts:166): a new named type on obj, with every optional field.
  invoice: {
    name: 'billing/Invoice',
    extends: 'obj',
    docs: 'An invoice.',
    satisfies: ['Printable'],
    generic: { C: { name: 'text' } },
    options: { strict: true },
    props: {
      total: { type: { name: 'num', options: { min: 0 } }, docs: 'Total in cents.' },
      lines: { type: { name: 'list', generic: { V: { name: 'Pair' } } } },
      paid: { type: { name: 'bool' }, default: t('bool', false) },
    },
    get: { key: { name: 'num' }, value: { name: 'Pair' }, loopDynamic: false },
    call: { args: { name: 'obj' }, returns: { name: 'text' } },
    init: { args: { name: 'obj', props: { total: { type: { name: 'num' } } } }, run: { kind: 'get', path: [{ prop: 'args' }] } },
    constraint: { kind: 'get', path: [{ prop: 'this' }, { prop: 'total' }, { prop: 'gte' }, { args: { other: t('num', 0) } }] },
  },
  iface: {
    name: 'interface',
    props: { id: { type: { name: 'num' } } },
    get: { key: { name: 'text' }, value: { name: 'any' } },
    call: { args: { name: 'obj' }, returns: { name: 'void' } },
  },
  fnSig: {
    name: 'fn',
    call: {
      docs: 'Prime factors.',
      types: { positiveInt: { name: 'num', options: { whole: true, min: 1 } } },
      args: { name: 'obj', props: { n: { type: { name: 'positiveInt' } } } },
      returns: { name: 'list', generic: { V: { name: 'positiveInt' } } },
      throws: { name: 'text' },
    },
  },
  combos: {
    name: 'and',
    options: { types: [
      { name: 'obj', props: { id: { type: { name: 'num' } } } },
      { name: 'not', options: { excluded: { name: 'null' } } },
      { name: 'literal', options: { value: 3 } },
      { name: 'nullable', generic: { T: { name: 'date', options: { min: '2020-01-01' } } } },
      { name: 'map', generic: { K: { name: 'text' }, V: { name: 'color' } } },
      { name: 'enum', generic: { V: { name: 'num' } }, options: { values: { ONE: 1 } } },
      { name: 'bool', options: { trueText: 'on' } },
      { name: 'duration' },
      { name: 'any' },
      { name: 'void' },
      { name: 'typ' },
    ] },
  },
} satisfies Record<string, TypeDefT>;

export const BAD_PROGRAMS: readonly [string, unknown][] = [
  ['unknown kind', { kind: 'call', fn: 'x' }],
  ['define without body', { kind: 'define', vars: [] }],
  ['flow with an unknown action', { kind: 'flow', action: 'goto' }],
  ['get with a step of no known shape', { kind: 'get', path: [{ index: 1 }] }],
  ['new of an unknown type name', { kind: 'new', type: { name: 'Ghost' } }],
  ['if branch without body', { kind: 'if', ifs: [{ condition: t('bool', true) }] }],
  ['template of a number', { kind: 'template', template: 5 }],
  ['lambda without type', { kind: 'lambda', body: t('num', 1) }],
  ['loop key not a string', { kind: 'loop', over: t('num', 1), body: t('num', 1), key: 1 }],
  ['extension with an unknown base', { kind: 'new', type: { name: 'X', extends: 'Ghost' } }],
  ['extension with a bad name', { kind: 'new', type: { name: 'bad name', extends: 'obj' } }],
];

