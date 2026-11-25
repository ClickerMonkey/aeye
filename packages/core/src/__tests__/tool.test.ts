/**
 * Tool Tests
 *
 * Tests for the Tool component including schema validation, execution, and error handling.
 */

import { a } from '@aeye/schema';
import { describeTool, forcesTool, Tool, withAllowedTools } from '../tool';
import { planRequest, TEXT_TOOL_SCHEMA } from '../schema';
import type { Context, Request, ToolTextFormat } from '../types';

// ---- Type-level assertion helpers -----------------------------------------
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

describe('Tool', () => {
  describe('Construction', () => {
    it('should create a tool with required fields', () => {
      const tool = new Tool({
        name: 'test-tool',
        description: 'A test tool',
        instructions: 'Use this tool for testing',
        schema: a.object({ value: a.number() }),
        call: (input) => input.value * 2
      });

      expect(tool.name).toBe('test-tool');
      expect(tool.description).toBe('A test tool');
      expect(tool.kind).toBe('tool');
    });

    it('should accept refs to other components', () => {
      const dependency = new Tool({
        name: 'dependency',
        description: 'Dependency tool',
        instructions: 'A dependency',
        schema: a.object({}),
        call: () => 'dep-result'
      });

      const tool = new Tool({
        name: 'main-tool',
        description: 'Main tool',
        instructions: 'Main tool',
        schema: a.object({}),
        refs: [dependency],
        call: (input, refs) => {
          return `Used ${refs[0].name}`;
        }
      });

      expect(tool.refs).toHaveLength(1);
      expect(tool.refs[0].name).toBe('dependency');
    });
  });

  describe('Schema Validation', () => {
    it('should parse valid input', async () => {
      const tool = new Tool({
        name: 'calculator',
        description: 'Calculates things',
        instructions: 'Use for math',
        schema: a.object({
          operation: a.enum(['add', 'subtract']),
          a: a.number(),
          b: a.number()
        }),
        call: (input) => {
          return input.operation === 'add' ? input.a + input.b : input.a - input.b;
        }
      });

      const ctx = {} as Context<{}, {}>;
      const args = JSON.stringify({ operation: 'add', a: 5, b: 3 });

      const parsed = await tool.parse(ctx, args);

      expect(parsed).toEqual({ operation: 'add', a: 5, b: 3 });
    });

    it('should reject invalid input', async () => {
      const tool = new Tool({
        name: 'validator',
        description: 'Validates input',
        instructions: 'Strict validation',
        schema: a.object({ value: a.number().positive() }),
        call: (input) => input.value
      });

      const ctx = {} as Context<{}, {}>;
      const invalidArgs = JSON.stringify({ value: -5 });

      await expect(tool.parse(ctx, invalidArgs)).rejects.toThrow();
    });

    it('should handle malformed JSON', async () => {
      const tool = new Tool({
        name: 'json-tool',
        description: 'Requires JSON',
        instructions: 'JSON only',
        schema: a.object({ data: a.string() }),
        call: (input) => input.data
      });

      const ctx = {} as Context<{}, {}>;
      const malformedArgs = '{ invalid json }';

      await expect(tool.parse(ctx, malformedArgs)).rejects.toThrow();
    });

    it('should repair string-encoded top-level object fields (Claude Sonnet 4.x workaround)', async () => {
      // Claude Sonnet 4.x has been observed JSON-stringifying nested
      // object args when the structured tool call grows large. Core
      // detects that on schema-rejection and JSON.parses any
      // top-level string field that looks like JSON, retrying the
      // schema once before giving up.
      const tool = new Tool({
        name: 'inner-obj',
        description: 'Takes a nested obj',
        instructions: 'Pass program as an object',
        schema: a.object({
          program: a.object({ kind: a.string(), value: a.number() }),
        }),
        call: (input) => input.program.value,
      });
      const ctx = {} as Context<{}, {}>;

      // Model sent `program` as a JSON-encoded string. After core's
      // initial JSON.parse, program is the inner string.
      const doubleEncoded = JSON.stringify({
        program: JSON.stringify({ kind: 'new', value: 42 }),
      });
      const repairs: Array<{ fields: ReadonlyArray<string>; success: boolean }> = [];
      const parsed = await tool.parse(
        ctx, doubleEncoded, undefined,
        (info) => repairs.push({ fields: [...info.fields], success: info.success }),
      );
      expect(parsed.program).toEqual({ kind: 'new', value: 42 });
      expect(repairs).toEqual([{ fields: ['program'], success: true }]);
    });

    it('should NOT fire repair for already-valid object args', async () => {
      const tool = new Tool({
        name: 'normal',
        description: 'Normal usage',
        instructions: '',
        schema: a.object({ payload: a.object({ x: a.number() }) }),
        call: (input) => input.payload.x,
      });
      const ctx = {} as Context<{}, {}>;
      const repairs: Array<{ fields: ReadonlyArray<string>; success: boolean }> = [];
      const parsed = await tool.parse(
        ctx, JSON.stringify({ payload: { x: 7 } }), undefined,
        (info) => repairs.push({ fields: [...info.fields], success: info.success }),
      );
      expect(parsed.payload.x).toBe(7);
      expect(repairs).toEqual([]);
    });

    it('should reject pre-parse when args exceed maxArgsLength', async () => {
      // Pre-parse hard cap: shields the schema parse from wire-
      // corrupted payloads. The error names the size, gives the cap,
      // and tells the model to split the work — never mentions
      // "parse" since the rejection happens before any parsing.
      const tool = new Tool({
        name: 'capped',
        description: 'Has an args size cap',
        instructions: '',
        schema: a.object({ payload: a.string() }),
        call: (input) => input.payload.length,
        maxArgsLength: 100,
      });
      const ctx = {} as Context<{}, {}>;
      const big = JSON.stringify({ payload: 'x'.repeat(200) });
      await expect(tool.parse(ctx, big)).rejects.toThrow(/exceeded the configured size limit/);
      await expect(tool.parse(ctx, big)).rejects.toThrow(/find_or_create_functions/);
      // Stays under the cap → normal parse path.
      const small = JSON.stringify({ payload: 'x'.repeat(10) });
      const parsed = await tool.parse(ctx, small);
      expect(parsed.payload.length).toBe(10);
    });

    it('should signal repair-failed AND throw a targeted error when inner JSON is malformed', async () => {
      // Real-world failure mode (Claude Sonnet 4.5 over OpenRouter):
      // the model double-encodes `program` AND the inner JSON itself
      // is broken (mismatched brackets / truncation). Repair detects
      // the encoding attempt but the inner JSON.parse fails, so the call
      // fails with the schema echo pointing at the field.
      const tool = new Tool({
        name: 'big-prog',
        description: 'Takes a program',
        instructions: '',
        schema: a.object({
          program: a.object({ kind: a.string() }),
        }),
        call: (input) => input.program.kind,
      });
      const ctx = {} as Context<{}, {}>;
      // Outer envelope is valid JSON; the inner program field is a
      // JSON-encoded string but the encoded content is malformed
      // (extra closing bracket).
      const malformedDoubleEncoded = JSON.stringify({
        program: '{"kind": "block", "lines": []]}',
      });
      const repairs: Array<{ fields: ReadonlyArray<string>; success: boolean }> = [];
      let thrownMessage = '';
      try {
        await tool.parse(ctx, malformedDoubleEncoded, undefined,
          (info) => repairs.push({ fields: [...info.fields], success: info.success }));
      } catch (e: any) {
        thrownMessage = e.message;
      }
      expect(repairs).toEqual([{ fields: ['program'], success: false }]);
      // Targeted message: names the field, calls out the JSON text that
      // doesn't parse, tells the model to send the value itself.
      expect(thrownMessage).toContain('1 problem in the arguments of big-prog');
      expect(thrownMessage).toContain('program: Expected an object, got a string of JSON text');
      expect(thrownMessage).toContain('send the value itself, not as a string');
    });

    it('should surface the original error when repair candidate also fails (and signal repair-failed)', async () => {
      const tool = new Tool({
        name: 'strict',
        description: 'Strict numeric',
        instructions: '',
        schema: a.object({ payload: a.object({ x: a.number() }) }),
        call: (input) => input.payload.x,
      });
      const ctx = {} as Context<{}, {}>;
      // String-encoded but the inner object is also wrong shape.
      const bad = JSON.stringify({
        payload: JSON.stringify({ x: 'not-a-number' }),
      });
      const repairs: Array<{ fields: ReadonlyArray<string>; success: boolean }> = [];
      await expect(
        tool.parse(ctx, bad, undefined,
          (info) => repairs.push({ fields: [...info.fields], success: info.success })),
      ).rejects.toThrow();
      // Repair WAS attempted (visibility into model misbehavior) — but
      // it failed, so success=false. Caller sees the original schema
      // error AND knows repair was tried.
      expect(repairs).toEqual([{ fields: ['payload'], success: false }]);
    });

    it('should use custom validation', async () => {
      const tool = new Tool({
        name: 'custom-validator',
        description: 'Has custom validation',
        instructions: 'Custom rules',
        schema: a.object({ email: a.string().format('email') }),
        validate: async (input) => {
          if (input.email.endsWith('@blocked.com')) {
            throw new Error('Domain blocked');
          }
        },
        call: (input) => `Validated: ${input.email}`
      });

      const ctx = {} as Context<{}, {}>;

      // Should pass schema validation but fail custom validation
      const blockedArgs = JSON.stringify({ email: 'user@blocked.com' });
      await expect(tool.parse(ctx, blockedArgs)).rejects.toThrow('Domain blocked');

      // Should pass both validations
      const validArgs = JSON.stringify({ email: 'user@allowed.com' });
      const parsed = await tool.parse(ctx, validArgs);
      expect(parsed.email).toBe('user@allowed.com');
    });
  });

  describe('Custom parse (deprecated hook)', () => {
    // The optional `parse` hook owns the arguments: it gets the decoded
    // value when it fits the schema, the raw value otherwise, and its Error
    // is what the model is told. The pipeline is JSON.parse → decode →
    // parse → validate. Lets a caller (e.g. @aeye/query) surface concise,
    // compiler-style errors with source underlines.

    it('should use the custom parser even when the schema rejects the args', async () => {
      // The schema would REJECT this shape (requires { value: number }),
      // but the custom parser gets the raw value and produces its own
      // typed result, so parse succeeds.
      const tool = new Tool<{}, {}, string, { value: number }, number>({
        name: 'byo-parser',
        description: 'Bring your own parser',
        instructions: '',
        schema: a.object({ value: a.number() }),
        parse: (raw) => {
          const r = raw as { n?: unknown };
          return { value: Number(r.n) };
        },
        call: (input) => input.value,
      });
      const ctx = {} as Context<{}, {}>;
      // Shape the schema would reject ({ n: "5" } has no numeric `value`).
      const parsed = await tool.parse(ctx, JSON.stringify({ n: '5' }));
      expect(parsed).toEqual({ value: 5 });
    });

    it('should short-circuit with a returned Error and NOT surface schema errors', async () => {
      const tool = new Tool<{}, {}, string, { value: number }, number>({
        name: 'byo-error-return',
        description: 'Custom parser returns rich error',
        instructions: '',
        schema: a.object({ value: a.number() }),
        parse: () => new Error('nice compiler-style error ^^^ here'),
        call: (input) => input.value,
      });
      const ctx = {} as Context<{}, {}>;
      let msg = '';
      try {
        await tool.parse(ctx, JSON.stringify({ value: 1 }));
      } catch (e: any) {
        msg = e.message;
      }
      expect(msg).toBe('nice compiler-style error ^^^ here');
      // The schema's message vocabulary must not appear.
      expect(msg).not.toMatch(/expected|problem|zod/i);
    });

    it('should propagate a rich caller-supplied Error subclass (thrown)', async () => {
      // Mirrors how @aeye/query throws a QueryTypeError carrying a
      // structured Problem alongside the rendered message.
      class RichError extends Error {
        constructor(message: string, readonly problems: Array<{ code: string }>) {
          super(message);
          this.name = 'RichError';
        }
      }
      const tool = new Tool<{}, {}, string, { value: number }, number>({
        name: 'byo-rich',
        description: 'Custom parser throws rich error',
        instructions: '',
        schema: a.object({ value: a.number() }),
        parse: () => {
          throw new RichError('underlined error', [{ code: 'field-type.unknown' }]);
        },
        call: (input) => input.value,
      });
      const ctx = {} as Context<{}, {}>;
      let caught: any;
      try {
        await tool.parse(ctx, JSON.stringify({ value: 1 }));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RichError);
      expect(caught.problems).toEqual([{ code: 'field-type.unknown' }]);
    });

    it('should still run the post-validate hook after custom parse', async () => {
      const tool = new Tool<{}, {}, string, { value: number }, number>({
        name: 'byo-validate',
        description: 'Custom parser + validate',
        instructions: '',
        schema: a.object({ value: a.number() }),
        parse: (raw) => ({ value: (raw as { value: number }).value }),
        validate: (input) => {
          if (input.value < 0) throw new Error('must be non-negative');
        },
        call: (input) => input.value,
      });
      const ctx = {} as Context<{}, {}>;
      await expect(tool.parse(ctx, JSON.stringify({ value: -1 }))).rejects.toThrow('must be non-negative');
      const parsed = await tool.parse(ctx, JSON.stringify({ value: 3 }));
      expect(parsed).toEqual({ value: 3 });
    });

    it('without a parse option the schema decodes and rejects', async () => {
      const tool = new Tool<{}, {}, string, { value: number }, number>({
        name: 'no-byo',
        description: 'Default schema path',
        instructions: '',
        schema: a.object({ value: a.number() }),
        call: (input) => input.value,
      });
      const ctx = {} as Context<{}, {}>;
      // Valid → the schema accepts.
      expect(await tool.parse(ctx, JSON.stringify({ value: 9 }))).toEqual({ value: 9 });
      // Invalid → the schema rejects, with the model-facing echo.
      await expect(tool.parse(ctx, JSON.stringify({ value: 'nope' }))).rejects.toThrow(/value: Expected a number, got string/);
    });

    it('should drive the DECODED type from parse\'s return type (class instance)', async () => {
      // A custom `parse` that builds a class instance. The `schema`
      // stays the WIRE shape ({ value: number }); `parse` turns the raw
      // wire value into a `Built`. Per the `TDecoded` generic, the handler
      // `call` (and `validate`) must receive the DECODED `Built`, not the
      // wire shape.
      class Built {
        constructor(readonly value: number) {}
        doubled(): number {
          return this.value * 2;
        }
      }

      let seenInValidate: unknown;
      let seenInCall: unknown;

      // No explicit generics: `TParams` infers from `schema` (the wire
      // shape), and `TDecoded` infers from `parse`'s return type (`Built`).
      // (TypeScript does not do partial type-argument inference, so proving
      // inference requires omitting the generics entirely.)
      const tool = new Tool({
        name: 'decoded-class',
        description: 'parse returns a class instance',
        instructions: '',
        schema: a.object({ value: a.number() }),
        parse: (raw) => new Built(Number((raw as { value: number }).value)),
        validate: (input) => {
          // Compile-time: `input` is `Built` (has `doubled`), not `{ value }`.
          seenInValidate = input.doubled();
        },
        // Compile-time: `input` is `Built`; calling `doubled()` type-checks.
        call: (input) => {
          seenInCall = input;
          return input.doubled();
        },
      });

      const ctx = {} as Context<{}, {}>;

      // parse() yields the decoded class instance at runtime.
      const parsed = await tool.parse(ctx, JSON.stringify({ value: 21 }));
      expect(parsed).toBeInstanceOf(Built);
      expect(seenInValidate).toBe(42);

      // run() feeds the decoded instance to the handler.
      const result = await tool.run(new Built(21), ctx);
      expect(result).toBe(42);
      expect(seenInCall).toBeInstanceOf(Built);

      // Type-level: assigning to the decoded type must compile; assigning
      // the wire shape to `Built` must NOT (guards against regressions).
      const decoded: Built = new Built(1);
      expect(decoded.doubled()).toBe(2);
      // @ts-expect-error — the wire shape is not assignable to the decoded type.
      const bad: Built = { value: 1 };
      void bad;
    });

    it('should allow a custom parse that decodes to a PRIMITIVE (number)', async () => {
      // The widened `TDecoded extends unknown` constraint lets a custom
      // `parse` return a non-object. Here `parse` collapses the wire shape
      // to a bare `number`; `call` must therefore receive a `number`.
      let seenInCall: unknown;

      // No explicit generics: `TParams` infers from `schema` (the wire
      // shape), `TDecoded` infers from `parse`'s return type (`number`).
      const tool = new Tool({
        name: 'decoded-number',
        description: 'parse returns a bare number',
        instructions: '',
        schema: a.object({ value: a.number() }),
        parse: (raw) => (raw as { value: number }).value + 1,
        call: (input) => {
          // Type-level: `input` is exactly `number`, not the wire object.
          type _CallArgIsNumber = Expect<Equal<typeof input, number>>;
          seenInCall = input;
          return input * 10;
        },
      });

      const ctx = {} as Context<{}, {}>;

      // parse() yields the decoded primitive at runtime.
      const parsed = await tool.parse(ctx, JSON.stringify({ value: 41 }));
      expect(parsed).toBe(42);

      // run() feeds the decoded number straight to the handler.
      const result = await tool.run(42, ctx);
      expect(result).toBe(420);
      expect(seenInCall).toBe(42);
    });

    it('should allow a custom parse that decodes to an ARRAY', async () => {
      // Another non-object decoded type: an array. Proves the widening is
      // not special-cased to primitives.
      const tool = new Tool({
        name: 'decoded-array',
        description: 'parse returns an array',
        instructions: '',
        schema: a.object({ csv: a.string() }),
        parse: (raw) => (raw as { csv: string }).csv.split(',').map(Number),
        call: (input) => {
          // Type-level: `input` is `number[]`.
          type _CallArgIsNumberArray = Expect<Equal<typeof input, number[]>>;
          return input.reduce((a, b) => a + b, 0);
        },
      });

      const ctx = {} as Context<{}, {}>;
      const parsed = await tool.parse(ctx, JSON.stringify({ csv: '1,2,3' }));
      expect(parsed).toEqual([1, 2, 3]);
      const result = await tool.run([1, 2, 3], ctx);
      expect(result).toBe(6);
    });
  });

  describe('Execution', () => {
    it('should execute successfully', async () => {
      const tool = new Tool({
        name: 'multiply',
        description: 'Multiplies numbers',
        instructions: 'Multiply two numbers',
        schema: a.object({ a: a.number(), b: a.number() }),
        call: (input) => input.a * input.b
      });

      const ctx = {} as Context<{}, {}>;
      const result = await tool.run({ a: 6, b: 7 }, ctx);

      expect(result).toBe(42);
    });

    it('should pass context to call function', async () => {
      const tool = new Tool({
        name: 'context-reader',
        description: 'Reads context',
        instructions: 'Accesses context',
        schema: a.object({ key: a.string() }),
        call: (input, refs, ctx: any) => {
          return `${input.key}: ${ctx.userId}`;
        }
      });

      const ctx = { userId: 'user-123' } as Context<{}, {}>;
      const result = await tool.run({ key: 'id' }, ctx);

      expect(result).toBe('id: user-123');
    });

    it('should pass refs to call function', async () => {
      const helperTool = new Tool({
        name: 'helper',
        description: 'Helper tool',
        instructions: 'Helps',
        schema: a.object({}),
        call: () => 'helper-result'
      });

      const mainTool = new Tool({
        name: 'main',
        description: 'Main tool',
        instructions: 'Uses helper',
        schema: a.object({}),
        refs: [helperTool],
        call: async (input, refs, ctx) => {
          const helperResult = await refs[0].run({}, ctx);
          return `Main used: ${helperResult}`;
        }
      });

      const ctx = {} as Context<{}, {}>;
      const result = await mainTool.run({}, ctx);

      expect(result).toBe('Main used: helper-result');
    });

    it('should handle async execution', async () => {
      const tool = new Tool({
        name: 'async-tool',
        description: 'Async operations',
        instructions: 'Waeye',
        schema: a.object({ delay: a.number() }),
        call: async (input) => {
          await new Promise(resolve => setTimeout(resolve, input.delay));
          return `Waited ${input.delay}ms`;
        }
      });

      const ctx = {} as Context<{}, {}>;
      const result = await tool.run({ delay: 10 }, ctx);

      expect(result).toBe('Waited 10ms');
    });
  });

  describe('Error Handling', () => {
    it('should propagate execution errors', async () => {
      const tool = new Tool({
        name: 'error-tool',
        description: 'Throws errors',
        instructions: 'Will fail',
        schema: a.object({}),
        call: () => {
          throw new Error('Execution failed');
        }
      });

      const ctx = {} as Context<{}, {}>;

      expect(() => tool.run({}, ctx)).toThrow('Execution failed');
    });
  });

  describe('Definition Generation', () => {
    it('should compile tool definition for AI', async () => {
      const tool = new Tool({
        name: 'weather',
        description: 'Get weather information',
        instructions: 'Use this to get weather for location',
        schema: a.object({
          location: a.string().describe('The city name'),
          unit: a.enum(['celsius', 'fahrenheit']).optional()
        }),
        call: (input) => `Weather for ${input.location}`
      });

      const ctx = {} as Context<{}, {}>;
      const compiled = await tool.compile(ctx);

      expect(compiled).toBeDefined();
      const [instructions, definition] = compiled!;

      expect(instructions).toContain('Use this to get weather for location');
      expect(definition.name).toBe('weather');
      expect(definition.description).toBe('Get weather information');
      expect(definition.parameters).toBeDefined();
    });

    it('should include instructions with template variables', async () => {
      const tool = new Tool({
        name: 'calculator',
        description: 'Calculate',
        instructions: 'Perform {{operation}} on the numbers',
        input: () => ({ operation: 'addition' }),
        schema: a.object({ a: a.number(), b: a.number() }),
        call: (input) => input.a + input.b
      });

      const ctx = {} as Context<{}, {}>;
      const compiled = await tool.compile(ctx);

      expect(compiled).toBeDefined();
      const [instructions] = compiled!;
      expect(instructions).toContain('Perform addition on the numbers');
    });
  });

  describe('Applicability', () => {
    it('should be applicable when schema is available and no refs', async () => {
      const tool = new Tool({
        name: 'always-available',
        description: 'Always available',
        instructions: 'Always works',
        schema: a.object({}),
        call: () => 'result'
      });

      const ctx = {} as Context<{}, {}>;
      const applicable = await tool.applicable(ctx);

      // With no refs and schema available, should be applicable (self-contained tool)
      expect(applicable).toBe(true);
    });

    it('should be applicable with custom applicability returning true', async () => {
      const tool = new Tool({
        name: 'custom-applicable',
        description: 'Custom check',
        instructions: 'Custom',
        schema: a.object({}),
        applicable: () => true,
        call: () => 'result'
      });

      const ctx = {} as Context<{}, {}>;
      const applicable = await tool.applicable(ctx);

      expect(applicable).toBe(true);
    });

    it('should respect custom applicability', async () => {
      const tool = new Tool({
        name: 'conditional',
        description: 'Conditionally available',
        instructions: 'Sometimes works',
        schema: a.object({}),
        applicable: (ctx: any) => ctx.hasPermission === true,
        call: () => 'result'
      });

      const allowedCtx = { hasPermission: true } as Context<{}, {}>;
      const deniedCtx = { hasPermission: false } as Context<{}, {}>;

      expect(await tool.applicable(allowedCtx)).toBe(true);
      expect(await tool.applicable(deniedCtx)).toBe(false);
    });

    it('should support async applicability checks', async () => {
      const tool = new Tool({
        name: 'async-check',
        description: 'Async check',
        instructions: 'Async',
        schema: a.object({}),
        applicable: async (ctx: any) => {
          // Simulate async check (e.g., database query)
          await new Promise(resolve => setTimeout(resolve, 10));
          return ctx.userId === 'admin';
        },
        call: () => 'admin-only-result'
      });

      const adminCtx = { userId: 'admin' } as Context<{}, {}>;
      const userCtx = { userId: 'user' } as Context<{}, {}>;

      expect(await tool.applicable(adminCtx)).toBe(true);
      expect(await tool.applicable(userCtx)).toBe(false);
    });

    it('should return false when applicable says no', async () => {
      const tool = new Tool({
        name: 'no-schema',
        description: 'No schema',
        instructions: 'Instructions',
        schema: a.object({}),
        applicable: () => false,
        call: () => 'result'
      });

      const ctx = {} as Context<{}, {}>;
      const applicable = await tool.applicable(ctx);

      expect(applicable).toBe(false);
    });

    it('should check refs applicability when tool has refs', async () => {
      const applicableTool = new Tool({
        name: 'available',
        description: 'Available',
        instructions: 'Available',
        schema: a.object({}),
        call: () => 'result'
      });

      const notApplicableTool = new Tool({
        name: 'not-available',
        description: 'Not available',
        instructions: 'Not available',
        schema: a.object({}),
        applicable: () => false, // Not applicable
        call: () => 'result'
      });

      // Tool with at least one applicable ref
      const tool = new Tool({
        name: 'with-refs',
        description: 'With refs',
        instructions: 'With refs',
        schema: a.object({}),
        refs: [applicableTool, notApplicableTool],
        call: (input, [available, notAvailable]) => 'result'
      });

      const ctx = {} as Context<{}, {}>;
      const applicable = await tool.applicable(ctx);

      // Should be true because at least one ref is applicable
      expect(applicable).toBe(true);
    });

    it('should return false when all refs are not applicable', async () => {
      const notApplicableTool1 = new Tool({
        name: 'not-available-1',
        description: 'Not available 1',
        instructions: 'Not available',
        schema: a.object({}),
        applicable: () => false,
        call: () => 'result'
      });

      const notApplicableTool2 = new Tool({
        name: 'not-available-2',
        description: 'Not available 2',
        instructions: 'Not available',
        schema: a.object({}),
        applicable: () => false,
        call: () => 'result'
      });

      const tool = new Tool({
        name: 'all-refs-unavailable',
        description: 'All refs unavailable',
        instructions: 'Instructions',
        schema: a.object({}),
        refs: [notApplicableTool1, notApplicableTool2],
        call: (input, refs) => 'result'
      });

      const ctx = {} as Context<{}, {}>;
      const applicable = await tool.applicable(ctx);

      // Should be false because no refs are applicable
      expect(applicable).toBe(false);
    });
  });

  describe('Compile', () => {
    it('compiles a tool without instructions, with empty instructions', async () => {
      const tool = new Tool({
        name: 'no-instructions',
        description: 'No instructions',
        instructions: '', // Empty instructions
        schema: a.object({}),
        call: () => 'result'
      });

      const ctx = {} as Context<{}, {}>;
      const compiled = await tool.compile(ctx);

      expect(compiled?.[0]).toBe('');
      expect(compiled?.[1]).toMatchObject({ name: 'no-instructions', description: 'No instructions' });
    });

    it('should compile successfully with instructions', async () => {
      const tool = new Tool({
        name: 'with-instructions',
        description: 'With instructions',
        instructions: 'Use this tool to do something',
        schema: a.object({ value: a.number() }),
        call: (input) => input.value * 2
      });

      const ctx = {} as Context<{}, {}>;
      const compiled = await tool.compile(ctx);

      expect(compiled).toBeDefined();
      expect(compiled![0]).toBe('Use this tool to do something');
      expect(compiled![1].name).toBe('with-instructions');
      expect(compiled![1].description).toBe('With instructions');
    });
  });

  describe('Custom Runner', () => {
    it('should use custom runner when provided', () => {
      const tool = new Tool({
        name: 'with-runner',
        description: 'With runner',
        instructions: 'Instructions',
        schema: a.object({ value: a.number() }),
        call: (input) => input.value * 2
      });

      let runnerCalled = false;
      const ctx: Context<{}, {}> = {
        runner: (component, input, ctx, defaultRun) => {
          runnerCalled = true;
          expect(component).toBe(tool);
          expect(input.value).toBe(5);
          // Call default implementation
          return defaultRun(ctx);
        },
        messages: []
      };

      const result = tool.run({ value: 5 }, ctx);

      expect(runnerCalled).toBe(true);
      expect(result).toBe(10);
    });

    it('should allow runner to modify behavior', () => {
      const tool = new Tool({
        name: 'logging-tool',
        description: 'Logging tool',
        instructions: 'Instructions',
        schema: a.object({ value: a.number() }),
        call: (input) => input.value * 2
      });

      const executionLog: string[] = [];

      const ctx: Context<{}, {}> = {
        runner: (component, input, ctx, defaultRun) => {
          executionLog.push(`Before: ${input.value}`);
          const result = defaultRun(ctx);
          executionLog.push(`After: ${result}`);
          return result;
        },
        messages: []
      };

      const result = tool.run({ value: 10 }, ctx);

      expect(result).toBe(20);
      expect(executionLog).toEqual(['Before: 10', 'After: 20']);
    });
  });
});

describe('tool choice helpers', () => {
  const tool = (name: string) => ({ name, parameters: TEXT_TOOL_SCHEMA.bind() });

  it('forcesTool is true only for choices that make the model call a tool', () => {
    expect(forcesTool('required')).toBe(true);
    expect(forcesTool({ tool: 'a' })).toBe(true);
    expect(forcesTool({ allowed: ['a'], required: true })).toBe(true);
    expect(forcesTool({ allowed: ['a'] })).toBe(false);
    expect(forcesTool('auto')).toBe(false);
    expect(forcesTool(undefined)).toBe(false);
  });

  it('withAllowedTools keeps only the allowed tools, by identity', () => {
    const tools = [tool('a'), tool('b'), tool('c')];
    const request: Request = { messages: [], tools, toolChoice: { allowed: ['a', 'c'], required: true } };

    const narrowed = withAllowedTools(request);

    expect(narrowed.tools).toEqual([tools[0], tools[2]]);
    expect(narrowed.tools?.[0]).toBe(tools[0]);
    expect(narrowed.toolChoice).toBe('required');
    expect(withAllowedTools({ messages: [], tools, toolChoice: 'auto' })).toEqual({ messages: [], tools, toolChoice: 'auto' });
  });
});

describe('describeTool', () => {
  it('appends a grammar to the description of a free-text tool', () => {
    const format: ToolTextFormat = { type: 'grammar', syntax: 'regex', definition: '^[0-9]+$' };
    expect(describeTool({ name: 'n', description: 'A number', parameters: TEXT_TOOL_SCHEMA.bind(), format }))
      .toBe('A number\n\nThe input must match this regex grammar:\n^[0-9]+$');
  });

  it('keeps the description of other tools', () => {
    expect(describeTool({ name: 'n', description: 'Anything', parameters: TEXT_TOOL_SCHEMA.bind(), format: { type: 'text' } })).toBe('Anything');
    expect(describeTool({ name: 'n', parameters: TEXT_TOOL_SCHEMA.bind() })).toBeUndefined();
  });
});

describe('Tool.parse under OpenAI strict', () => {
  it('a null for a left-out optional field leaves no key, even nested; pairs become a record', async () => {
    const tool = new Tool({
      name: 'sig', description: 'd', instructions: 'i',
      schema: a.object({ a: a.number(), b: a.string().optional(), inner: a.object({ c: a.number().optional(), d: a.string() }), tags: a.record(a.number()) }),
      call: () => 'ok',
    });
    const ctx = {} as Context<{}, {}>;
    const definition = (await tool.definition(ctx))!;
    const plan = planRequest({ tools: [definition] }, { id: 'gpt-4o', provider: 'openai', capabilities: ['toolsStrict', 'structured'] });
    expect(plan.get('sig').strict).toBe(true);
    const parsed = await tool.parse(ctx, JSON.stringify({ a: 1, b: null, inner: { c: null, d: 'x' }, tags: [{ key: 'k', value: 2 }] }), plan) as Record<string, unknown>;
    expect(parsed).toEqual({ a: 1, inner: { d: 'x' }, tags: { k: 2 } });
    expect('b' in parsed).toBe(false);
    expect('c' in (parsed['inner'] as object)).toBe(false);
  });
});
