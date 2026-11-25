/**
 * Prompt outputs on @aeye/schema, end to end: a Prompt run against a fake
 * provider that plans each request for a model (`prepareRequest`) and
 * answers the way that model writes. Schemas from the schema corpus
 * (packages/schema/src/__tests__/corpus/core-tools.ts).
 */
import { a, type SchemaOf } from '@aeye/schema';
import { Prompt } from '../prompt';
import type { Context } from '../types';
import { MODELS, plannedExecutor, type PlannedTurn, type Sent } from './mocks/planned';

// corpus: core:README.md:56 — the summarizer's output.
const SummaryOutput = a.object({
  summary: a.string().describe('A concise summary'),
  keyPoints: a.array(a.string()).describe('Main points'),
});
// A record and an optional: the two shapes strict dialects rewrite.
const Budget = a.object({
  owner: a.string(),
  limits: a.record(a.number().min(0)),
  note: a.string().optional(),
});
// corpus: core:prompt-modes-reconfig.test.ts:450 — the output depends on the input (was `schema: (input) => ...`).
type PersonOut = { name: string; age: number } | { name: string };
const PersonByInput = a
  .declare<{ Person: PersonOut }>()
  .dynamic(
    (_ctx: Context<{}, {}>, input?: { includeAge: boolean }) => ({
      Person: (input?.includeAge ? a.object({ name: a.string(), age: a.number() }) : a.object({ name: a.string() })) as SchemaOf<PersonOut>,
    }),
    { key: (_ctx, input) => !!input?.includeAge },
  )
  .result('Person');
// The output depends on ctx: the categories a tenant has.
const Classified = a
  .declare<{ Category: string }>()
  .dynamic((ctx: Context<{ categories: string[] }, {}>) => ({ Category: a.enum(ctx.categories) }), { key: (ctx) => ctx.categories.join() })
  .result(a.object({ category: a.ref('Category'), confidence: a.number() }));
// corpus: core:prompt-miscellaneous-simple.test.ts:367 — `schema: z.string().min(5)`: the raw text.
const TextMin5 = a.string().min(5);

async function run(prompt: Prompt<any, any, any, any, any, any, any>, model: Parameters<typeof plannedExecutor>[0], turns: ReadonlyArray<PlannedTurn | ((sent: Sent) => PlannedTurn)>, input: unknown = {}, ctx: Record<string, unknown> = {}) {
  const { execute, sent } = plannedExecutor(model, turns);
  const events: any[] = [];
  let output: unknown;
  let error: unknown;
  try {
    for await (const event of prompt.get('stream', input, { ...ctx, execute } as any)) {
      events.push(event);
      if (event.type === 'complete') output = event.output;
    }
  } catch (e) {
    error = e;
  }
  const retries = events.filter(e => e.type === 'message' && e.message.role === 'user').map(e => e.message.content as string);
  return { events, sent, output, error, retries };
}

/** The model's answer for a sent request: the value written in the shape this request asked for. */
const answer = (value: unknown) => (sent: Sent): PlannedTurn => ({ content: JSON.stringify(sent.request.plan!.output ? sent.request.plan!.output.encode(value as never) : value) });

describe('structured output: one static schema, every provider profile', () => {
  const budget = new Prompt({ name: 'budget', description: 'b', content: 'Make a budget.', schema: Budget });
  const value = { owner: 'Ann', limits: { food: 200, fun: 50 } };

  it.each([
    ['OpenAI strict', 'gpt', true, 'array'],
    ['Anthropic strict', 'claude', true, 'array'],
    ['Gemini strict', 'gemini', true, 'object'],
    ['xAI strict', 'grok', true, 'object'],
    ['OpenAI non-strict', 'gptLoose', false, 'object'],
  ] as const)('%s: sent as structured output, decoded to the code shape', async (_label, model, strict, limitsType) => {
    const { sent, output } = await run(budget, MODELS[model], [answer(value)]);
    expect(sent[0]!.output).toBeDefined();
    expect(sent[0]!.output!.strict).toBe(strict);
    expect((sent[0]!.output!.schema as any).properties.limits.type).toBe(limitsType);
    expect(output).toEqual(value);
  });

  it('a model without structured output (Claude 3) gets the schema as prompt text, decoded the same', async () => {
    const { sent, output } = await run(budget, MODELS.claudeOld, [answer(value)]);
    expect(sent[0]!.output).toBeUndefined();
    expect(sent[0]!.request.responseFormat).toBeUndefined();
    expect(sent[0]!.system).toContain('The response must be JSON of this type:');
    expect(sent[0]!.system).toContain('limits: { [key: string]: number }');
    expect(output).toEqual(value);
  });

  it('a reply wrapped in prose (prompt-text delivery) is still read', async () => {
    const { output } = await run(budget, MODELS.claudeOld, [{ content: 'Here you go:\n```json\n{"owner":"Ann","limits":{"food":1}}\n```' }]);
    expect(output).toEqual({ owner: 'Ann', limits: { food: 1 } });
  });

  it('(was GAP) Claude with strict: false goes as prompt text: Claude has no non-strict structured output', async () => {
    const loose = new Prompt({ name: 'budget', description: 'b', content: 'Make a budget.', schema: Budget, strict: false });
    const { sent, output } = await run(loose, MODELS.claude, [answer(value)]);
    expect(sent[0]!.output).toBeUndefined();
    expect(sent[0]!.system).toContain('The response must be JSON of this type:');
    expect(sent[0]!.request.plan!.output!.adjustments).toEqual([{ kind: 'prompt-text', reason: 'strict: false' }]);
    expect(output).toEqual(value);
  });

  it("schemaDelivery: 'json' asks for JSON mode with the schema in the prompt", async () => {
    const json = new Prompt({ name: 'budget', description: 'b', content: 'Make a budget.', schema: Budget, schemaDelivery: 'json' });
    const { sent, output } = await run(json, MODELS.gpt, [answer(value)]);
    expect(sent[0]!.request.responseFormat).toBe('json');
    expect(sent[0]!.system).toContain('The response must be JSON of this type:');
    expect(output).toEqual(value);
  });

  it('OpenAI strict: an answer with pairs and nulls decodes to records and absent keys', async () => {
    const { output } = await run(budget, MODELS.gpt, [{ content: '{"owner":"Ann","limits":[{"key":"food","value":200}],"note":null}' }]);
    expect(output).toEqual({ owner: 'Ann', limits: { food: 200 } });
    expect('note' in (output as object)).toBe(false);
  });
});

describe('structured output with dynamic parts', () => {
  it('bound from the input: (ctx, input)', async () => {
    const person = new Prompt({ name: 'person', description: 'p', content: 'Describe {{name}}.', input: (i?: { name: string; includeAge: boolean }) => ({ name: i?.name }), schema: PersonByInput });
    const withAge = await run(person, MODELS.gpt, [answer({ name: 'Ann', age: 30 })], { name: 'Ann', includeAge: true });
    expect(withAge.output).toEqual({ name: 'Ann', age: 30 });
    expect(JSON.stringify(withAge.sent[0]!.output!.schema)).toContain('"age"');
    const without = await run(person, MODELS.gpt, [answer({ name: 'Ann' })], { name: 'Ann', includeAge: false });
    expect(without.output).toEqual({ name: 'Ann' });
    expect(JSON.stringify(without.sent[0]!.output!.schema)).not.toContain('"age"');
  });

  it('bound from ctx: a value outside the bound enum is sent back with a suggestion', async () => {
    const classify = new Prompt({ name: 'classify', description: 'c', content: 'Classify.', schema: Classified });
    const { output, retries } = await run(classify, MODELS.gemini, [
      { content: '{"category":"billng","confidence":0.9}' },
      { content: '{"category":"billing","confidence":0.9}' },
    ], {}, { categories: ['billing', 'shipping', 'returns'] });
    expect(output).toEqual({ category: 'billing', confidence: 0.9 });
    expect(retries[0]).toContain('1 problem in your answer');
    expect(retries[0]).toContain('did you mean `billing`?');
  });
});

describe("a string output is the model's text", () => {
  const short = new Prompt({ name: 'text', description: 't', content: 'Say something.', schema: TextMin5 });

  it('no response format is sent; the raw text is the value', async () => {
    const { sent, output } = await run(short, MODELS.gpt, [{ content: 'Valid string response' }]);
    expect(sent[0]!.request.responseFormat).toBe('text');
    expect(sent[0]!.output).toBeUndefined();
    expect(output).toBe('Valid string response');
  });

  it('text that breaks the schema is sent back, then the retry is accepted', async () => {
    const { output, retries } = await run(short, MODELS.gpt, [{ content: 'Hi' }, { content: 'Hello there' }]);
    expect(retries[0]).toMatch(/at least 5/);
    expect(output).toBe('Hello there');
  });
});

describe('errorFormat for outputs', () => {
  const bad = '{"summary": 5, "keyPoints": "a"}';
  const good = (sent: Sent) => answer({ summary: 's', keyPoints: ['a'] })(sent);

  it("default 'full': the model's JSON echoed with markers", async () => {
    const p = new Prompt({ name: 's', description: 's', content: 'Summarize.', schema: SummaryOutput });
    const { retries, output } = await run(p, MODELS.gpt, [{ content: bad }, good]);
    expect(retries[0]).toContain('2 problems in your answer');
    expect(retries[0]).toContain('^');
    expect(output).toEqual({ summary: 's', keyPoints: ['a'] });
  });

  it("ctx.errorFormat sets the request's level", async () => {
    const p = new Prompt({ name: 's', description: 's', content: 'Summarize.', schema: SummaryOutput });
    const { retries } = await run(p, MODELS.gpt, [{ content: bad }, good], {}, { errorFormat: 'summary' });
    expect(retries[0]!.split('\n')).toHaveLength(1);
  });

  it("the prompt's errorFormat wins over ctx", async () => {
    const p = new Prompt({ name: 's', description: 's', content: 'Summarize.', schema: SummaryOutput, errorFormat: 'list' });
    const { retries } = await run(p, MODELS.gpt, [{ content: bad }, good], {}, { errorFormat: 'summary' });
    expect(retries[0]).not.toContain('^');
    expect(retries[0]!.split('\n').length).toBeGreaterThan(1);
  });

  it('invalid JSON is still its own failure (json-parsing)', async () => {
    const p = new Prompt({ name: 's', description: 's', content: 'Summarize.', schema: SummaryOutput });
    const { events } = await run(p, MODELS.gpt, [{ content: 'not json' }, good]);
    expect(events.find(e => e.type === 'textReset')).toMatchObject({ reason: 'json-parsing' });
  });
});

describe('{{encode}} in the prompt content writes the output in the model shape', () => {
  it('pairs for OpenAI strict, an object for Gemini; rendered per model', async () => {
    const p = new Prompt({
      name: 'budget',
      description: 'b',
      content: 'Answer like {{encode sample}}. The shape: {{schema}}',
      input: () => ({ sample: { owner: 'Bo', limits: { rent: 900 } } }),
      schema: Budget,
    });
    const gpt = await run(p, MODELS.gpt, [answer({ owner: 'Bo', limits: {} })]);
    expect(gpt.sent[0]!.system).toContain('Answer like {"owner":"Bo","limits":[{"key":"rent","value":900}],"note":null}.');
    const gemini = await run(p, MODELS.gemini, [answer({ owner: 'Bo', limits: {} })]);
    expect(gemini.sent[0]!.system).toContain('Answer like {"owner":"Bo","limits":{"rent":900}}.');
    expect(gemini.sent[0]!.system).toContain('The shape: { owner: string;');
  });

  it("the input function gets the output's value-only encoder", async () => {
    const p = new Prompt({
      name: 'budget',
      description: 'b',
      content: 'Example: {{example}}',
      input: (_input, _ctx, encode) => ({ example: encode({ owner: 'Bo', limits: { rent: 900 } }) }),
      schema: Budget,
    });
    const { sent } = await run(p, MODELS.claude, [answer({ owner: 'Bo', limits: {} })]);
    expect(sent[0]!.system).toContain('Example: {"owner":"Bo","limits":[{"key":"rent","value":900}]}');
  });

  it('{{encode x tool="name"}} picks a tool of the request', async () => {
    const { Tool } = await import('../tool');
    const search = new Tool({ name: 'search', description: 's', schema: a.object({ filters: a.record(a.string()) }), call: () => 'ok' });
    const p = new Prompt({ name: 'p', description: 'p', content: 'Search like {{encode q tool="search"}}', input: () => ({ q: { filters: { lang: 'en' } } }), tools: [search] });
    const { sent } = await run(p, MODELS.gpt, [{ content: 'done' }]);
    expect(sent[0]!.system).toContain('Search like {"filters":[{"key":"lang","value":"en"}]}');
  });

  it('Prompt.applicable replaces the schema function returning false', async () => {
    const off = new Prompt({ name: 'off', description: 'o', content: 'x', schema: SummaryOutput, applicable: () => false });
    expect(await off.applicable({})).toBe(false);
  });
});
