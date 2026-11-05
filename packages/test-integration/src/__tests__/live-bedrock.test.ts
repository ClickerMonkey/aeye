/**
 * Live AWS Bedrock cases: text, usage and caching on Nova and Claude;
 * Claude's adaptive, budget and redacted thinking, replayed across a tool
 * call; the reasoning settings of open-weight models and Nova 2; strict tools
 * and structured output; context window errors; and inference profiles.
 *
 * Runs when AWS_ACCESS_KEY_ID_TEMP and AWS_SECRET_ACCESS_KEY_TEMP are set,
 * in AWS_REGION (us-east-2 by default).
 */

import { describe, expect } from '@jest/globals';
import { AI } from '@aeye/ai';
import { AWSBedrockProvider, AWSContextWindowError } from '@aeye/aws';
import { type Chunk, getDescriptorById, getResponseFromChunks, type Message, type ReasoningEffort, type Request, type Response, type ToolDefinition } from '@aeye/core';
import { models, strictSupport } from '@aeye/models';
import type { ConverseCommandInput, ConverseStreamCommandInput } from '@aws-sdk/client-bedrock-runtime';
import z from 'zod';
import { firstChunk, type LiveSource, liveCase } from '../live';
import { DICE, DICE_COUNT, DICE_ROLL, DICE_TASK, DICE_TOOL } from '../reasoning';
import { fixtures, manyUnions } from '../schemas';

const accessKeyId = process.env.AWS_ACCESS_KEY_ID_TEMP;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY_TEMP;
const describeLive = accessKeyId && secretAccessKey ? describe : describe.skip;

const SOURCES: LiveSource[] = ['core', 'ai', 'aws', 'models'];

const NOVA_MICRO = 'amazon.nova-micro-v1:0';
const NOVA_2_LITE = 'amazon.nova-2-lite-v1:0';
// The cheapest adaptive-thinking Claude the account can call
const SONNET_4_6 = 'anthropic.claude-sonnet-4-6';
const HAIKU_4_5 = 'anthropic.claude-haiku-4-5-20251001-v1:0';
const GPT_OSS = 'openai.gpt-oss-20b-1:0';
const NEMOTRON = 'nvidia.nemotron-nano-3-30b';
const DEEPSEEK_R1 = 'deepseek.r1-v1:0';

// Anthropic's documented prompt that forces redacted thinking
const REDACTED_TRIGGER = 'ANTHROPIC_MAGIC_STRING_TRIGGER_REDACTED_THINKING_46C9A13E193C177646C7398A98432ECCCE4C1253D5E2D82641AC0E52CC2876CB';

const PRIME: Message = { role: 'user', content: 'Find the smallest positive integer n such that n^2 + n + 41 is composite. Reply with only n.' };

// Every Converse input sent, in order; cases run one at a time per file
const sent: Array<ConverseCommandInput | ConverseStreamCommandInput> = [];

function lastSent() {
  return sent[sent.length - 1];
}

/** A request's response, streamed and folded. */
async function streamed(ai: ReturnType<typeof createAI>, request: Request, model: string): Promise<Response> {
  const chunks: Chunk[] = [];
  for await (const chunk of ai.chat.stream(request, { metadata: { model } })) {
    chunks.push(chunk);
  }
  return getResponseFromChunks(chunks);
}

function createAI() {
  const aws = new AWSBedrockProvider({
    region: process.env.AWS_REGION || 'us-east-2',
    credentials: { accessKeyId, secretAccessKey },
    hooks: { chat: { beforeRequest: (_, command) => { sent.push(command.input); } } },
  });
  return AI.with().providers({ aws }).create({ models, modelOverrides: strictSupport });
}

/** A stable prefix of about 5k tokens, unique to the run so the first call writes it. */
function cachePrefix(): Message {
  const facts = Array.from({ length: 300 }, (_, i) => `Fact ${i}: the code for item ${i} is ${(i * 7919) % 10007}.`).join('\n');
  return { role: 'system', content: [{ type: 'text', content: `Run ${Date.now()}.\n${facts}`, cacheBreakpoint: true }] };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describeLive('live bedrock', () => {
  const ai = createAI();

  // ==========================================================================
  // Basics and inference profiles
  // ==========================================================================

  liveCase('bedrock nova-micro text, whole and streamed', { sources: SOURCES, inputs: { model: NOVA_MICRO } }, async () => {
    const request: Request = { messages: [{ role: 'user', content: 'Say hi.' }], maxTokens: 20 };
    const whole = await ai.chat.get(request, { metadata: { model: NOVA_MICRO } });
    const stream = await streamed(ai, request, NOVA_MICRO);
    for (const response of [whole, stream]) {
      expect(response.content).toBeTruthy();
      expect(response.usage?.text?.input).toBeGreaterThan(0);
      expect(response.usage?.text?.output).toBeGreaterThan(0);
    }
    // Profile-only in us-east-2 though the registry has it in region
    expect(lastSent().modelId).toBe(`us.${NOVA_MICRO}`);
  });

  liveCase('bedrock claude off-region model resolves to its profile', { sources: SOURCES, inputs: { model: HAIKU_4_5 } }, async () => {
    const chunk = await firstChunk((signal) => ai.chat.stream({ messages: [{ role: 'user', content: 'Say hi.' }], maxTokens: 10 }, { signal, metadata: { model: HAIKU_4_5 } }));
    expect(chunk).toBeDefined();
    expect(lastSent().modelId).toBe(`us.${HAIKU_4_5}`);
  });

  for (const model of [NOVA_MICRO, HAIKU_4_5]) {
    liveCase(`bedrock ${model} caches a repeated prefix`, { sources: SOURCES, inputs: { model, prefix: 'facts-300' } }, async () => {
      const request: Request = { messages: [cachePrefix(), { role: 'user', content: 'Say hi.' }], maxTokens: 5 };
      const first = await ai.chat.get(request, { metadata: { model } });
      expect(first.usage?.text?.cacheWrite).toBeGreaterThan(1000);
      // Nova's cache can take a few seconds to serve reads
      let cached = 0;
      for (let attempt = 0; attempt < 4 && !cached; attempt++) {
        await wait(attempt * 3000);
        cached = (await ai.chat.get(request, { metadata: { model } })).usage?.text?.cached ?? 0;
      }
      expect(cached).toBeGreaterThan(1000);
    }, 120_000);
  }

  liveCase('bedrock cache points are dropped for models without caching', { sources: SOURCES, inputs: { model: GPT_OSS } }, async () => {
    const request: Request = { messages: [{ role: 'user', content: [{ type: 'text', content: 'Say hi.', cacheBreakpoint: true }] }], maxTokens: 50 };
    const response = await ai.chat.get(request, { metadata: { model: GPT_OSS } });
    expect(response.finishReason).toBeDefined();
    expect(JSON.stringify(lastSent().messages)).not.toContain('cachePoint');
  });

  liveCase('bedrock oversized input is a context window error', { sources: SOURCES, inputs: { model: NOVA_MICRO, chars: 300_000 } }, async () => {
    const big = Array.from({ length: 150_000 }, (_, i) => i % 10).join(' ');
    await expect(ai.chat.get({ messages: [{ role: 'user', content: big }], maxTokens: 5 }, { metadata: { model: NOVA_MICRO } }))
      .rejects.toBeInstanceOf(AWSContextWindowError);
  });

  // ==========================================================================
  // Claude thinking
  // ==========================================================================

  liveCase('bedrock claude 4.6 adaptive thinking returns signed summaries', { sources: SOURCES, inputs: { model: SONNET_4_6, effort: 'high' } }, async () => {
    const response = await ai.chat.get({ messages: [PRIME], maxTokens: 3000, reason: { effort: 'high' } }, { metadata: { model: SONNET_4_6 } });
    expect(lastSent()).toMatchObject({
      outputConfig: { effort: 'high' },
      additionalModelRequestFields: { thinking: { type: 'adaptive', display: 'summarized' } },
    });
    expect(response.reasoning?.content).toBeTruthy();
    expect(response.reasoning?.details?.[0]?.signature).toBeTruthy();
    expect(response.content).toContain('40');
  }, 120_000);

  // Claude 4.6 has no xhigh, so it's sent as high
  for (const [effort, exclude, expected] of [['xhigh', false, 'high'], ['low', true, 'low']] satisfies Array<[ReasoningEffort, boolean, ReasoningEffort]>) {
    liveCase(`bedrock claude 4.6 effort ${effort}${exclude ? ' omitted' : ''} is accepted`, { sources: SOURCES, inputs: { model: SONNET_4_6, effort, exclude } }, async () => {
      // Accepted when the stream starts without an error
      await firstChunk((signal) => ai.chat.stream({ messages: [PRIME], maxTokens: 2000, reason: { effort, exclude } }, { signal, metadata: { model: SONNET_4_6 } }));
      expect(lastSent()).toMatchObject({
        outputConfig: { effort: expected },
        additionalModelRequestFields: { thinking: { type: 'adaptive', display: exclude ? 'omitted' : 'summarized' } },
      });
    });
  }

  liveCase('bedrock claude 4.5 budget thinking is captured whole and streamed', { sources: SOURCES, inputs: { model: HAIKU_4_5, budget: 1024 } }, async () => {
    const request: Request = { messages: [PRIME], maxTokens: 2000, reason: { maxTokens: 1024 } };
    const whole = await ai.chat.get(request, { metadata: { model: HAIKU_4_5 } });
    const stream = await streamed(ai, request, HAIKU_4_5);
    expect(lastSent().additionalModelRequestFields).toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 } });
    for (const response of [whole, stream]) {
      expect(response.reasoning?.content).toBeTruthy();
      expect(response.reasoning?.details?.map(detail => !!detail.signature)).toEqual([true]);
    }
  }, 120_000);

  liveCase('bedrock claude 4.5 thinking replays its signature through the prompt loop', { sources: SOURCES, inputs: { model: HAIKU_4_5, scenario: 'replay prompt' } }, async () => {
    const roll = ai.tool({ ...DICE_TOOL, instructions: 'Use roll_dice to roll the house dice.', schema: DICE_COUNT, call: () => DICE_ROLL });
    const prompt = ai.prompt({ name: 'dice', description: 'Rolls dice', content: 'You roll dice for the user.', tools: [roll], config: { reason: { maxTokens: 1024 }, maxTokens: 2000 }, metadata: { model: HAIKU_4_5 } });
    const messages: Message[] = [];
    let output: string | undefined;
    for await (const event of prompt.get('stream', {}, { messages: [DICE_TASK] })) {
      if (event.type === 'message') {
        messages.push(event.message);
      }
      if (event.type === 'complete') {
        output = event.output;
      }
    }
    const call = messages.find(message => message.toolCalls?.length);
    expect(call?.reasoning?.details?.some(detail => detail.signature)).toBe(true);
    const replay = lastSent().messages?.find(message => message.content?.some(block => block.toolUse));
    expect(replay?.content?.[0]?.reasoningContent?.reasoningText?.signature).toBe(call?.reasoning?.details?.[0]?.signature);
    expect(output).toContain('17');
  }, 120_000);

  liveCase('bedrock claude 4.5 forced tool goes without thinking', { sources: SOURCES, inputs: { model: HAIKU_4_5, scenario: 'forced tool' } }, async () => {
    const response = await ai.chat.get({ messages: [DICE_TASK], tools: DICE, toolChoice: { tool: DICE_TOOL.name }, reason: { maxTokens: 1024 }, maxTokens: 300 }, { metadata: { model: HAIKU_4_5 } });
    expect(lastSent().additionalModelRequestFields).toEqual({ thinking: { type: 'disabled' } });
    expect(response.toolCalls?.[0]?.name).toBe(DICE_TOOL.name);
  });

  liveCase('bedrock claude redacted thinking is captured streamed and replayed', { sources: SOURCES, inputs: { model: HAIKU_4_5, scenario: 'redacted' } }, async () => {
    const task: Message = { role: 'user', content: `${REDACTED_TRIGGER}\n\n${DICE_TASK.content}` };
    const call = await streamed(ai, { messages: [task], tools: DICE, reason: { maxTokens: 1024 }, maxTokens: 2000 }, HAIKU_4_5);
    const redacted = call.reasoning?.details?.filter(detail => detail.type === 'reasoning.encrypted' && detail.data) ?? [];
    expect(redacted.length).toBeGreaterThan(0);
    expect(call.toolCalls?.length).toBeGreaterThan(0);
    const reply = await ai.chat.get({
      messages: [
        task,
        { role: 'assistant', content: call.content, toolCalls: call.toolCalls, reasoning: call.reasoning },
        ...(call.toolCalls ?? []).map((tc): Message => ({ role: 'tool', toolCallId: tc.id, content: DICE_ROLL })),
      ],
      tools: DICE,
      reason: { maxTokens: 1024 },
      maxTokens: 2000,
    }, { metadata: { model: HAIKU_4_5 } });
    const replayed = lastSent().messages?.flatMap(message => message.content ?? []).filter(block => block.reasoningContent?.redactedContent) ?? [];
    expect(replayed.length).toBe(redacted.length);
    expect(reply.content).toContain('17');
  }, 180_000);

  // ==========================================================================
  // Other reasoning models
  // ==========================================================================

  for (const [model, fields] of [
    [GPT_OSS, { reasoning_effort: 'low' }],
    [NEMOTRON, { reasoning_effort: 'low' }],
    [NOVA_2_LITE, { reasoningConfig: { type: 'enabled', maxReasoningEffort: 'low' } }],
  ] satisfies Array<[string, object]>) {
    liveCase(`bedrock ${model} takes low effort`, { sources: SOURCES, inputs: { model, effort: 'low' } }, async () => {
      const response = await ai.chat.get({ messages: [{ role: 'user', content: 'Is 391 prime? Answer yes or no.' }], maxTokens: 1000, reason: { effort: 'low' } }, { metadata: { model } });
      expect(lastSent().additionalModelRequestFields).toEqual(fields);
      expect(response.content || response.reasoning?.content).toBeTruthy();
      if (model !== NEMOTRON) {
        expect(response.reasoning?.content).toBeTruthy();
      }
    }, 120_000);
  }

  liveCase('bedrock deepseek-r1 reasoning is captured', { sources: SOURCES, inputs: { model: DEEPSEEK_R1 } }, async () => {
    const chunk = await firstChunk((signal) => ai.chat.stream({ messages: [{ role: 'user', content: 'Is 391 prime?' }], maxTokens: 200 }, { signal, metadata: { model: DEEPSEEK_R1 } }));
    expect(chunk?.reasoning?.content).toBeTruthy();
  });

  // ==========================================================================
  // Strict tools and structured output
  // ==========================================================================

  // Whether each fixture goes strict: recursion, open values and tuples, and
  // more than 24 optional or 16 union-typed parameters degrade to non-strict
  const strictness: Array<[string, z.ZodType<object, object>, boolean]> = [
    ['complex', fixtures.complex, false],
    ['complex-flat', fixtures.complex.omit({ category: true }), true],
    ['large-enum', fixtures['large-enum'], true],
    ['too-deep', fixtures['too-deep'], true],
    ['many-optional', fixtures['many-optional'], false],
    ['any-tuple', fixtures['any-tuple'], false],
    ['many-unions', manyUnions, false],
  ];
  for (const [fixture, schema, strict] of strictness) {
    for (const shape of ['strict-tool', 'output']) {
      liveCase(`bedrock claude ${shape} ${fixture} is accepted`, { sources: SOURCES, inputs: { model: HAIKU_4_5, shape, fixture, strict } }, async () => {
        const tool: ToolDefinition = { name: 'record', description: 'Record the result.', parameters: schema, strict: 1 };
        const request: Request = shape === 'output'
          ? { messages: [{ role: 'user', content: 'Reply.' }], responseFormat: { type: schema, strict: 1 }, maxTokens: 50 }
          : { messages: [{ role: 'user', content: 'Reply.' }], tools: [tool], toolChoice: 'required', maxTokens: 50 };
        // Accepted when the stream starts without an error; a strict schema's
        // first compile can take several seconds
        await firstChunk((signal) => ai.chat.stream(request, { signal, metadata: { model: HAIKU_4_5 } }));
        const input = lastSent();
        if (shape === 'output') {
          expect(!!input.outputConfig?.textFormat).toBe(strict);
        } else {
          expect(!!input.toolConfig?.tools?.[0]?.toolSpec?.strict).toBe(strict);
          expect(getDescriptorById(tool.descriptor).strict).toBe(strict);
        }
      }, 180_000);
    }
  }

  liveCase('bedrock claude structured output parses through a prompt', { sources: SOURCES, inputs: { model: HAIKU_4_5, scenario: 'structured prompt' } }, async () => {
    const prompt = ai.prompt({
      name: 'city',
      description: 'Names a city',
      content: 'Name the capital of France and its country code.',
      schema: z.object({ city: z.string(), code: z.enum(['FR', 'DE', 'ES']) }),
      config: { maxTokens: 100 },
      metadata: { model: HAIKU_4_5 },
    });
    const output = await prompt.get('result');
    expect(lastSent().outputConfig?.textFormat?.type).toBe('json_schema');
    expect(output).toEqual({ city: 'Paris', code: 'FR' });
  });
});
