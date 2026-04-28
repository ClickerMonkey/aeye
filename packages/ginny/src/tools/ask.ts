import { z } from 'zod';
import { ai } from '../ai';

/**
 * Pose a clarifying question to the human user. Resolves with the typed
 * answer; the prompt loop pauses until the user responds. The actual
 * I/O lives behind `ctx.ask`, supplied by the entry point (the REPL in
 * `index.ts` wires in a readline-backed implementation).
 *
 * If no interactive frontend is attached the tool returns a marker
 * string so the model can adapt rather than hang the run.
 */
export const ask = ai.tool({
  name: 'ask',
  description: 'Ask the user a clarifying question and wait for their answer.',
  instructions:
    'Use sparingly — only when you genuinely need information from the user ' +
    '(missing requirement, ambiguous intent, decision between options). ' +
    'Phrase the question concisely. Returns the user\'s typed answer.',
  schema: z.object({
    question: z.string().describe('The question to put to the user.'),
  }),
  applicable: (ctx) => typeof ctx.ask === 'function',
  call: async (input: { question: string }, _refs, ctx) => {
    if (typeof ctx.ask !== 'function') {
      return 'No interactive user available — proceed with your best assumption and note it.';
    }
    // Forward the abort signal so a Ctrl+C while the user is at the
    // prompt unsticks the run instead of leaving the tool hanging.
    const answer = await ctx.ask(input.question, ctx.signal);
    return answer.length > 0 ? answer : '(no answer)';
  },
});
