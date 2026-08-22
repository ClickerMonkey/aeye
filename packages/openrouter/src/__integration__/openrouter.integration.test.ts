/**
 * OpenRouter Provider Integration Tests
 *
 * Tests that make REAL API calls to OpenRouter.
 * Requires OPENROUTER_API_KEY environment variable.
 */

import { OpenRouterProvider } from '../openrouter';
import type { Request } from '@aeye/ai';
import { z } from 'zod';
import { getAPIKey, skipIfNoAPIKey } from './setup';

const describeIntegration = skipIfNoAPIKey();

describeIntegration('OpenRouter Integration', () => {
  let provider: OpenRouterProvider;

  beforeAll(() => {
    provider = new OpenRouterProvider({
      apiKey: getAPIKey()
    });
  });

  describe('Model Listing', () => {
    it('should list real models from OpenRouter', async () => {
      const models = await provider.listModels!({
        apiKey: getAPIKey()
      });

      expect(models.length).toBeGreaterThan(0);

      console.log(`  Found ${models.length} models`);
      console.log(`  Sample: ${models.slice(0, 5).map(m => m.id).join(', ')}`);
    }, 30000);

    it('should include models from multiple providers', async () => {
      const models = await provider.listModels!({
        apiKey: getAPIKey()
      });

      // OpenRouter aggregates models from multiple providers
      const providers = new Set(models.map(m => m.id.split('/')[0]));

      expect(providers.size).toBeGreaterThan(1);

      console.log(`  Model providers: ${Array.from(providers).slice(0, 5).join(', ')}`);
    }, 30000);

    it('should include model pricing', async () => {
      const models = await provider.listModels!({
        apiKey: getAPIKey()
      });

      const modelsWithPricing = models.filter(m =>
        (m.pricing.text?.input || 0) > 0 || (m.pricing.text?.output || 0) > 0
      );

      expect(modelsWithPricing.length).toBeGreaterThan(0);

      console.log(`  Models with pricing: ${modelsWithPricing.length}/${models.length}`);
    }, 30000);
  });

  describe('Health Check', () => {
    it('should pass health check', async () => {
      const isHealthy = await provider.checkHealth!();

      expect(isHealthy).toBe(true);
    }, 30000);
  });

  describe('Chat Completion', () => {
    it('should complete a simple chat with a free model', async () => {
      const executor = provider.createExecutor();

      const request: Request = {
        messages: [
          {
            role: 'user',
            content: 'Reply with exactly: "Test successful"'
          }
        ]
      };

      // Use a free model to avoid charges
      const response = await executor(request, {}, { model: 'google/gemini-flash-1.5' });

      expect(response.content).toBeTruthy();
      expect(typeof response.content).toBe('string');
      expect(response.finishReason).toBeTruthy();
      expect(response.usage).toBeDefined();

      console.log(`  Response: ${response.content}`);
      const totalTokens = (response.usage?.text?.input || 0) + (response.usage?.text?.output || 0);
      console.log(`  Tokens: ${totalTokens}`);
    }, 30000);

    it('should stream chat completion', async () => {
      const streamer = provider.createStreamer();

      const request: Request = {
        messages: [
          {
            role: 'user',
            content: 'Count from 1 to 3'
          }
        ]
      };

      const chunks: string[] = [];
      let finalUsage: any = null;

      for await (const chunk of streamer(request, {}, { model: 'google/gemini-flash-1.5' })) {
        if (chunk.content) {
          chunks.push(chunk.content as string);
        }
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }
      }

      expect(chunks.length).toBeGreaterThan(0);

      const fullText = chunks.join('');
      console.log(`  Received ${chunks.length} chunks`);
      console.log(`  Full response: ${fullText}`);
    }, 30000);

    it('should use model from context metadata', async () => {
      const executor = provider.createExecutor();

      const request: Request = {
        messages: [
          {
            role: 'user',
            content: 'Say "hi"'
          }
        ]
      };

      const ctx = {
        metadata: {
          model: 'google/gemini-flash-1.5'
        }
      };

      const response = await executor(request, ctx as any, {});

      expect(response.content).toBeTruthy();
      console.log(`  Used model from context`);
      console.log(`  Response: ${response.content}`);
    }, 30000);

    it('should work with different model providers on OpenRouter', async () => {
      const executor = provider.createExecutor();

      // Test models from different providers available on OpenRouter
      const testModels = [
        'google/gemini-flash-1.5',
        'meta-llama/llama-3.2-3b-instruct:free'
      ];

      for (const model of testModels) {
        try {
          const response = await executor(
            { messages: [{ role: 'user', content: 'Hi' }] },
            {},
            { model }
          );

          expect(response.content).toBeTruthy();
          console.log(`  ${model}: ✓`);
        } catch (error) {
          console.log(`  ${model}: ✗ (${(error as Error).message})`);
        }
      }
    }, 60000);
  });

  describe('Model Selection', () => {
    it('should find free models', async () => {
      const models = await provider.listModels!({
        apiKey: getAPIKey()
      });

      const freeModels = models.filter(m =>
        m.pricing.text?.input! && !m.pricing.text?.output
      );

      expect(freeModels.length).toBeGreaterThan(0);

      console.log(`  Free models: ${freeModels.length}`);
      console.log(`  Examples: ${freeModels.slice(0, 3).map(m => m.id).join(', ')}`);
    }, 30000);

    it('should find models with vision capability', async () => {
      const models = await provider.listModels!({
        apiKey: getAPIKey()
      });

      const visionModels = models.filter(m => m.capabilities.has('vision'));

      if (visionModels.length > 0) {
        console.log(`  Vision models: ${visionModels.length}`);
        console.log(`  Examples: ${visionModels.slice(0, 3).map(m => m.id).join(', ')}`);
        expect(visionModels.length).toBeGreaterThan(0);
      } else {
        console.log(`  No vision models detected (may need API update)`);
      }
    }, 30000);
  });

  describe('Error Handling', () => {
    it('should handle invalid model', async () => {
      const executor = provider.createExecutor();

      const request: Request = {
        messages: [{ role: 'user', content: 'Test' }]
      };

      await expect(
        executor(request, {}, { model: 'invalid/model/name' })
      ).rejects.toThrow();
    }, 30000);

    it('should handle rate limiting gracefully', async () => {
      const executor = provider.createExecutor();

      const request: Request = {
        messages: [{ role: 'user', content: 'Hi' }]
      };

      // Make multiple rapid requests using free model
      const promises = Array(3).fill(null).map(() =>
        executor(request, {}, { model: 'google/gemini-flash-1.5' })
      );

      // At least some should succeed
      const results = await Promise.allSettled(promises);
      const succeeded = results.filter(r => r.status === 'fulfilled').length;

      expect(succeeded).toBeGreaterThan(0);

      console.log(`  ${succeeded}/3 requests succeeded`);
    }, 60000);
  });

  describe('Cost Comparison', () => {
    it('should show cost range across available models', async () => {
      const models = await provider.listModels!({
        apiKey: getAPIKey()
      });

      const paidModels = models.filter(m =>
        (m.pricing.text?.input || 0) > 0 || (m.pricing.text?.output || 0) > 0
      );

      if (paidModels.length > 0) {
        // Find cheapest and most expensive
        paidModels.sort((a, b) =>
          ((a.pricing.text?.input || 0) + (a.pricing.text?.output || 0)) -
          ((b.pricing.text?.input || 0) + (b.pricing.text?.output || 0))
        );

        const cheapest = paidModels[0];
        const mostExpensive = paidModels[paidModels.length - 1];

        console.log(`  Cheapest: ${cheapest.id}`);
        console.log(`    $${cheapest.pricing.text?.input}/M input, $${cheapest.pricing.text?.output}/M output`);
        console.log(`  Most expensive: ${mostExpensive.id}`);
        console.log(`    $${mostExpensive.pricing.text?.input}/M input, $${mostExpensive.pricing.text?.output}/M output`);

        expect(paidModels.length).toBeGreaterThan(0);
      }
    }, 30000);
  });
});

/**
 * LIVE verification of the Google tool-schema fix (schema.ts `GOOGLE_STRICT`/
 * `GOOGLE_NON_STRICT` `anyEncoding: 'unconstrained'`, and this provider's
 * `supportedStrictFamilies` now including `'google'`). The unit suite
 * (`__tests__/openrouter.test.ts`, `describe('OpenRouterProvider tool schema
 * dialects')`) proves the WIRE SHAPE is keyword-clean; it cannot prove Gemini's
 * own function-calling grammar compiler actually ACCEPTS that shape — only a
 * real request against the real model can. `toolChoice: 'required'` is the
 * trigger throughout (Google's function-calling mode `ANY`, which is what
 * compiles the tool schemas into a decoding grammar in the first place — under
 * `'auto'` no grammar is built and the pre-fix shape never 400s).
 *
 * `google/gemini-3-flash-preview` specifically, matching the curated
 * `strictSupport` pattern (`^google\/gemini-(2\.0|2\.5|3|3\.1)`) and the exact
 * model the reported regression was measured against — a cheaper/older Gemini
 * could easily behave differently.
 */
describeIntegration('OpenRouter — Google tool-schema fix (live)', () => {
  let provider: OpenRouterProvider;
  const model = 'google/gemini-3-flash-preview';

  beforeAll(() => {
    provider = new OpenRouterProvider({ apiKey: getAPIKey() });
  });

  /** The exact `[kind]_signature` shape from the reported 400 (product's
   *  `api_agent`/`code_agent`/etc.): a named field alongside an open TypeDef —
   *  `z.any()` is the case `GOOGLE_STRICT.anyEncoding` was fixed for. */
  const signatureTool = {
    name: 'api_signature',
    description: 'Declare the signature of the API function.',
    parameters: z.object({
      signature: z.object({ name: z.string() })
        .catchall(z.any())
        .describe('The signature of the API function being declared.'),
    }),
    strict: 1,
  };

  /** A genuinely nested/multi-level schema with NO "any" and NO union — arrays
   *  of objects, an enum, an optional field — the "complex but expressible"
   *  case that was never broken. Included so a live failure here would mean a
   *  DIFFERENT regression, not the one this fix targets. */
  const complexTool = {
    name: 'file_ticket',
    description: 'File a support ticket with structured fields.',
    parameters: z.object({
      title: z.string(),
      priority: z.enum(['low', 'medium', 'high']),
      labels: z.array(z.string()),
      assignee: z.optional(z.string()),
      steps: z.array(z.object({
        description: z.string(),
        completed: z.boolean(),
      })),
    }),
    strict: 1,
  };

  /** A `z.union(...)` argument — the ONE case the fix's own report flags as a
   *  KNOWN, still-open gap ("Tool schemas never consult `canExpress`... a
   *  `z.union(...)` in a Google tool still emits `anyOf` despite
   *  `allowAnyOf: false`"). This is diagnostic, not a regression guard: it
   *  logs the real outcome rather than asserting one, so this suite stays
   *  green regardless and the log is what tells Phil whether that gap is
   *  still live against the real API. */
  const unionTool = {
    name: 'set_contact_method',
    description: 'Record how to reach the requester.',
    parameters: z.object({
      contact: z.union([
        z.object({ kind: z.literal('email'), address: z.string() }),
        z.object({ kind: z.literal('phone'), number: z.string() }),
      ]),
    }),
    strict: 1,
  };

  it('an "Any"-typed tool argument, FORCED, does not 400 — the reported regression, fixed', async () => {
    const executor = provider.createExecutor();
    const request: Request = {
      messages: [{ role: 'user', content: 'Declare a signature with one field "id" of type text.' }],
      tools: [{ ...signatureTool }],
      toolChoice: 'required',
    };

    const response = await executor(request, {}, { model });

    expect(response.finishReason).toBeTruthy();
    expect(response.toolCalls?.length ?? 0).toBeGreaterThan(0);
    console.log(`  tool_choice:required + Any-typed arg → ${response.toolCalls?.length} call(s), finishReason=${response.finishReason}`);
  }, 30000);

  it('a complex multi-level object argument, FORCED, does not 400', async () => {
    const executor = provider.createExecutor();
    const request: Request = {
      messages: [{ role: 'user', content: 'File a high-priority ticket titled "Printer on fire" with one step: "unplug it", not yet completed.' }],
      tools: [{ ...complexTool }],
      toolChoice: 'required',
    };

    const response = await executor(request, {}, { model });

    expect(response.finishReason).toBeTruthy();
    expect(response.toolCalls?.length ?? 0).toBeGreaterThan(0);
    console.log(`  tool_choice:required + nested object arg → ${response.toolCalls?.length} call(s), finishReason=${response.finishReason}`);
  }, 30000);

  it('DIAGNOSTIC (not a regression guard): a z.union(...) tool argument, FORCED — logs whether the known unaddressed gap still 400s live', async () => {
    const executor = provider.createExecutor();
    const request: Request = {
      messages: [{ role: 'user', content: 'Record that they reached out by email at test@example.com.' }],
      tools: [{ ...unionTool }],
      toolChoice: 'required',
    };

    try {
      const response = await executor(request, {}, { model });
      console.log(`  UNION TOOL SUCCEEDED (unexpected — the flagged gap may not be live for this shape): ${response.toolCalls?.length} call(s)`);
    } catch (error) {
      console.log(`  UNION TOOL FAILED as the fix's own report predicted (known gap, not covered by this change): ${(error as Error).message}`);
    }
    // No assertion — this test exists to OBSERVE, not to gate. Both outcomes are informative.
    expect(true).toBe(true);
  }, 30000);
});
