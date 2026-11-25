import { SchemaRejectedError } from './errors';
import { outputInstructions, planRequest, requestPlan, withSystemText } from './schema';
import type { Message, Request, ResponseFormat, SchemaDelivery, SchemaFallback, SchemaTarget } from './types';

/**
 * The output schema when it goes on the wire as structured output, rather
 * than into the prompt.
 */
export function structuredOutput(format: ResponseFormat | undefined): Extract<ResponseFormat, object> | undefined {
  return typeof format === 'object' && format.schemaDelivery !== 'json' && format.schemaDelivery !== 'prompt' ? format : undefined;
}

/**
 * Moves a structured output schema to another delivery when it's at one of
 * the given deliveries.
 */
function redeliver(request: Request, from: SchemaDelivery[], to: SchemaDelivery): boolean {
  const format = request.responseFormat;
  if (typeof format !== 'object' || !from.includes(format.schemaDelivery ?? 'auto')) {
    return false;
  }
  format.schemaDelivery = to;
  return true;
}

/**
 * The schemas a rejection names that are still sent strict, or strict by
 * preference. A required `strict: true` is left alone.
 */
function strictSchemas(request: Request, target: SchemaTarget): { strict?: boolean | number }[] {
  const output = structuredOutput(request.responseFormat);
  const schemas = target.kind === 'output'
    ? output ? [output] : []
    : (request.tools ?? []).filter(tool => target.kind === 'tools' || tool.name === target.name);
  return schemas.filter(schema => schema.strict !== true && schema.strict !== false);
}

/**
 * The default schema fallbacks, in order: the rejected schema goes
 * non-strict, then the output moves to JSON mode with its schema in the
 * prompt, then to plain text with its schema in the prompt. A tool only goes
 * non-strict. Spread or filter it to build your own.
 */
export const SCHEMA_FALLBACKS: readonly SchemaFallback[] = [
  {
    name: 'non-strict',
    apply: (request, target) => {
      const schemas = strictSchemas(request, target);
      schemas.forEach(schema => { schema.strict = false; });
      return schemas.length > 0;
    },
  },
  {
    name: 'json',
    apply: (request, target) => target.kind === 'output' && redeliver(request, ['auto'], 'json'),
  },
  {
    name: 'text',
    apply: (request, target) => target.kind === 'output' && redeliver(request, ['auto', 'json'], 'prompt'),
  },
];

/**
 * Words a provider error uses when it's about a schema.
 */
const SCHEMA_ERROR = /schema|response_format|text\.format|structured.output/i;

/**
 * Words a provider error uses when it's about the output schema.
 */
const OUTPUT_ERROR = /response_format|text\.format|response_schema|structured.output/i;

/**
 * Classifies a provider's bad-request error as a schema rejection, finding
 * which schema it names: the output, a tool by quoted name or index, or else
 * the output when one was sent, or every tool. Undefined when the error isn't
 * about a schema.
 *
 * @param request - The request as the provider sent it.
 * @param error - The provider's error.
 * @param message - Its message, with any detail the provider keeps elsewhere.
 */
export function schemaRejection(request: Request, error: Error, message = error.message): SchemaRejectedError | undefined {
  if (!SCHEMA_ERROR.test(message)) {
    return undefined;
  }
  const tools = request.tools ?? [];
  const output = typeof request.responseFormat === 'object';
  const index = /tools\[(\d+)\]|tools\.(\d+)\./.exec(message);
  const tool = tools.find(({ name }) => message.includes(`'${name}'`) || message.includes(`"${name}"`))
    ?? (index ? tools[Number(index[1] ?? index[2])] : undefined);
  const target: SchemaTarget | undefined = output && OUTPUT_ERROR.test(message) ? { kind: 'output' }
    : tool ? { kind: 'tool', name: tool.name }
    : output ? { kind: 'output' }
    : tools.length ? { kind: 'tools' }
    : undefined;
  return target && new SchemaRejectedError(target, message, error);
}

/**
 * The request with its output schema delivered as prompt text when its
 * delivery says so (`'json'` or `'prompt'`), or always with `delivery`
 * (for providers without structured output): the schema leaves the wire for
 * the system prompt, as the TypeScript-like shape the model writes plus the
 * JSON instruction, and the response format becomes JSON mode or plain
 * text. The answer is decoded through the request's plan either way. The
 * request itself isn't changed (but for the plan pinned on its schemas), so
 * a prompt can send it again under another delivery. `prepareRequest` does
 * this for every planned request.
 *
 * @param request - The request.
 * @param delivery - Overrides the request's delivery.
 */
export function deliverSchema(request: Request, delivery?: SchemaDelivery): Request {
  const format = request.responseFormat;
  if (typeof format !== 'object') {
    return request;
  }
  const mode = delivery ?? format.schemaDelivery;
  if (mode !== 'json' && mode !== 'prompt') {
    return request;
  }
  let entry;
  if (delivery && delivery !== format.schemaDelivery) {
    // Planned as prompt text, so the answer is decoded with the rendering the model is shown.
    const original = format.schemaDelivery;
    format.schemaDelivery = delivery;
    try {
      entry = planRequest(request).output;
    } finally {
      format.schemaDelivery = original;
    }
  } else {
    entry = requestPlan(request).output;
  }
  return {
    ...request,
    responseFormat: mode === 'json' ? 'json' : undefined,
    messages: entry ? withSystemText(request.messages, outputInstructions(entry)) : request.messages,
  };
}
