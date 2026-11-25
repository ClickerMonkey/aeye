/**
 * Pass 4, errors for the model. Phil: "zods errors are terrible. I love what
 * I have in gin and query where it outputs json with markers and did you mean
 * support etc. let's have those same options specifiable so we feed back to
 * the llm meaningful errors that are super clear and not huge even if the
 * schema is huge. There should be an error format with options so on the tool
 * and prompt definition they dev can specify how detailed they want the
 * schema error feedback to the llm."
 *
 * Realistic wrong answers on the real corpus (cletus, gin's whole grammar,
 * query `typed`, the harness widget proposal, a 129-tool request), at every
 * detail level: the marker sits under the bad spot, the suggestion is the
 * one gin and query would make, the message stays under its cap however big
 * the schema, and it is compared with zod's message for the same answer.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSchemas as ginBuildSchemas, didYouMean as ginDidYouMean, nearest as ginNearest } from '../../bench/legacy-gin';
import { buildSchemas as queryBuildSchemas, didYouMean as queryDidYouMean } from '../../bench/legacy-query';
import {
  a, ANTHROPIC_STRICT, didYouMean, errorFormat, formatErrors, GOOGLE_STRICT, issueKind, LENIENT, MINIMAL, ModelProfile, modelPath, nearest,
  OPENAI_STRICT, shortType, suggestionFor, variant, type ErrorDetail, type Profile, type RequestItem,
} from '../index';
import { asTool, clone } from './corpus/_check';
import * as T from './corpus/cletus-tools';
import { WriteArgs } from './corpus/gin-grammar';
import { asGrammarRegistry, fixtureRegistry as ginFixture, personProgram } from './corpus/gin-fixtures';
import { QueryToolArgs } from './corpus/query';
import { catalogOf, fixtureRegistry as queryFixture } from './corpus/query-fixtures';
import * as W from './corpus/harness-authoring';
import { lines } from './_lines';

const LEVELS: readonly ErrorDetail[] = ['summary', 'list', 'markers', 'full'];
const tool = <T>(bound: { render(p: Profile): T }, p: Profile): T => bound.render(asTool(p));
const fail = (res: { ok: boolean; message?: string }): string => {
  if (res.ok) throw new Error('expected the answer to be refused');
  return res.message!;
};

/**
 * The marker under `token` (its first occurrence after `after`): the line
 * below starts its carets exactly at the token's column. Returns the text
 * after the carets (the message) and the line after that.
 */
function markerAt(message: string, token: string, after = ''): { text: string; next: string } {
  const ls = message.split('\n');
  let from = 0;
  if (after) from = ls.findIndex((l) => l.includes(after));
  const i = ls.findIndex((l, j) => j >= from && l.includes(token));
  if (i < 0) throw new Error(`no line with ${token} in:\n${message}`);
  const col = ls[i]!.indexOf(token);
  const below = ls[i + 1] ?? '';
  const m = /^( *)(\^+) (.*)$/.exec(below);
  if (!m) throw new Error(`no marker under ${token} in:\n${message}`);
  expect(m[1]!.length, `marker column under ${token}`).toBe(col);
  return { text: m[3]!, next: ls[i + 2] ?? '' };
}

// ============================================================================
// "Did you mean": the same ranking as gin and query
// ============================================================================

describe('did you mean: ported from gin / query, identical results', () => {
  const CASES: [string, string[]][] = [
    ['PUTT', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']],
    ['jsn', ['json', 'text', 'binary']],
    ['xor', ['and', 'or', 'not']],
    ['blok', ['new', 'get', 'set', 'define', 'block', 'if', 'switch', 'loop', 'lambda', 'template', 'flow', 'native']],
    ['comparsion', ['comparison', 'binary', 'unary', 'logical', 'literal', 'field-ref']],
    ['TITEL', ['title', 'Title', 'titel']],
    ['nope', ['new', 'get', 'set', 'define', 'block']],
    ['opne', ['open', 'closed']], // a transposition is 2 edits: past a 4-letter word's budget
    ['opn', ['open', 'closed']],
    ['serach_docs', ['search_docs', 'search_code', 'read_docs']],
    ['zzzzzz', ['name', 'email']],
    ['', ['a', 'b']],
  ];
  it.each(CASES)('%s', (input, cands) => {
    expect(didYouMean(input, cands)).toBe(ginDidYouMean(input, cands));
    expect(didYouMean(input, cands)).toBe(queryDidYouMean(input, cands));
    expect(didYouMean(input, cands, { max: 3 })).toBe(ginDidYouMean(input, cands, { max: 3 }));
    expect(nearest(input, cands)).toBe(ginNearest(input, cands));
  });
  it('fires on typos, never on unrelated words', () => {
    expect(didYouMean('PUTT', ['GET', 'PUT', 'POST'])).toBe(' — did you mean `PUT`?');
    expect(didYouMean('nope', ['new', 'get', 'set'])).toBe('');
  });
});

// ============================================================================
// The four levels, exactly (cletus web_api_call on OpenAI strict)
// ============================================================================

describe('the detail levels (cletus web_api_call, OpenAI strict)', () => {
  const r = tool(T.WebApiCallArgs, OPENAI_STRICT);
  // A wrong enum (PUTT), a header of the wrong type, a header pair without its key (the record sent wrong), another enum typo.
  const wire = () => ({
    url: 'https://api.example.com/v1/items', method: 'PUTT',
    headers: [{ key: 'Accept', value: 5 }, { name: 'X-Id', value: '1' }],
    body: null, requestType: 'jsn', responseType: null,
  });

  it("'summary': one line, the first problem and how many more", () => {
    expect(fail(r.parse(wire(), { errorFormat: 'summary' }))).toBe(
      '4 problems in your answer: at method: Expected one of: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS — did you mean `PUT`? (and 3 more problems)',
    );
  });

  it("'list': one line per problem", () => {
    expect(fail(r.parse(wire(), { errorFormat: 'list' }))).toBe([
      '4 problems in your answer:',
      '- at method: Expected one of: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS — did you mean `PUT`?',
      '- at headers[0].value: Expected a string, got number.',
      '- at headers[1].key: Required.',
      '- at requestType: Expected one of: json, text, binary — did you mean `json`?',
    ].join('\n'));
  });

  it("'markers': the model's own JSON (pairs, nulls, its key order) with a marker under each bad spot", () => {
    expect(fail(r.parse(wire(), { errorFormat: 'markers' }))).toBe([
      '4 problems in your answer:',
      '',
      '{',
      '  "url": "https://api.example.com/v1/items",',
      '  "method": "PUTT",',
      '            ^^^^^^ method: Expected one of: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS — did you mean `PUT`?',
      '  "headers": [',
      '    {',
      '      "key": "Accept",',
      '      "value": 5',
      '               ^ headers[0].value: Expected a string, got number.',
      '    },',
      '    {',
      '    ^ headers[1].key: Required.',
      '      "name": "X-Id",',
      '      "value": "1"',
      '    }',
      '  ],',
      '  "body": null,',
      '  "requestType": "jsn",',
      '                 ^^^^^ requestType: Expected one of: json, text, binary — did you mean `json`?',
      '  "responseType": null',
      '}',
    ].join('\n'));
  });

  it("'full' (the default): markers plus the expected type where the message doesn't already say it", () => {
    const res = r.parse(wire());
    const msg = fail(res);
    expect(msg).toBe(fail(r.parse(wire(), { errorFormat: 'full' })));
    expect(markerAt(msg, '{', '"Accept"').next).toBe('      expected: string');
    // an enum's message lists the values: no repeat of them as a type
    expect(markerAt(msg, '"PUTT"').next).toBe('  "headers": [');
  });

  it('the issues themselves are unchanged: both paths, the bare message, and the kind', () => {
    const res = r.parse(wire());
    expect(!res.ok && res.issues.map((i) => [i.path, i.codePath, i.message, issueKind(i), suggestionFor(i)])).toEqual([
      [['method'], ['method'], 'Expected one of: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS.', 'enum', 'PUT'],
      [['headers', 0, 'value'], ['headers', 'Accept'], 'Expected a string, got number.', 'type', undefined],
      [['headers', 1, 'key'], ['headers'], 'Required.', 'required', undefined],
      [['requestType'], ['requestType'], 'Expected one of: json, text, binary.', 'enum', 'json'],
    ]);
  });

  it('a failed decode leaves the answer as the model sent it (in place, for the echo)', () => {
    const w = wire();
    r.parse(w);
    expect(w).toEqual(wire());
    expect(Object.keys(w)).toEqual(Object.keys(wire())); // null-for-absent keys were deleted, then put back in their place
  });
});

// ============================================================================
// gin: the whole grammar (WriteArgs = { program: Expr })
// ============================================================================

describe('gin grammar: a bad nested expression', () => {
  const reg = asGrammarRegistry(ginFixture());
  const zodExpr = ginBuildSchemas(ginFixture()).Expr;
  /** personProgram with the block's kind misspelt and a `get` that wrote `pth` for `path`. */
  const broken = () => {
    const p = clone(personProgram) as any;
    p.body.kind = 'blok';
    const get = p.body.lines[2];
    p.body.lines[2] = { kind: 'get', pth: get.path };
    return p;
  };

  for (const profile of [LENIENT, OPENAI_STRICT, ANTHROPIC_STRICT, GOOGLE_STRICT]) {
    it(`${profile.id}: the marker is at the misspelt kind, with did you mean; every level fits its cap`, () => {
      const r = tool(WriteArgs.bind(reg), profile);
      // The model's wire for this profile: the valid program encoded, then broken where the model would write it.
      const wire = clone(r.encode({ program: personProgram } as never)) as any; // lenient encode returns the value itself: never mutate it
      const asText = typeof wire.program.body === 'string';
      const body = asText ? JSON.parse(wire.program.body) : wire.program.body;
      body.kind = 'blok';
      if (asText) wire.program.body = JSON.stringify(body);
      const msg = fail(r.parse(clone(wire)));
      const { text } = markerAt(msg, '"blok"');
      expect(text).toMatch(/kind: Expected kind to be one of: "new", "get", .*"native" — did you mean `block`\?$/);
      // Where recursion is JSON text (Anthropic), the path and the echo say so.
      if (asText) {
        expect(text.startsWith('program.body → JSON text → kind')).toBe(true);
        expect(msg).toContain('"body": /* JSON text */ {');
      } else {
        expect(text.startsWith('program.body.kind')).toBe(true);
      }
      for (const level of LEVELS) {
        const m = fail(r.parse(clone(wire), { errorFormat: level }));
        expect(m.length, level).toBeLessThanOrEqual(errorFormat(level).maxChars);
        expect(m, level).toContain('did you mean `block`?');
      }
    });
  }

  it('lenient, two problems: a missing key the model misspelt is one mistake ("you wrote `pth`")', () => {
    const r = tool(WriteArgs.bind(reg), LENIENT);
    const p = broken();
    p.body.kind = 'block';
    const msg = fail(r.parse({ program: p }));
    expect(msg).toContain('program.body.lines[2].path: Required — you wrote `pth`; did you mean `path`?');
    expect(msg).toMatch(/^1 problem in your answer:/);
    // zod's message for the same answer (gin's own buildSchemas): the whole tree of failed options.
    const z0 = zodExpr.safeParse(p);
    expect(z0.success).toBe(false);
    const zodLength = z0.error!.message.length;
    expect(zodLength).toBeGreaterThan(20 * msg.length);
  });

  it('a section starts at most `depth` levels above a deep problem (the rest of the program is not repeated)', () => {
    let e: any = { kind: 'new', type: { name: 'num' }, value: 1 };
    for (let i = 0; i < 30; i++) e = { kind: 'if', ifs: [{ condition: { kind: 'get', path: [{ prop: 'x' }] }, body: e }] };
    let at = e;
    for (let i = 0; i < 29; i++) at = at.ifs[0].body;
    at.ifs[0].body = { kind: 'nw', type: { name: 'num' }, value: 1 };
    const r = tool(WriteArgs.bind(reg), LENIENT);
    const msg = fail(r.parse({ program: e }));
    const path = `program${'.ifs[0].body'.repeat(30)}.kind`;
    // header, the section's (full) path, then at most `depth` (6) levels of JSON above the marker,
    // whose label goes on from the section's path (`….ifs[0].body.kind`)
    const header = msg.split('\n')[2]!;
    expect(header).toMatch(/^at program(\.ifs\[0\]\.body)+\.ifs:$/);
    const label = /\^+ (….*?): Expected kind to be one of:/.exec(msg)![1]!;
    expect(header.slice(3, -1) + label.slice(1)).toBe(path);
    expect(label).toBe('…[0].body.ifs[0].body.kind');
    expect(msg).toContain('did you mean `new`?');
    expect(msg.length).toBeLessThan(1000); // a third of it is the 30-level path, said once
  });
});

// ============================================================================
// query `typed` (the biggest schema of the corpus)
// ============================================================================

describe('query typed: a wrong enum, a wrong tag, a type that does not exist', () => {
  const fx = queryFixture();
  const catalog = catalogOf(fx);
  const ref = (source: string, field: string) => ({ kind: 'field-ref', source, field });
  const answer = () => ({
    query: {
      kind: 'select', fields: [{ expr: ref('user', 'name'), as: 'n' }], from: { kind: 'type', type: 'usr' },
      where: [{ kind: 'logical', op: 'xor', operands: [{ kind: 'comparsion', op: '>', left: ref('user', 'age'), right: { kind: 'literal', value: 30 } }] }],
      limit: 10,
    },
  });
  const zodQuery = queryBuildSchemas(fx, { depth: { functions: 'typed', typeNames: 'enum' } } as never).Query;

  for (const profile of [LENIENT, OPENAI_STRICT, ANTHROPIC_STRICT]) {
    it(`${profile.id}: three markers, three suggestions`, () => {
      const r = QueryToolArgs.render(asTool(profile), catalog, { depth: { functions: 'typed', typeNames: 'enum' } });
      const wire = r.encode(answer() as never);
      const msg = fail(r.parse(clone(wire)));
      expect(msg).toMatch(/^3 problems in your answer:/);
      expect(markerAt(msg, '"usr"').text).toMatch(/^query\.from\.type: Expected one of: .*user.* — did you mean `user`\?$/);
      expect(markerAt(msg, '"xor"').text).toBe('query.where[0].op: Expected one of: and, or, not — did you mean `or`?');
      // On Anthropic the operand (recursive) is JSON text: the path says so, and the echo shows it parsed.
      expect(markerAt(msg, '"comparsion"').text).toMatch(/^query\.where\[0\]\.operands\[0\](\.| → JSON text → )kind: Expected kind to be one of: .* — did you mean `comparison`\?$/);
      for (const level of LEVELS) {
        const m = fail(r.parse(clone(wire), { errorFormat: level }));
        expect(m.length, level).toBeLessThanOrEqual(2000);
        if (level !== 'summary') for (const s of ['`user`', '`or`', '`comparison`']) expect(m, `${level} ${s}`).toContain(`did you mean ${s}?`);
      }
    });
  }

  it("zod's message for the same answer is the whole tree of failed union options", () => {
    const r = QueryToolArgs.render(asTool(LENIENT), catalog, { depth: { functions: 'typed', typeNames: 'enum' } });
    const msg = fail(r.parse(answer()));
    const zr = zodQuery.safeParse(answer().query);
    expect(zr.success).toBe(false);
    let zodLength: number;
    try { zodLength = zr.error!.message.length; } catch { zodLength = Infinity; }
    expect(msg.length).toBeLessThan(1200);
    expect(zodLength).toBeGreaterThan(100 * msg.length);
  });
});

// ============================================================================
// the harness widget proposal: closed objects (unknown keys), discriminated plans
// ============================================================================

describe('harness widget proposal: an unknown key, a misspelt key, a wrong tag', () => {
  const input = {
    source: 'tasks/open_by_owner',
    args: { name: 'obj', props: { status: { type: { name: 'enum', options: { values: { open: 'open', done: 'done' } } } } } },
    facts: { whole: true, columns: [{ name: 'owner', kind: 'text', role: 'group', opaque: false }, { name: 'open', kind: 'integer', role: 'measure', opaque: false }] },
    ranked: [{ visual: 'table', styles: ['table', 'compact', 'cards'], bind: { columns: ['owner', 'open'] } }],
    entries: [{ name: 'table', label: 'Table', shape: { channels: [{ name: 'columns', label: 'Columns', accepts: ['text', 'integer'], required: false, many: true }], styles: [{ name: 'table' }, { name: 'compact' }, { name: 'cards' }] } }],
    drills: [],
  } as unknown as W.WidgetProposalInput;
  const proposal = W.WidgetProposal.bind(input);
  const draft = () => ({
    name: 'open_by_owner', description: 'Open tasks per owner.', title: 'Open tasks',
    choice: { visual: 'table', styl: 'compact', colour: 'red' },
    more: [], presets: [],
    args: { status: { show: 'pined', value: { literal: 'open' } } },
  });

  it('lenient: `styl` is said once (at the missing `style`), `colour` is unknown, `pined` is near `pinned`', () => {
    const msg = fail(tool(proposal, LENIENT).parse(draft()));
    expect(msg).toMatch(/^3 problems in your answer:/);
    expect(msg).toContain('choice.style: Required — you wrote `styl`; did you mean `style`?');
    expect(markerAt(msg, '"colour": "red"').text).toBe('choice.colour: Unknown field "colour".');
    // the marker of an unknown key spans the key and its value
    expect(msg).toContain('    "colour": "red"\n    ^^^^^^^^^^^^^^^ choice.colour');
    expect(markerAt(msg, '"pined"').text).toBe('args.status.show: Expected show to be one of: "control", "pinned" — did you mean `pinned`?');
    // the missing key is marked at its object, with the type it takes
    expect(markerAt(msg, '{', '"choice"').next.trim()).toBe('expected: "table" | "compact" | "cards"');
  });
});

// ============================================================================
// A pairs record sent wrong
// ============================================================================

describe('a record the model must write as pairs', () => {
  const r = tool(T.WebApiCallArgs, ANTHROPIC_STRICT);
  it('an entry without its key: marked at the entry; Required with the expected type', () => {
    const msg = fail(r.parse({ url: 'u', method: 'GET', headers: [{ name: 'Accept', value: 'json' }] }));
    expect(markerAt(msg, '{', '"headers"').text).toBe('headers[0].key: Required.');
    expect(msg).toContain('expected: string');
  });
  it('an entry with a misspelt key field: "you wrote `ky`"', () => {
    const msg = fail(r.parse({ url: 'u', method: 'GET', headers: [{ ky: 'Accept', value: 'json' }] }, { errorFormat: 'list' }));
    expect(msg).toBe('1 problem in your answer:\n- at headers[0].key: Required — you wrote `ky`; did you mean `key`?');
  });
  it('the record written as an object is not an error: it is repaired (counted)', () => {
    const res = r.parse({ url: 'u', method: 'GET', headers: { Accept: 'json' } });
    expect(res.ok && res.value.headers).toEqual({ Accept: 'json' });
    expect(res.stats.repaired).toBe(1);
  });
});

// ============================================================================
// Too many errors: grouped, capped
// ============================================================================

describe('too many errors (cletus chart, 1,000 rows)', () => {
  const Chart = T.CategoryComparisonChart;
  const rows = (n: number) => ({
    chartGroup: 'categoryComparison', title: 'Revenue by region', defaultVariant: 'bar',
    data: Array.from({ length: n }, (_, i) => ({ name: `region-${i}`, value: String(i) })),
  });
  const zodChart = z.object({
    chartGroup: z.literal('categoryComparison'), title: z.string().optional(),
    data: z.array(z.object({ name: z.string(), value: z.number(), category: z.string().optional() })),
    defaultVariant: z.enum(['bar', 'horizontalBar', 'pictorialBar']).optional(),
  });

  it('the same mistake 1,000 times is one problem with a count; each level under its cap', () => {
    const r = tool(Chart, LENIENT);
    for (const level of LEVELS) {
      const msg = fail(r.parse(rows(1000), { errorFormat: level }));
      expect(msg, level).toContain('1000 problems');
      expect(msg, level).toContain('and 997 more places');
      expect(msg.length, level).toBeLessThan(600);
    }
    const full = fail(r.parse(rows(1000)));
    expect(full).toContain('    … 999 items');
    // zod lists every one of them
    const zr = zodChart.safeParse(rows(1000));
    expect(zr.success).toBe(false);
    expect(zr.error!.message.length).toBeGreaterThan(100 * full.length);
  });

  it('different mistakes: `maxErrors` are shown, the rest counted', () => {
    const v: any = rows(20);
    v.data.forEach((d: any, i: number) => { d.value = i; if (i % 2) d.name = i; });
    v.defaultVariant = 'bars';
    v.title = 7;
    const r = tool(Chart, LENIENT);
    const msg = fail(r.parse(v, { errorFormat: { maxErrors: 2 } }));
    // 10 names (one kind), the variant, the title: 12 problems of 3 kinds; 2 kinds shown
    expect(msg).toMatch(/^12 problems in your answer:/);
    expect(msg).toContain('data[1].name: Expected a string, got number. (the same at data[3].name, data[5].name and 7 more places)');
    expect(msg).toContain('… and 1 more problem not shown.');
  });
});

// ============================================================================
// The dispatcher: a 129-tool request on GPT (128 max)
// ============================================================================

describe('a dispatcher call (129 tools on GPT): told as the original tool', () => {
  const tools: RequestItem[] = Array.from({ length: 129 }, (_, i) => ({
    kind: 'tool', name: i === 128 ? 'search_docs' : `tool_${i}`, strict: i === 128 ? 0 : 1, description: `Tool ${i}.`,
    schema: i === 128 ? a.object({ query: a.string(), scope: a.enum(['all', 'title', 'body']) }) : a.object({ n: a.int() }),
  }));
  const gpt = ModelProfile.of(OPENAI_STRICT);
  const req = gpt.request(tools);
  const dispatcher = req.dispatcher!;

  it('search_docs went behind the dispatcher', () => {
    expect(req.get('search_docs').delivery).toBe('dispatched');
    expect(dispatcher.name).toBe('run_tool');
  });

  it('a misspelt tool name inside run_tool: did you mean', () => {
    const res = req.decodeCall('run_tool', { tool: 'serach_docs', args: { search_docs: { query: 'x', scope: 'all' } } });
    expect(res.ok).toBe(false);
    const msg = !res.ok ? res.message : '';
    expect(msg).toMatch(/^1 problem in your call to run_tool:/);
    expect(markerAt(msg, '"serach_docs"').text).toMatch(/^tool: Expected one of: .* — did you mean `search_docs`\?$/);
  });

  it('bad args of a dispatched tool: the header names the tool, the echo is the call as sent', () => {
    const args = dispatcher.encode({ tool: 'search_docs', args: { query: 'x', scope: 'all' } }) as any;
    const sent = clone(args);
    const inner = sent.args.search_docs ?? sent.args;
    inner.scope = 'titl';
    const res = req.decodeCall('run_tool', sent);
    const msg = !res.ok ? res.message : '';
    expect(!res.ok && res.tool).toBe('search_docs');
    expect(msg).toMatch(/^1 problem in the arguments of search_docs \(called through run_tool\):/);
    expect(markerAt(msg, '"titl"').text).toBe('args.scope: Expected one of: all, title, body — did you mean `title`?');
  });

  it('a call to a misspelt tool name: did you mean; a dispatched tool called by its own name is decoded', () => {
    const res = req.decodeCall('serach_docs', { query: 'x', scope: 'all' });
    expect(res).toMatchObject({ ok: false, message: 'No tool named "serach_docs" in this request — did you mean `search_docs`?' });
    const far = req.decodeCall('zzz', {});
    expect(!far.ok && far.message).toMatch(/^No tool named "zzz" in this request\. Tools: tool_0, tool_1, .*, … \(\d+ more\)\.$/);
    expect(req.decodeCall('search_docs', { query: 'x', scope: 'all' })).toEqual({ ok: true, tool: 'search_docs', value: { query: 'x', scope: 'all' } });
  });

  it('a tool definition\'s error format travels with it through the dispatcher', () => {
    const r2 = gpt.request(tools.map((t) => (t.name === 'search_docs' ? { ...t, errorFormat: 'summary' as const } : t)), { errorFormat: 'list' });
    const bad = r2.dispatcher!.encode({ tool: 'search_docs', args: { query: 'x', scope: 'all' } }) as any;
    (bad.args.search_docs ?? bad.args).scope = 'titl';
    const res = r2.decodeCall('run_tool', bad);
    expect(!res.ok && res.message).toBe('A problem in the arguments of search_docs (called through run_tool): at args.scope: Expected one of: all, title, body — did you mean `title`?');
    // a direct tool takes the request's format
    const direct = r2.decodeCall('tool_0', { n: 'one' });
    expect(!direct.ok && direct.message).toBe('1 problem in the arguments of tool_0:\n- at n: Expected a number, got string.');
  });
});

// ============================================================================
// Options and their precedence
// ============================================================================

describe('options', () => {
  const S = a.object({ kind: a.enum(['open', 'closed']), n: a.int().min(1), tags: a.array(a.object({ name: a.string() })) });
  const r = S.render(LENIENT);
  const bad = () => ({ kind: 'opn', n: 0, tags: [{ name: 'a' }, { nam: 'b' }] });

  it('suggestions off', () => {
    expect(fail(r.parse(bad(), { errorFormat: { detail: 'list', suggestions: false } }))).not.toContain('did you mean');
    expect(fail(r.parse(bad(), { errorFormat: { detail: 'list' } }))).toContain('did you mean `open`?');
  });

  it('expected types: on with full, off with markers, settable either way', () => {
    expect(fail(r.parse(bad()))).toContain('expected: string');
    expect(fail(r.parse(bad(), { errorFormat: 'markers' }))).not.toContain('expected:');
    expect(fail(r.parse(bad(), { errorFormat: { detail: 'markers', expected: true } }))).toContain('expected: string');
    expect(fail(r.parse(bad(), { errorFormat: { detail: 'list', expected: true } }))).toContain('- at tags[1].name: Required — you wrote `nam`; did you mean `name`? (expected: string)');
  });

  it('no header', () => {
    expect(fail(r.parse(bad(), { errorFormat: { detail: 'summary', header: false } }))).toBe('at kind: Expected one of: open, closed — did you mean `open`? (and 2 more problems)');
  });

  it('a label for what the model wrote', () => {
    expect(fail(r.parse(bad(), { errorFormat: 'summary', label: 'the filter' }))).toMatch(/^3 problems in the filter: /);
  });

  it('context: siblings shown next to a bad spot', () => {
    const big = { kind: 'open', n: 1, tags: Array.from({ length: 10 }, (_, i) => ({ name: i === 5 ? 5 : `t${i}` })) };
    expect(fail(r.parse(clone(big), { errorFormat: { context: 0 } }))).toContain('    … 5 items\n    /* 5 */ {');
    const S2 = a.object({ a: a.string(), b: a.string(), c: a.string(), d: a.string(), e: a.number() });
    const m = fail(S2.render(LENIENT).parse({ a: 'a', b: 'b', c: 'c', d: 'd', e: 'x' }, { errorFormat: { context: 1 } }));
    expect(m).toContain('  "a": "a",\n  "e": "x"');
    expect(m).toContain('  … 3 more keys');
  });

  it('precedence: request < definition < call', () => {
    const req = ModelProfile.of(LENIENT).request([
      { kind: 'tool', name: 'a_tool', schema: S, errorFormat: { detail: 'list', suggestions: false } },
      { kind: 'tool', name: 'b_tool', schema: S },
    ], { errorFormat: 'summary' });
    expect(req.get('a_tool').parse(bad()).ok || req.get('a_tool').parse(bad())).toMatchObject({ message: expect.stringMatching(/^3 problems in the arguments of a_tool:\n- at kind: Expected one of: open, closed\.\n/) });
    expect(fail(req.get('b_tool').parse(bad()))).toMatch(/^3 problems in the arguments of b_tool: at kind: /);
    expect(fail(req.get('a_tool').parse(bad(), { errorFormat: { suggestions: true } }))).toContain('did you mean `open`?');
    expect(fail(req.get('a_tool').parse(bad(), { errorFormat: 'markers' }))).toContain('    {\n    ^ tags[1].name: Required.\n      "nam": "b"');
  });

  it('a prompt\'s output: "your answer"', () => {
    const req = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'output', schema: S, errorFormat: 'summary' }]);
    expect(fail(req.get('output').parse(bad()))).toMatch(/^3 problems in your answer: at kind: /);
  });

  it('formatErrors on its own: issues + the wire', () => {
    const res = r.parse(bad(), { errorFormat: 'list' });
    expect(!res.ok && formatErrors(res.issues, bad(), 'summary', 'it')).toBe('3 problems in it: at kind: Expected one of: open, closed — did you mean `open`? (and 2 more problems)');
  });
});

// ============================================================================
// The size cap, on the biggest schemas
// ============================================================================

describe('maxChars is a hard cap: detail is dropped step by step', () => {
  const reg = asGrammarRegistry(ginFixture());
  const r = tool(WriteArgs.bind(reg), LENIENT);
  /** 40 different mistakes across a block of programs. */
  const many = () => {
    const lines = Array.from({ length: 40 }, (_, i) => {
      const p = clone(personProgram) as any;
      if (i % 4 === 0) p.kind = 'defin';
      if (i % 4 === 1) p.vars[0].name = i;
      if (i % 4 === 2) p.body.lines[0].kind = 'sett';
      if (i % 4 === 3) p.body.lines[2].path = 'p.fullName';
      return p;
    });
    return { program: { kind: 'block', lines } };
  };
  for (const maxChars of [2000, 800, 400, 200, 120, 60]) {
    it(`maxChars ${maxChars}`, () => {
      for (const detail of LEVELS) {
        const msg = fail(r.parse(many(), { errorFormat: { detail, maxChars } }));
        expect(msg.length, `${detail}`).toBeLessThanOrEqual(maxChars);
        if (maxChars >= 200) expect(msg, detail).toMatch(/^40 problems in your answer/);
      }
    });
  }
  it('at the default cap, the full message shows each of the 4 kinds once, with where else it happened', () => {
    const msg = fail(r.parse(many()));
    expect(msg.length).toBeLessThanOrEqual(2000);
    for (const s of ['did you mean `define`?', 'Expected a string, got number.', 'did you mean `set`?', 'Expected a list, got string.']) expect(msg).toContain(s);
    // the full text didn't fit 2000 characters: value lists and repeat paths are shortened first (terse), the structure kept
    expect(msg.match(/\(the same at 9 more places\)/g)).toHaveLength(4);
    expect(msg).toContain('Expected kind to be one of 12 values — did you mean `define`?');
    expect(msg).toContain('expected: PathStep[]');
  });
});

// ============================================================================
// The tagged-union dialect (MINIMAL): paths through the option labels
// ============================================================================

describe('a dialect without unions (MINIMAL): the echo is the tagged object the model wrote', () => {
  it('marks inside the filled option', () => {
    const U = a.object({ v: a.union([a.object({ kind: a.literal('n'), n: a.number() }), a.object({ kind: a.literal('s'), s: a.string() })]) });
    const r = tool(U, MINIMAL);
    const wire = r.encode({ v: { kind: 's', s: 'x' } } as never) as any;
    const label = Object.keys(wire.v).find((k) => wire.v[k] !== null)!;
    wire.v[label].s = 5;
    const msg = fail(r.parse(wire));
    expect(markerAt(msg, '5').text).toBe(`v.${label}.s: Expected a string, got number.`);
  });
});

// ============================================================================
// Pieces
// ============================================================================

describe('pieces', () => {
  it('modelPath: JSON-text steps are spelled out', () => {
    expect(modelPath([])).toBe('(root)');
    expect(modelPath(['rows', 2, 'tags'])).toBe('rows[2].tags');
    expect(modelPath(['children', 0, '(json)', 'value'])).toBe('children[0] → JSON text → value');
    expect(modelPath(['a', '(json)'])).toBe('a → JSON text');
    expect(modelPath(['x-y', 0])).toBe('["x-y"][0]');
  });
  it('shortType: a short TypeScript-like type of one spot', () => {
    expect(shortType({ type: 'object', properties: { key: { type: 'string' }, value: { $ref: '#/$defs/Expr' } }, required: ['key', 'value'] })).toBe('{ key: string; value: Expr }');
    expect(shortType({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } })).toBe('(string | null)[]');
    expect(shortType({ type: 'string', enum: Array.from({ length: 40 }, (_, i) => `v${i}`) })).toBe('"v0" | "v1" | "v2" | "v3" | "v4" | "v5" | … (40 values)');
    expect(shortType({ type: 'object', properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, { type: 'object', properties: { a: { type: 'string' } } }])) }, 80).length).toBeLessThanOrEqual(80);
  });
  it('the old line format is still there for logs (formatIssues / lines)', () => {
    const res = a.object({ n: a.number() }).render(LENIENT).parse({ n: 'x' });
    expect(lines(res)).toBe('- at n: Expected a number, got string.');
  });
  it('variant profiles keep the format (it is not a profile setting)', () => {
    const r = a.object({ n: a.number() }).render(variant(LENIENT, { rootObject: true }));
    expect(fail(r.parse({ n: 'x' }, { errorFormat: 'summary' }))).toBe('A problem in your answer: at n: Expected a number, got string.');
  });
});
