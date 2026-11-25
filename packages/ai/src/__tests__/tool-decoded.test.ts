/**
 * AI.tool() / AI.prompt(): a codec's decoded type flows through
 *
 * A schema with a codec (`a.codec(wire, { decode, encode })`) decodes the
 * model's answer into any object — a class instance, an array. Proves the
 * `ai.tool(...)` / `ai.prompt(...)` convenience layer keeps that type: `call`
 * and `validate` receive the DECODED value, not the wire shape, at runtime and
 * at the type level. (This replaced the custom `parse` hook, removed in step 2
 * of the @aeye/schema integration.)
 */

import { a } from '@aeye/schema';
import { AI } from '../ai';
import { createMockProvider } from './mocks/provider.mock';

/** A domain class the codec builds from the wire params. */
class Greeter {
  constructor(public readonly who: string) {}
  greet(): string {
    return `hello ${this.who}`;
  }
}

const GreeterSchema = a.codec(a.object({ who: a.string() }), {
  decode: (w) => new Greeter(w.who),
  encode: (g: Greeter) => ({ who: g.who }),
});

// ---- Type-level assertion helpers -----------------------------------------
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

describe('AI.tool(): the codec decodes', () => {
  it('gives call() the class instance the codec built (runtime)', async () => {
    const provider1 = createMockProvider({ name: 'provider1' });
    const ai = AI.with().providers({ provider1 }).create({});

    let receivedInCall: unknown;

    const tool = ai.tool({
      name: 'greet',
      description: 'Greet someone',
      schema: GreeterSchema,
      // `input` is inferred as Greeter — calling an instance method proves it.
      call: (input) => {
        receivedInCall = input;
        return input.greet();
      },
    });

    const decoded = await tool.parse({} as any, JSON.stringify({ who: 'world' }));
    expect(decoded).toBeInstanceOf(Greeter);
    expect((decoded as Greeter).who).toBe('world');

    const result = await tool.run(new Greeter('world'), {} as any);
    expect(result).toBe('hello world');
    expect(receivedInCall).toBeInstanceOf(Greeter);
  });

  it("types call()'s arg as the codec's output (compile-time)", () => {
    const provider1 = createMockProvider({ name: 'provider1' });
    const ai = AI.with().providers({ provider1 }).create({});

    ai.tool({
      name: 'greet',
      description: 'Greet someone',
      schema: GreeterSchema,
      call: (input) => {
        type _CallArgIsGreeter = Expect<Equal<typeof input, Greeter>>;
        return input.greet();
      },
    });

    // Without a codec the call gets the schema's shape.
    ai.tool({
      name: 'plain',
      description: 'No codec',
      schema: a.object({ who: a.string() }),
      call: (input) => {
        type _CallArgIsParams = Expect<Equal<typeof input, { who: string }>>;
        return input.who;
      },
    });

    expect(true).toBe(true);
  });
});

describe('AI.prompt(): the codec decodes', () => {
  it('a class-instance output through ai.prompt() (type)', () => {
    const provider1 = createMockProvider({ name: 'provider1' });
    const ai = AI.with().providers({ provider1 }).create({});

    const prompt = ai.prompt({
      name: 'counter',
      description: 'Produce a number',
      content: 'Test',
      schema: GreeterSchema,
      validate: (output) => {
        // Compile-time: `output` is `Greeter` (has `greet`).
        if (!output.greet()) throw new Error('silent');
      },
    });

    // Type-level: `get('result')` resolves to the DECODED `Greeter`.
    type ResultType = Awaited<ReturnType<typeof prompt.get<'result', any, any, any>>>;
    type _ResultIsGreeter = Expect<Equal<ResultType, Greeter | undefined>>;
    expect(prompt.name).toBe('counter');
  });
});
