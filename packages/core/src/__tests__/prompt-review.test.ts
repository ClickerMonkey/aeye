/**
 * Prompt review: a valid output goes to `review`, whose feedback sends the
 * model round again, up to `reviewRetries`.
 */

import { z } from 'zod';
import { PromptError, ReviewRejectedError } from '../errors';
import { Prompt, PromptEvent, PromptReview, PromptReviewContext } from '../prompt';
import { AnyTool, Tool } from '../tool';
import type { Response } from '../types';
import { createMockExecutor } from './mocks/executor.mock';

type Output = { value: number };

/** A review that gives the feedback in turn, then passes. */
function reviewer(feedback: string[]) {
  const seen: { output: Output; context: PromptReviewContext<{}, {}, {}> }[] = [];
  const review = async (output: Output, context: PromptReviewContext<{}, {}, {}>): Promise<PromptReview> => {
    seen.push({ output, context: { ...context, request: { ...context.request, messages: [...context.request.messages] } } });
    const next = feedback[context.attempt - 1];
    return next ? { feedback: next } : { pass: true };
  };
  return { review, seen };
}

function reviewed(review: ReturnType<typeof reviewer>['review'], reviewRetries?: number, tools: AnyTool[] = []) {
  return new Prompt({
    name: 'reviewed',
    description: 'Reviewed',
    content: 'Answer.',
    schema: z.object({ value: z.number() }),
    review,
    reviewRetries,
    tools,
  });
}

async function stream(prompt: ReturnType<typeof reviewed>, responses: Partial<Response>[]) {
  const events: PromptEvent<Output, AnyTool[]>[] = [];
  for await (const event of prompt.get('stream', {}, { execute: createMockExecutor({ responses }) })) {
    events.push(event);
  }
  return events;
}

const reviewEvents = (events: PromptEvent<Output, AnyTool[]>[]) => events.flatMap(e =>
  e.type === 'reviewStart' || e.type === 'reviewPass' ? [[e.type, e.attempt, e.output.value]]
  : e.type === 'reviewFeedback' ? [[e.type, e.attempt, e.output.value, e.feedback]]
  : []);

describe('Prompt review', () => {
  it('returns an output the review passes', async () => {
    const { review, seen } = reviewer([]);
    const events = await stream(reviewed(review), [{ content: '{"value":1}' }]);

    expect(reviewEvents(events)).toEqual([['reviewStart', 1, 1], ['reviewPass', 1, 1]]);
    expect(events.find(e => e.type === 'complete')).toMatchObject({ output: { value: 1 } });
    // The review sees the answer it reviews as the last message.
    expect(seen[0].context.request.messages.at(-1)).toMatchObject({ role: 'assistant', content: '{"value":1}' });
  });

  it('sends feedback back to the model and reviews the new answer', async () => {
    const { review, seen } = reviewer(['Make it bigger.']);
    const events = await stream(reviewed(review), [{ content: '{"value":1}' }, { content: '{"value":2}' }]);

    expect(reviewEvents(events)).toEqual([
      ['reviewStart', 1, 1],
      ['reviewFeedback', 1, 1, 'Make it bigger.'],
      ['reviewStart', 2, 2],
      ['reviewPass', 2, 2],
    ]);
    expect(seen[1].context.request.messages.slice(-2)).toMatchObject([
      { role: 'user', content: 'Make it bigger.' },
      { role: 'assistant', content: '{"value":2}' },
    ]);
    expect(events.find(e => e.type === 'complete')).toMatchObject({ output: { value: 2 } });
  });

  it('throws a ReviewRejectedError with the last output once review retries run out', async () => {
    const { review } = reviewer(['No.', 'Still no.']);
    const prompt = reviewed(review, 1);
    const execute = createMockExecutor({ responses: [{ content: '{"value":1}' }, { content: '{"value":2}' }] });

    const error = await prompt.get('result', {}, { execute }).then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(PromptError);
    expect(error).toMatchObject({ kind: 'model' });
    const cause = error instanceof PromptError ? error.cause : undefined;
    expect(cause).toBeInstanceOf(ReviewRejectedError);
    expect(cause).toMatchObject({ output: { value: 2 }, feedback: 'Still no.' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('works after tool calls', async () => {
    const lookup = new Tool({
      name: 'lookup',
      description: 'Looks up',
      instructions: 'Look up',
      schema: z.object({ q: z.string() }),
      call: () => 'found',
    });
    const { review } = reviewer(['Check again.']);
    const events = await stream(reviewed(review, 1, [lookup]), [
      { content: '', finishReason: 'tool_calls', toolCalls: [{ id: '1', name: 'lookup', arguments: '{"q":"a"}' }] },
      { content: '{"value":1}' },
      { content: '{"value":3}' },
    ]);

    expect(events.some(e => e.type === 'toolOutput')).toBe(true);
    expect(reviewEvents(events).map(([type]) => type)).toEqual(['reviewStart', 'reviewFeedback', 'reviewStart', 'reviewPass']);
    expect(events.find(e => e.type === 'complete')).toMatchObject({ output: { value: 3 } });
  });

  it('reviews text output too', async () => {
    const review = jest.fn(async (output: string): Promise<PromptReview> => output === 'hi' ? { feedback: 'Say more.' } : { pass: true });
    const prompt = new Prompt({ name: 'text', description: 'Text', content: 'Greet.', review });
    const execute = createMockExecutor({ responses: [{ content: 'hi' }, { content: 'hello there' }] });

    expect(await prompt.get('result', {}, { execute })).toBe('hello there');
    expect(review).toHaveBeenCalledTimes(2);
  });
});
