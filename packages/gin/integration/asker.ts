/**
 * The LLM ASKER for the gin eval (mirrors `@aeye/query`'s `createAsker`), plus
 * the two improvements `@aeye/ginny` LACKS:
 *
 *  1. WORKED EXAMPLES — `describeGin` folds 3–5 (request → gin program → output)
 *     examples into the prompt. ginny ships ZERO; we include them deliberately to
 *     measure the lift.
 *  2. AUTO RE-PROMPT — the prompt's `parse` hook parses + validates the emitted
 *     program with gin's own engine; on problems it returns a `GinToolError` whose
 *     message lists them, so the prompt's `outputRetries` RE-PROMPTS the model to
 *     self-correct. ginny is one-shot; we auto-repair (the query-proven lever).
 *
 * Wire: `@aeye/ai` + `OpenRouterProvider` + `@aeye/models` (copied from query's
 * `createAsker`). Default model `google/gemini-3-flash-preview` (override via
 * `GIN_EVAL_MODEL`); schema delivery via `GIN_EVAL_MODE` (auto/prompt/structured);
 * `GIN_EVAL_DEBUG` surfaces ask-time throws. The output schema is
 * `buildSchemas(registry).Expr` — the model emits a gin `ExprDef` directly.
 *
 * Because every case has its OWN registry (its custom types) and thus its own Expr
 * schema + type docs, the prompt is (re)built per `ask` from the case's runtime;
 * the AI instance itself is created once.
 */
import { z } from 'zod';

import { AI, type Provider } from '@aeye/ai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { models, strictSupport } from '@aeye/models';

import { buildSchemas, LambdaExpr, type Expr, type ExprDef, type Problem, type TypeDef } from '../src/index';
import type { CaseRuntime } from './model';
import { describeGin } from './describe';

/** Default model for the LLM eval; override with `GIN_EVAL_MODEL`. */
export const DEFAULT_MODEL = 'google/gemini-3-flash-preview';

/** How the Expr schema is delivered to the model (`GIN_EVAL_MODE`). Maps STRAIGHT
 *  onto the prompt's `schemaDelivery` (see query's `EvalMode`). */
export type EvalMode = 'auto' | 'structured' | 'prompt';

/** Read `GIN_EVAL_MODE` (default `auto`). */
export function evalMode(): EvalMode {
  const m = process.env['GIN_EVAL_MODE']?.trim();
  if (m === 'structured') return 'structured';
  if (m === 'prompt') return 'prompt';
  return 'auto';
}

/**
 * Returned/thrown when an LLM-supplied program fails to parse or validate. Its
 * `.message` IS the compiler-style `report`, so the model-facing error channel
 * (which drives `outputRetries`) surfaces gin's own diagnostics. Mirrors query's
 * `QueryToolError`.
 */
export class GinToolError extends Error {
  constructor(readonly problems: readonly Problem[], readonly report: string) {
    super(report);
    this.name = 'GinToolError';
  }
}

/** Render a problem list as a concise, model-facing report the prompt re-prompts with. */
function formatProblems(problems: readonly Problem[]): string {
  const lines = problems.map((p) => `- ${p.severity} ${p.path.join('.') || '<root>'}: ${p.code} — ${p.message}`);
  return ['The program has validation problems — fix them and re-emit:', ...lines].join('\n');
}

/** The result of one model ask: the built program (or null after retries) plus
 *  the last diagnostics + usage for the log trail. */
export interface AskResult {
  /** The parsed generated function body, or null after exhausting retries. */
  program: Expr | null;
  /** The last compiler-style report (empty on success). */
  report: string;
  /** The last problem codes (empty on success). */
  codes: string[];
  /** Number of model requests this ask made (1 + `outputRetries` re-prompts). */
  calls: number;
  /** The raw model TEXT streamed for this ask (verbatim). */
  raw: string;
  /** Model token usage + provider-reported `usage.cost` (USD) for this ask. */
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/** Asks the model for a gin function body for the given case runtime. */
export interface GinAsker {
  ask(request: string, runtime: CaseRuntime): Promise<AskResult>;
}

/** The wire schema, typed at the boundary as the ExprDef it validates to (same
 *  boundary cast query applies to its own query schema). */
type ExprSchema = z.ZodType<ExprDef>;

/**
 * Build the AI instance + a `GinAsker` over OpenRouter (mirrors query's
 * `createAsker`). The prompt's `parse` REPLACES zod validation with gin's own
 * `parseExpr` + `engine.validate`: zod stays only as the wire schema the model
 * emits against, while the retry feedback is gin's compiler-style diagnostics.
 */
export function createAsker(apiKey: string, modelId: string): GinAsker {
  const providers: Record<string, Provider> = { openrouter: new OpenRouterProvider({ apiKey }) };
  const metadata = { model: { id: modelId } };
  // The single narrow `as any` the examples tolerate: the AI metadata typing
  // can't see our pinned model id / allow-list without it (see examples/cli.ts).
  const defaultMetadata = { model: { id: modelId }, providers: { allow: ['openrouter'] } } as any;
  const ai = AI.with()
    .providers(providers)
    .create({ defaultMetadata, models, modelOverrides: [...strictSupport] });

  const mode = evalMode();

  return {
    ask: async (request, runtime): Promise<AskResult> => {
      // Per-case schema + instructions — each case's registry has its own types.
      const wireSchema = buildSchemas(runtime.registry).Expr as ExprSchema;
      const instructions = describeGin(runtime);

      // The last parse/validate error, read through a function so control-flow
      // analysis can't narrow the captured property across the opaque prompt.get.
      const errRef: { last: GinToolError | null } = { last: null };
      const takeLastError = (): GinToolError | null => errRef.last;

      type PromptInput = { prompt: string };
      const prompt = ai.prompt({
        name: 'gin_eval',
        description: 'Write the body of a gin function from a natural-language request',
        content: '{{instructions}}\n\n{{userPrompt}}',
        input: (i: PromptInput) => ({ instructions, userPrompt: i.prompt }),
        schema: () => wireSchema,
        // Headroom for the runtime schema-delivery fallback plus the normal
        // validation re-prompts (matches query's tuning).
        outputRetries: 5,
        // The recursive Expr schema is not compatible with provider strict
        // structured output; opt out explicitly (matches query).
        strict: false,
        // Maps STRAIGHT onto core's schema delivery (see `EvalMode`).
        schemaDelivery: mode,
        // `parse` runs gin's own `parseExpr` + `engine.validate` (as a lambda body
        // so `args` / `recurse` are bound). Clean ⇒ the parsed body `Expr`;
        // problems ⇒ a `GinToolError` whose report the prompt re-prompts with.
        parse: (raw: unknown): Expr | GinToolError => {
          let body: Expr;
          try {
            body = runtime.registry.parseExpr(raw as ExprDef);
          } catch (e) {
            const err = new GinToolError([], `Malformed gin ExprDef: ${e instanceof Error ? e.message : String(e)}`);
            errRef.last = err;
            return err;
          }
          const lambda = new LambdaExpr(runtime.fnType, body);
          const problems = runtime.engine.validate(lambda);
          const errors = problems.list.filter((p) => p.severity === 'error');
          if (errors.length > 0) {
            const err = new GinToolError(errors, formatProblems(errors));
            errRef.last = err;
            return err;
          }
          return body;
        },
        metadata,
      });

      // Stream (not `get('result')`) to COUNT model requests and capture usage.
      let calls = 0;
      let program: Expr | undefined;
      let rawText = '';
      let tokensIn = 0;
      let tokensOut = 0;
      let costUsd = 0;
      let reqIn = 0;
      let reqOut = 0;
      let reqCost = 0;
      try {
        for await (const event of prompt.get('stream', { prompt: request })) {
          if (event.type === 'request') calls++;
          else if (event.type === 'requestUsage') {
            reqIn += (event.usage?.text?.input ?? 0) + (event.usage?.reasoning?.input ?? 0);
            reqOut += (event.usage?.text?.output ?? 0) + (event.usage?.reasoning?.output ?? 0);
            reqCost += event.usage?.cost ?? 0;
          } else if (event.type === 'usage') {
            tokensIn = (event.usage?.text?.input ?? 0) + (event.usage?.reasoning?.input ?? 0);
            tokensOut = (event.usage?.text?.output ?? 0) + (event.usage?.reasoning?.output ?? 0);
            costUsd = event.usage?.cost ?? 0;
          } else if (event.type === 'textPartial') rawText += event.content;
          else if (event.type === 'text' || event.type === 'textComplete') rawText = event.content;
          else if (event.type === 'complete') program = event.output as Expr | undefined;
        }
      } catch (e) {
        // The request/parse error is otherwise swallowed (the case just reports
        // "no valid program"). Surface it under GIN_EVAL_DEBUG.
        if (process.env['GIN_EVAL_DEBUG']) console.error('[ASKERR]', e instanceof Error ? e.message : String(e));
        /* fall through to the error path below (errRef holds the last report) */
      }

      const finalIn = tokensIn || reqIn;
      const finalOut = tokensOut || reqOut;
      const finalCost = costUsd || reqCost;
      const base = { calls, raw: rawText, tokensIn: finalIn, tokensOut: finalOut, costUsd: finalCost };
      if (program) return { program, report: '', codes: [], ...base };
      const last = takeLastError();
      return {
        program: null,
        report: last?.report ?? '',
        codes: last ? last.problems.map((p) => p.code) : [],
        ...base,
      };
    },
  };
}

/** Re-export so the runner can build fn-signature docs identically. */
export type { TypeDef };
