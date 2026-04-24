import { createRegistry, Engine } from './src/index';

/**
 * Demo program — extend this to probe more of the toCode output.
 * Run with: npx tsx demo-tocode.ts
 */

const program = {
  kind: 'define',
  vars: [
    { name: 'scores', value: { kind: 'new',
        type: { name: 'list', generic: { V: { name: 'num' } } },
        value: [85, 42, 95, 17, 68, 101, 73] } },
    { name: 'tally', value: { kind: 'new',
        type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } } } },
    { name: 'stats', value: { kind: 'new',
        type: { name: 'object', props: {
          total:   { type: { name: 'num' } },
          skipped: { type: { name: 'num' } } } },
        value: { total: 0, skipped: 0 } } },
    { name: 'classify', value: { kind: 'lambda',
        type: { name: 'function', call: {
          args: { name: 'object', props: { s: { type: { name: 'num' } } } },
          returns: { name: 'text' } } },
        body: { kind: 'if',
          ifs: [{ condition: { kind: 'get',
              path: [{ prop: 'args' }, { prop: 's' }, { prop: 'gte' },
                { args: { other: { kind: 'new', type: { name: 'num' }, value: 60 } } }] },
            body: { kind: 'new', type: { name: 'text' }, value: 'pass' } }],
          else: { kind: 'new', type: { name: 'text' }, value: 'fail' } } } },
  ],
  body: { kind: 'block', lines: [
    { kind: 'loop',
      over: { kind: 'get', path: [{ prop: 'scores' }] },
      body: { kind: 'block', lines: [
        { kind: 'if', ifs: [{ condition: { kind: 'get',
            path: [{ prop: 'value' }, { prop: 'lt' },
              { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } }] },
          body: { kind: 'flow', action: 'throw',
            error: { kind: 'new', type: { name: 'text' }, value: 'negative score' } } }] },
        { kind: 'if', ifs: [{ condition: { kind: 'get',
            path: [{ prop: 'value' }, { prop: 'gt' },
              { args: { other: { kind: 'new', type: { name: 'num' }, value: 100 } } }] },
          body: { kind: 'flow', action: 'break' } }] },
        { kind: 'if', ifs: [{ condition: { kind: 'get',
            path: [{ prop: 'value' }, { prop: 'eq' },
              { args: { other: { kind: 'new', type: { name: 'num' }, value: 0 } } }] },
          body: { kind: 'block', lines: [
            { kind: 'set',
              path: [{ prop: 'stats' }, { key: { kind: 'new', type: { name: 'text' }, value: 'skipped' } }],
              value: { kind: 'get',
                path: [{ prop: 'stats' }, { prop: 'skipped' }, { prop: 'add' },
                  { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } }] } },
            { kind: 'flow', action: 'continue' },
          ] } }] },
        { kind: 'set',
          path: [{ prop: 'stats' }, { key: { kind: 'new', type: { name: 'text' }, value: 'total' } }],
          value: { kind: 'get',
            path: [{ prop: 'stats' }, { prop: 'total' }, { prop: 'add' },
              { args: { other: { kind: 'get', path: [{ prop: 'value' }] } } }] } },
        { kind: 'define',
          vars: [{ name: 'label', value: { kind: 'get',
              path: [{ prop: 'classify' },
                { args: { s: { kind: 'get', path: [{ prop: 'value' }] } } }] } }],
          body: { kind: 'switch',
            value: { kind: 'get', path: [{ prop: 'label' }] },
            cases: [{ equals: [{ kind: 'new', type: { name: 'text' }, value: 'pass' }],
              body: { kind: 'set',
                path: [{ prop: 'tally' }, { key: { kind: 'new', type: { name: 'text' }, value: 'pass' } }],
                value: { kind: 'get',
                  path: [{ prop: 'tally' }, { prop: 'at' },
                    { args: { key: { kind: 'new', type: { name: 'text' }, value: 'pass' } } },
                    { prop: 'or' },
                    { args: { fallback: { kind: 'new', type: { name: 'num' }, value: 0 } } },
                    { prop: 'add' },
                    { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } }] } } }],
            else: { kind: 'set',
              path: [{ prop: 'tally' }, { key: { kind: 'new', type: { name: 'text' }, value: 'fail' } }],
              value: { kind: 'get',
                path: [{ prop: 'tally' }, { prop: 'at' },
                  { args: { key: { kind: 'new', type: { name: 'text' }, value: 'fail' } } },
                  { prop: 'or' },
                  { args: { fallback: { kind: 'new', type: { name: 'num' }, value: 0 } } },
                  { prop: 'add' },
                  { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } }] } } } },
      ] } },
    { kind: 'template',
      template: { kind: 'new', type: { name: 'text' }, value: 'Scanned {total} points; pass={pass} fail={fail}' },
      params: { kind: 'new',
        type: { name: 'object', props: {
          total: { type: { name: 'num' } },
          pass:  { type: { name: 'num' } },
          fail:  { type: { name: 'num' } } } },
        value: { total: 0, pass: 0, fail: 0 } } },
  ] },
} as const;

async function main() {
  const r = createRegistry();
  const e = new Engine(r);

  console.log('─── default (statement form) ──────────────────────────────────');
  console.log(e.toCode(program as any));

  console.log();
  console.log('─── expectsValue: true (expression form) ─────────────────────');
  console.log(e.toCode(program as any, { expectsValue: true }));
}

main().catch((err) => { console.error(err); process.exit(1); });
