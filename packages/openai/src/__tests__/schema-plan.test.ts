/**
 * The request's schemas as the OpenAI provider plans and sends them
 * (`prepareRequest`): a dynamic tool bound with its ctx and a strict output,
 * through Chat Completions and Responses, and the tool cap with its
 * dispatcher.
 */

import { AI, type AIContextAny, type ModelInfo, type Request } from '@aeye/ai';
import type { ToolDefinition } from '@aeye/core';
import { a } from '@aeye/schema';
import { OpenAIProvider } from '../openai';

const mockChatCreate = jest.fn();
const mockResponsesCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockChatCreate } },
  responses: { create: mockResponsesCreate },
})));

const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };

/** gpt-4o as the registry knows it: strict tools and structured output. */
const gpt4o: ModelInfo = {
  id: 'gpt-4o', provider: 'openai', name: 'GPT-4o', tier: 'flagship',
  capabilities: new Set(['chat', 'tools', 'toolsStrict', 'structured', 'json', 'streaming']),
  pricing: { text: { input: 1, output: 1 } }, contextWindow: 128_000,
};

/** A tool whose field enum comes from the call's ctx. */
interface Catalog { fields: string[]; version: number }
const Filter = a
  .define({ Filter: a.object({ field: a.ref('Field'), equals: a.string(), note: a.string().optional() }) })
  .dynamic((catalog: Catalog) => ({ Field: a.enum(catalog.fields) }), { key: (catalog) => catalog.version })
  .result(a.object({ where: a.ref('Filter'), labels: a.record(a.string()) }));

const Answer = a.object({ rows: a.int().min(0), summary: a.string().optional() });

function request(catalog: Catalog): Request {
  return {
    messages: [{ role: 'user', content: 'Find them' }],
    tools: [{ name: 'query', description: 'Query rows', parameters: Filter.bind(catalog), strict: 1 }],
    responseFormat: { type: Answer.bind(), strict: true },
  };
}

/** Every `enum` list anywhere in a JSON Schema tree. */
function enums(node: unknown, into: unknown[][] = []): unknown[][] {
  if (Array.isArray(node)) node.forEach(item => enums(item, into));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'enum' && Array.isArray(value)) into.push(value);
      else enums(value, into);
    }
  }
  return into;
}

const chatDone = { choices: [{ message: { content: '{"rows":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
const responsesDone = {
  output: [{ type: 'message', role: 'assistant', status: 'completed', id: 'msg_1', content: [{ type: 'output_text', text: '{"rows":1}', annotations: [] }] }],
  status: 'completed', incomplete_details: null,
  usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
};

beforeEach(() => {
  mockChatCreate.mockReset().mockResolvedValue(chatDone);
  mockResponsesCreate.mockReset().mockResolvedValue(responsesDone);
});

describe('OpenAI schema plan', () => {
  it('sends a dynamic tool and a strict output in the OpenAI strict dialect (Chat Completions)', async () => {
    await new OpenAIProvider({ apiKey: 'test', api: 'chat' }).createExecutor()(request({ fields: ['name', 'email'], version: 1 }), ctx, { model: gpt4o });

    const params = mockChatCreate.mock.calls[0][0];
    const tool = params.tools[0].function;
    expect(tool.name).toBe('query');
    expect(tool.strict).toBe(true);
    // The ctx's fields became the enum
    expect(enums(tool.parameters)).toContainEqual(['name', 'email']);
    // OpenAI strict: closed objects, every field required, records as pairs
    expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    expect([...tool.parameters.required].sort()).toEqual(['labels', 'where']);
    expect(tool.parameters.properties.labels.type).toBe('array');

    expect(params.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'response', strict: true } });
    const output = params.response_format.json_schema.schema;
    expect(output.additionalProperties).toBe(false);
    // An absent optional is written as null-able and required
    expect([...output.required].sort()).toEqual(['rows', 'summary']);
  });

  it('binds the dynamic part per call', async () => {
    const executor = new OpenAIProvider({ apiKey: 'test', api: 'chat' }).createExecutor();
    // (The bind is cached by the key: a new catalog has a new version)
    await executor(request({ fields: ['a'], version: 10 }), ctx, { model: gpt4o });
    await executor(request({ fields: ['b', 'c'], version: 11 }), ctx, { model: gpt4o });

    const [first, second] = mockChatCreate.mock.calls.map(call => enums(call[0].tools[0].function.parameters));
    expect(first).toContainEqual(['a']);
    expect(second).toContainEqual(['b', 'c']);
  });

  it('sends the same through Responses', async () => {
    await new OpenAIProvider({ apiKey: 'test', api: 'responses' }).createExecutor()(request({ fields: ['name', 'email'], version: 1 }), ctx, { model: gpt4o });

    const params = mockResponsesCreate.mock.calls[0][0];
    expect(params.tools[0]).toMatchObject({ type: 'function', name: 'query', strict: true, parameters: { additionalProperties: false } });
    expect(enums(params.tools[0].parameters)).toContainEqual(['name', 'email']);
    expect(params.text.format).toMatchObject({ type: 'json_schema', name: 'response', strict: true, schema: { additionalProperties: false } });
  });

  it('sends tools non-strict to a model without toolsStrict, still in the OpenAI dialect', async () => {
    const plain: ModelInfo = { ...gpt4o, id: 'gpt-4-turbo', capabilities: new Set(['chat', 'tools', 'json']) };
    await new OpenAIProvider({ apiKey: 'test', api: 'chat' }).createExecutor()(request({ fields: ['x'], version: 1 }), ctx, { model: plain });

    const params = mockChatCreate.mock.calls[0][0];
    expect(params.tools[0].function.strict).toBeUndefined();
    // Non-strict OpenAI: an open record, optionals left out of `required`
    expect(params.tools[0].function.parameters.properties.labels.type).toBe('object');
    // No 'structured': a non-strict json_schema (the model has JSON mode)
    expect(params.response_format.type).toBe('json_schema');
    expect(params.response_format.json_schema.strict).toBeUndefined();
  });

  it('sends 129 tools as 128: the 127 most wanted, then run_tool for the rest', async () => {
    const tools: ToolDefinition[] = Array.from({ length: 129 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i}`,
      parameters: a.object({ n: a.number() }).bind(),
      // The last two are the least wanted
      strict: i >= 127 ? 1 : 2,
    }));
    await new OpenAIProvider({ apiKey: 'test', api: 'chat' }).createExecutor()({ messages: [{ role: 'user', content: 'Go' }], tools }, ctx, { model: gpt4o });

    const sent = mockChatCreate.mock.calls[0][0].tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(sent).toHaveLength(128);
    expect(sent[127]).toBe('run_tool');
    expect(sent).not.toContain('tool_127');
    expect(sent).not.toContain('tool_128');

    // The plan pinned on the tools decodes a dispatcher call as the original tool
    const decoded = tools[0].plan!.decodeCall('run_tool', JSON.stringify({ tool: 'tool_128', args: { n: 3 } }));
    expect(decoded).toMatchObject({ ok: true, tool: 'tool_128', value: { n: 3 } });
  });
});
