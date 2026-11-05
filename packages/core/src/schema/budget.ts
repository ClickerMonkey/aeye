import z from 'zod';
import type { FormatDescriptor } from './descriptor';
import { getDescriptor } from './registry';
import { fitsStrictAlone, sendableUnder } from './expressible';
import { analyzeSchema } from './analyze';

/**
 * Per-request strict-mode allocator.
 *
 * Constructed once per outgoing request with the chosen model's tool and
 * structured-output descriptors (the same one when only one is given; they
 * differ when the model has strict tools but not strict output, or the
 * reverse). The slot limits come from the stricter of the two. Tracks remaining slots (strict tools, optional parameters,
 * union types) against the descriptor's documented per-request limits and
 * decides per-tool / per-output whether to emit strict or fall back to the
 * SAME FAMILY's non-strict descriptor (`degraded` — never the family-blind
 * `LENIENT`, which would undo dialect rules that outlive strict mode).
 *
 * Selection guarantees that any tool with `strict: true` (hard requirement)
 * has a model that supports the family — `allocate` therefore always grants
 * strict for `requested === true` (subject only to feasibility, not budget;
 * if `true` items overflow the budget the API call will fail, which is the
 * correct behavior for hard requirements).
 *
 * Numeric `strict: <priority>` items are allocated greedily after `true`
 * items have consumed their share of the budget. Caller is expected to
 * pre-sort by descending priority before iterating.
 */
export class SchemaBudget {
  private readonly tool: FormatDescriptor;
  private readonly output: FormatDescriptor;
  /**
   * What an item that does NOT get strict is emitted through: the descriptor's
   * own family, non-strict.
   *
   * It is deliberately NOT the family-blind `LENIENT`. A dialect restriction
   * can belong to the DIALECT rather than to strict mode — `GOOGLE_NON_STRICT`
   * exists for exactly one such rule, the `unconstrained` encoding of
   * `z.any()`, because Gemini builds a decoding grammar whenever a tool call is
   * forced, with no per-tool strict flag involved. Degrading to `LENIENT` put
   * the self-referencing `$defs/Any` that encoding was created to avoid back on
   * the Google wire — and it did so for every gin/query-style recursive `anyOf`
   * schema, i.e. the schemas that ALWAYS degrade, since `GOOGLE_STRICT` cannot
   * express `anyOf` at all (measured: the product's real `api_set` tool schema
   * allocates to `lenient` under `GOOGLE_STRICT`, and its emitted JSON carries
   * nine `#/$defs/Any` references).
   *
   * For the other families this is behaviour-neutral by construction:
   * `OPENAI_NON_STRICT` and `ANTHROPIC_NON_STRICT` are `LENIENT` with a family
   * tag, and a family with no registered non-strict variant resolves to
   * `LENIENT` (`getDescriptor`). Only the pinned `descriptor` id on the tool
   * changes, which round-trips through `getDescriptorById`.
   */
  private readonly degradedTool: FormatDescriptor;
  private readonly degradedOutput: FormatDescriptor;
  private remainingTools: number;
  private remainingOptionalParams: number;
  private remainingUnionTypes: number;

  constructor(tool: FormatDescriptor, output: FormatDescriptor = tool) {
    this.tool = tool;
    this.output = output;
    this.degradedTool = degrade(tool);
    // A family with no non-strict structured output keeps the strict dialect
    // (`canExpress` already kept an unfitting schema off the wire)
    this.degradedOutput = output.structuredOutputAlwaysStrict ? output : degrade(output);
    const descriptor = strictestOf(tool, output);
    this.remainingTools = descriptor.maxStrictTools ?? Infinity;
    this.remainingOptionalParams = descriptor.maxStrictOptionalParams ?? Infinity;
    this.remainingUnionTypes = descriptor.maxStrictUnionTypes ?? Infinity;
  }

  /**
   * Decide the effective descriptor for a tool's parameter schema given the
   * dev's strict request, the schema's features, and the remaining budget.
   *
   * Returns the family's NON-STRICT descriptor (`LENIENT` for a family that
   * registers none) when:
   * - `requested === false`
   * - the schema uses a feature the descriptor can't represent
   * - the schema exceeds the dialect's per-schema size limits
   *   (`checkSchemaSizeLimits`)
   * - the descriptor has slot limits and the budget is exhausted (only
   *   applies to `requested` being a positive number; `true` always wins
   *   subject to feasibility and size)
   *
   * Returns the strict descriptor (and decrements the budget) otherwise.
   */
  allocateTool(
    schema: z.ZodType | z.core.$ZodType,
    requested: boolean | number | undefined,
  ): FormatDescriptor {
    return this.allocate(schema, requested, /* isTool */ true);
  }

  /**
   * Same as `allocateTool` but for the request's structured-output schema.
   * The output schema doesn't consume a tool slot but it does count toward
   * the optional-parameter and union-type budgets — descriptors document
   * those limits as "across all strict schemas in one request".
   */
  allocateOutput(
    schema: z.ZodType | z.core.$ZodType,
    requested: boolean | number | undefined,
  ): FormatDescriptor {
    return this.allocate(schema, requested, /* isTool */ false);
  }

  /** Snapshot of remaining budget. Useful for telemetry / debug logs. */
  remaining(): { strictTools: number; optionalParams: number; unionTypes: number } {
    return {
      strictTools: this.remainingTools,
      optionalParams: this.remainingOptionalParams,
      unionTypes: this.remainingUnionTypes,
    };
  }

  private allocate(
    schema: z.ZodType | z.core.$ZodType,
    requested: boolean | number | undefined,
    isTool: boolean,
  ): FormatDescriptor {
    const descriptor = isTool ? this.tool : this.output;
    const degraded = isTool ? this.degradedTool : this.degradedOutput;
    // strict: false → always non-strict, no budget movement.
    if (requested === false) return degraded;
    // Descriptor itself is lenient → nothing to allocate.
    if (!descriptor.strict) return degraded;

    const isHardRequired = requested === true;
    const isPreferredNumeric = typeof requested === 'number' && requested > 0;

    if (!isHardRequired && !isPreferredNumeric) {
      // requested is undefined or 0 — treat as no preference; default to
      // non-strict so callers explicitly opt into strict. Decided BEFORE any
      // walk of `schema`: analysing a schema whose verdict is already
      // non-strict is pure waste on the hot path of every tool of every request.
      return degraded;
    }

    // FEASIBILITY, before budget — the second clause of this method's contract,
    // and the one that was documented but never implemented. Emitting a strict
    // schema carrying a combinator the descriptor forbids is a guaranteed
    // provider 400, not a degradation: `GOOGLE_STRICT` forbids `anyOf`, and the
    // recursive union a gin/query codegen layer produces is nothing but.
    // Degrading to the family's non-strict descriptor is the documented answer
    // for a TOOL (unlike a structured OUTPUT, a tool schema has no prompt-text
    // delivery to fall back to — `applySchemaDeliveryFallback` covers
    // `responseFormat` only), and it is also what keeps the API-level
    // `strict: true` flag off the wire, since providers set it from
    // `descriptor.strict`.
    //
    // `sendableUnder`, not `canExpress`: a cycle is always sendable (the
    // emitter's bounded placeholder), only looser — see that function's note on
    // why the two questions are different.
    if (!sendableUnder(schema, descriptor)) return degraded;

    // SIZE, still before budget and still regardless of priority: the per-SCHEMA
    // bounds (see `checkSchemaSizeLimits`), and the per-request budgets when
    // this schema alone exceeds them, cannot be met by anything else in the
    // request, and a hard `strict: true` cannot force a schema the API will
    // refuse to compile.
    if (!fitsStrictAlone(schema, descriptor)) return degraded;

    const features = analyzeSchema(schema);

    // Soft-priority items must fit the budget. Hard-required items skip
    // budget checks because selection already promised the model can take
    // them — if there are too many, that's a request-construction bug we
    // surface via API error rather than degrading silently.
    if (isPreferredNumeric) {
      if (isTool && this.remainingTools <= 0) return degraded;
      if (this.remainingOptionalParams - features.optionalParameterCount < 0) return degraded;
      if (this.remainingUnionTypes - features.unionTypeCount < 0) return degraded;
    }

    // Allocation succeeded — decrement.
    if (isTool) this.remainingTools -= 1;
    this.remainingOptionalParams -= features.optionalParameterCount;
    this.remainingUnionTypes -= features.unionTypeCount;

    return descriptor;
  }
}

/**
 * What an item that does not get strict is emitted through (see
 * `SchemaBudget.degradedTool`). An already-non-strict descriptor degrades to
 * itself: there is nothing looser in its family, and `LENIENT`'s own family
 * has no other variant.
 */
function degrade(descriptor: FormatDescriptor): FormatDescriptor {
  return descriptor.strict ? getDescriptor(descriptor.family, false) : descriptor;
}

/**
 * Compare two descriptors and return the one with the tighter per-request
 * budget. Used by providers to pick a single descriptor for a SchemaBudget
 * shared between `convertTools` and `convertResponseFormat` — Anthropic's
 * documented limits apply across the whole request, so the strictest
 * descriptor wins.
 *
 * `schemaSizeLimits` deliberately does NOT participate. Those bounds are
 * per-schema, so they are evaluated against whichever descriptor this returns
 * rather than shared between the two — and every provider here passes two
 * descriptors resolved from the SAME family, so there is nothing to break the
 * tie on. Ranking six size bounds against three slot budgets would be an
 * invented ordering, not a documented one.
 */
export function strictestOf(a: FormatDescriptor, b: FormatDescriptor): FormatDescriptor {
  // LENIENT is the loosest — pick the strict side if either is strict.
  if (a.strict && !b.strict) return a;
  if (b.strict && !a.strict) return b;
  if (!a.strict && !b.strict) return a;
  // Both strict — pick the one with the smallest documented limits.
  const score = (d: FormatDescriptor): number =>
    (d.maxStrictTools ?? Infinity) +
    (d.maxStrictOptionalParams ?? Infinity) +
    (d.maxStrictUnionTypes ?? Infinity);
  return score(a) <= score(b) ? a : b;
}

/**
 * Convert a `boolean | number | undefined` strict request into a numeric
 * priority for sorting. Used by providers to allocate strict slots in
 * descending priority order.
 *
 * - `true` → `+Infinity` (hard requirement; always first in line)
 * - `false` → `-Infinity` (always lenient; never wants strict)
 * - `number > 0` → the number itself
 * - `number <= 0` or `undefined` → `0` (no preference)
 */
export function strictPriority(requested: boolean | number | undefined): number {
  if (requested === true) return Infinity;
  if (requested === false) return -Infinity;
  if (typeof requested === 'number') return requested > 0 ? requested : 0;
  return 0;
}
