/**
 * Automatic schema-delivery fallback.
 *
 * Some models' structured-output endpoints can't express every JSON Schema:
 * Gemini, for instance, rejects `anyOf`/`$defs` schemas with an HTTP 400. When
 * a Prompt/Tool schema can't be expressed as structured output for the selected
 * model's descriptor, this helper transparently DROPS the wire schema
 * (`response_format`) and delivers the schema to the model as PROMPT TEXT
 * instead — steering it to emit a raw JSON object that the Prompt's existing
 * extract-and-`parse`/Zod path then validates.
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
  getDescriptor,
  getJsonFallbackInstruction,
  LENIENT,
  toJSONSchema,
  type Message,
  type Request,
} from '@aeye/core';
import { resolveStrictFormat } from '../registry';
import type { ModelInfo } from '../types';

/**
 * Tracks requests whose schema text has already been appended, so a Prompt
 * that re-issues the SAME request object across its retry / dynamic-resolve
 * iterations doesn't accumulate duplicate schema blocks in the messages.
 */
const schemaTextAppended = new WeakSet<Request>();

/**
 * Render a Zod schema as fenced JSON-Schema prompt text. Uses the LENIENT
 * dialect so the model sees the true conceptual shape (unions as `anyOf`,
 * open records, etc.) rather than a strict-mode rewrite it would then have to
 * reproduce.
 */
function renderSchemaText(schema: Parameters<typeof toJSONSchema>[0], instruction: string): string {
  const json = JSON.stringify(toJSONSchema(schema, LENIENT), null, 2);
  return `\n\nThe response must be a JSON object conforming to this schema:\n\`\`\`json\n${json}\n\`\`\`\n\n${instruction}`;
}

/**
 * Append schema `text` to the request's prompt. Prefers extending the first
 * system message (keeps the schema inside the instructions, avoids trailing
 * duplicate-role issues across providers); if there is no string-content
 * system message, inserts one at the front.
 */
function appendSchemaText(request: Request, text: string): void {
  const system = request.messages.find((m): m is Message => m.role === 'system');
  if (system && typeof system.content === 'string') {
    system.content = system.content + text;
  } else {
    request.messages.unshift({ role: 'system', content: text.replace(/^\n+/, '') });
  }
}

/**
 * Apply the automatic schema-delivery fallback to `request` in place.
 *
 * When the request carries a structured (schema-valued) `responseFormat` and
 * either `schemaDelivery === 'prompt'` OR (`'auto'` AND the selected model's
 * dialect can't express the schema), the wire schema is DROPPED
 * (`request.responseFormat` cleared so no provider emits `response_format`) and
 * the schema is appended to the messages as prompt text. `schemaDelivery ===
 * 'structured'` forces structured output (no-op here). No-op for text/json
 * response formats.
 *
 * Idempotent: dropping the wire schema makes the trigger condition false on
 * subsequent calls, and the schema-text append is guarded per request object.
 */
export function applySchemaDeliveryFallback(request: Request, model: ModelInfo | undefined): void {
  const rf = request.responseFormat;
  if (!rf || typeof rf !== 'object') return; // only structured schemas

  const delivery = rf.schemaDelivery ?? 'auto';
  if (delivery === 'structured') return; // forced structured — leave as-is

  // Resolve the descriptor for the TARGET MODEL's dialect. `resolveStrictFormat`
  // returning undefined means an unknown dialect — assume it can express the
  // schema (matches today's lenient behavior) unless delivery is forced.
  const family = model ? resolveStrictFormat(model) : undefined;
  const descriptor = family ? getDescriptor(family, true) : LENIENT;

  const shouldFallback = delivery === 'prompt' || !canExpress(rf.type, descriptor);
  if (!shouldFallback) return;

  const schema = rf.type;

  // Drop the wire schema so NO provider sends `response_format` and the
  // Prompt's parse path (which keeps its own `schema`) runs on the model's
  // text JSON with no descriptor pinned (so `decodeWire` is correctly skipped).
  request.responseFormat = undefined;

  // Append the schema text exactly once per request object.
  if (schemaTextAppended.has(request)) return;
  schemaTextAppended.add(request);

  appendSchemaText(request, renderSchemaText(schema, getJsonFallbackInstruction(descriptor)));
}
