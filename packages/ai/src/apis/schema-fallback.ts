/**
 * Automatic schema-delivery fallback.
 *
 * Some models' structured-output endpoints can't express every JSON Schema:
 * Gemini, for instance, rejects `anyOf`/`$defs` schemas with an HTTP 400. When
 * a Prompt/Tool schema can't be expressed as structured output for the selected
 * model's descriptor, this helper transparently DROPS the wire schema
 * (`response_format`) and delivers the schema to the model as PROMPT TEXT
 * instead — steering it to emit a raw JSON object that the Prompt's existing
 * extract-and-`parse`/Zod path then validates. A schema delivered as `json` or
 * `prompt` goes the same way (see `deliverSchema`).
 *
 * Provider-agnostic: called from the ai request-build (see `ChatAPI`) after the
 * model is resolved, BEFORE any provider converts the request to its wire form.
 * The descriptor is resolved from the model's dialect
 * (`resolveStrictFormat` → `getDescriptor`), independent of whether the chosen
 * provider bothers to emit that dialect strictly — because feasibility is a
 * property of the target model, not our request encoder.
 */

import {
  canExpress,
  deliverSchema,
  getDescriptor,
  LENIENT,
  type Request,
} from '@aeye/core';
import { resolveStrictFormat } from '../registry';
import type { ModelInfo } from '../types';

/**
 * The request to send under its schema delivery. A structured schema goes
 * into the prompt as text when its delivery is `'prompt'`, or `'auto'` and
 * the selected model's dialect can't express it; as text plus JSON mode when
 * its delivery is `'json'`. `'structured'` and expressible `'auto'` schemas
 * stay on the wire. The request itself isn't changed, so a Prompt can send it
 * again under another delivery.
 */
export function applySchemaDeliveryFallback(request: Request, model: ModelInfo | undefined): Request {
  const format = request.responseFormat;
  if (typeof format !== 'object') {
    return request;
  }

  // Resolve the descriptor for the TARGET MODEL's dialect. `resolveStrictFormat`
  // returning undefined means an unknown dialect — assume it can express the
  // schema (matches today's lenient behavior) unless delivery is forced.
  const family = model ? resolveStrictFormat(model) : undefined;
  const descriptor = family ? getDescriptor(family, true) : LENIENT;
  const inexpressible = (format.schemaDelivery ?? 'auto') === 'auto' && !canExpress(format.type, descriptor);

  return deliverSchema(request, descriptor, inexpressible ? 'prompt' : undefined);
}
