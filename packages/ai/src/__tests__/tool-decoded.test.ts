/**
 * AI.tool() TDecoded forwarding tests
 *
 * Proves that a custom `parse` whose RETURN type is a class instance flows
 * through the `ai.tool(...)` convenience layer so that `call` receives the
 * DECODED value (the class instance) — not the raw wire `TParams`. Covers both
 * the runtime behavior (parse builds the instance, call gets it) and a
 * compile-time / type-level assertion that `call`'s argument is the class type.
 */

import { z } from 'zod';
import { AI } from '../ai';
import { createMockProvider } from './mocks/provider.mock';

/** A domain class the custom `parse` builds from the raw wire params. */
class Greeter {
  constructor(public readonly who: string) {}
  greet(): string {
    return `hello ${this.who}`;
  }
}

// ---- Type-level assertion helpers -----------------------------------------
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

describe('AI.tool() TDecoded forwarding', () => {
  it('gives call() the decoded class instance produced by parse (runtime)', async () => {
    const provider1 = createMockProvider({ name: 'provider1' });
    const ai = AI.with().providers({ provider1 }).create({});

    let receivedInCall: unknown;

    const tool = ai.tool({
      name: 'greet',
      description: 'Greet someone',
      schema: z.object({ who: z.string() }),
      // Custom parse REPLACES zod: its return type (Greeter) drives TDecoded.
      parse: (raw) => {
        const { who } = raw as { who: string };
        return new Greeter(who);
      },
      // `input` is inferred as Greeter — calling an instance method proves it
      // (would fail to compile if TDecoded collapsed to the wire `{ who }`).
      call: (input) => {
        receivedInCall = input;
        return input.greet();
      },
    });

    // parse() decodes the wire args into the class instance.
    const decoded = await tool.parse({} as any, JSON.stringify({ who: 'world' }));
    expect(decoded).toBeInstanceOf(Greeter);
    expect((decoded as Greeter).who).toBe('world');

    // run() hands the decoded instance to call().
    const result = await tool.run(new Greeter('world'), {} as any);
    expect(result).toBe('hello world');
    expect(receivedInCall).toBeInstanceOf(Greeter);
  });

  it('types call()/parse() decoded arg as the class instance (compile-time)', () => {
    const provider1 = createMockProvider({ name: 'provider1' });
    const ai = AI.with().providers({ provider1 }).create({});

    ai.tool({
      name: 'greet',
      description: 'Greet someone',
      schema: z.object({ who: z.string() }),
      parse: (raw) => new Greeter((raw as { who: string }).who),
      call: (input) => {
        // Type-level: `input` must be exactly `Greeter`, not the wire params.
        type _CallArgIsGreeter = Expect<Equal<typeof input, Greeter>>;
        return input.greet();
      },
    });

    // Absent a custom parse, TDecoded defaults to the wire params.
    ai.tool({
      name: 'plain',
      description: 'No custom parse',
      schema: z.object({ who: z.string() }),
      call: (input) => {
        type _CallArgIsParams = Expect<Equal<typeof input, { who: string }>>;
        return input.who;
      },
    });

    expect(true).toBe(true);
  });
});
