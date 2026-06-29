/**
 * Per-event console UI for a streaming prompt run.
 *
 * The programmer prompt is an agent loop — each iteration the model may
 * think, emit text, and call tools, then we hand the tool results back
 * for another iteration. `EventDisplay.handle()` consumes the prompt's
 * event stream and prints what's happening between turns: a separator
 * when a new iteration starts, a `(thinking)` cue when the model is
 * reasoning, the text response itself, and `→ tool(args)` / `← tool
 * (Xms): result` lines around each tool call (timed via WeakMap keyed
 * on the args object — the same reference is reused across the
 * matching toolStart / toolOutput / toolError events).
 */
import { logger, genId } from './logger';
import { MarkdownStream } from './markdown';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const DIM = `${ESC}2m`;

const PREVIEW_MAX = 120;

/** Sample every Nth streaming partial event for a memory snapshot.
 *  100 ≈ once per ~10 KB of streamed content for typical providers —
 *  fine-grained enough to catch a runaway allocation, coarse enough
 *  not to flood ginny.log on a normal multi-thousand-token response. */
const MEM_CHUNK_INTERVAL = 100;

function preview(value: unknown): string {
  let s: string;
  if (value instanceof Error) {
    // `JSON.stringify(new Error())` is `{}` — surface .message instead.
    s = value.message || String(value);
  } else if (typeof value === 'string') {
    s = value;
  } else {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  }
  if (s == null) return '';
  s = s.replace(/\s+/g, ' ');
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s;
}

type LastEventKind = 'thinking' | 'text' | 'tool' | null;

export class EventDisplay {
  private toolStarts = new WeakMap<object, number>();
  private last: LastEventKind = null;
  /**
   * Has the streamed text line been left open (no trailing newline)?
   * Set on every `textPartial`, cleared once we write the terminating
   * `\n`. Tracked separately from `last` so that consuming the
   * "terminate the line" event (`text` / `textComplete` / a tool
   * boundary) can reset this independently — otherwise the next event
   * would try to write a second newline.
   */
  private textLineOpen = false;
  /** Latches when we ever write streamed user text — used by `producedText`. */
  private hasProducedText = false;
  private color: boolean;
  private thinkingShownThisTurn = false;
  /** Chunk counters for streaming-window memory logs. Reset on each
   *  `request` event (start of a new turn); incremented on every
   *  `textPartial` / `reasonPartial`. Every `MEM_CHUNK_INTERVAL`
   *  partials we drop a `[mem] stream @ N chunks` line so a runaway
   *  allocation during streaming is localizable inside the
   *  beforeRequest → afterRequest window. */
  private partialChunks = 0;
  private reasonChunks = 0;
  private streamLoggedAt = 0;
  /** Track total streamed bytes per turn for the end-of-stream report. */
  private streamBytesText = 0;
  private streamBytesReason = 0;
  /**
   * Streaming markdown renderer. All streamed prose chunks pump through
   * here so headings, code fences, lists, bold/italic, links etc.
   * actually render rather than appearing as raw `**text**` /
   * ```` ```ts ```` markup. Stateful — fenced-code mode carries
   * across chunks within one segment.
   */
  private markdown: MarkdownStream;

  constructor(useColor = !!process.stderr.isTTY) {
    this.color = useColor;
    this.markdown = new MarkdownStream(process.stdout, useColor);
  }

  private c(code: string, text: string): string {
    return this.color ? `${code}${text}${RESET}` : text;
  }

  /** Log a memory snapshot every `MEM_CHUNK_INTERVAL` partial chunks
   *  during streaming. Keeps the AI lib's chunk accumulation visible
   *  inside the beforeRequest → afterRequest window without flooding
   *  the log (one line per ~100 chunks instead of per chunk). */
  private maybeLogStreamMem(): void {
    const total = this.partialChunks + this.reasonChunks;
    if (total - this.streamLoggedAt < MEM_CHUNK_INTERVAL) return;
    this.streamLoggedAt = total;
    logger.mem(`stream @ ${total} chunks (text=${this.partialChunks} reason=${this.reasonChunks})`);
  }

  private breakIfText(): void {
    if (this.textLineOpen) {
      // Drain any partial-line markdown buffer through the renderer
      // before emitting the terminating newline. Without this, a
      // mid-line tool boundary would print the partial line raw and
      // discard the buffer.
      this.markdown.flush();
      process.stdout.write('\n');
      this.textLineOpen = false;
    }
  }

  /** Handle a single PromptEvent. Returns true if any content was streamed to stdout. */
  handle(event: { type: string; [k: string]: any }): void {
    switch (event.type) {
      case 'request': {
        // Reset the per-turn thinking cue so the next iteration can
        // re-emit it; no visible separator between turns.
        this.thinkingShownThisTurn = false;
        // Reset per-turn streaming counters so the next stream's
        // `[mem] stream @ N chunks` lines start at 0.
        this.partialChunks = 0;
        this.reasonChunks = 0;
        this.streamLoggedAt = 0;
        this.streamBytesText = 0;
        this.streamBytesReason = 0;
        if (event.iterations > 0) {
          logger.log(`── turn ${(event.iterations ?? 0) + 1} ──`);
          // Per-turn memory marker — pair with beforeRequest /
          // afterRequest snapshots from ai.ts to see how much memory
          // each turn actually retains after GC.
          logger.mem(`turn ${(event.iterations ?? 0) + 1}`);
        }
        // Message-history size telemetry. The agent loop appends
        // tool_calls + tool_results every iteration, and zod errors
        // can blow up an individual tool_result into kilobytes —
        // we want to see when the history is the leak driver. Log
        // both message count and serialized byte length.
        try {
          const msgs = event.request?.messages ?? [];
          const bytes = JSON.stringify(msgs).length;
          logger.log(`history turn=${(event.iterations ?? 0) + 1} messages=${msgs.length} bytes=${bytes}`);
        } catch { /* ignore — telemetry shouldn't fail the run */ }
        break;
      }

      case 'reasonPartial': {
        this.reasonChunks++;
        const reasoningChunk = event.content ?? '';
        if (typeof reasoningChunk === 'string') this.streamBytesReason += reasoningChunk.length;
        this.maybeLogStreamMem();
        if (!this.thinkingShownThisTurn) {
          this.breakIfText();
          process.stderr.write(`${this.c(DIM, '(thinking…)')}\n`);
          this.thinkingShownThisTurn = true;
          this.last = 'thinking';
        }
        break;
      }

      case 'reason': {
        const text = event.reasoning?.content ?? '';
        if (text) logger.log(`reasoning: ${preview(text)}`);
        // Reasoning stream finished — capture how much we accumulated
        // and where memory landed.
        logger.mem(`reason end (chunks=${this.reasonChunks} bytes=${this.streamBytesReason})`);
        break;
      }

      case 'textPartial': {
        this.partialChunks++;
        const chunk = event.content ?? '';
        if (chunk) {
          if (typeof chunk === 'string') this.streamBytesText += chunk.length;
          // Pump every streamed chunk through the markdown renderer.
          // It buffers partial lines internally, so headings / fences
          // / inline formatting render correctly across chunk
          // boundaries.
          this.markdown.write(chunk);
          this.last = 'text';
          this.textLineOpen = true;
          this.hasProducedText = true;
        }
        this.maybeLogStreamMem();
        break;
      }

      case 'text':
      case 'textComplete': {
        // Streaming for this text segment is done — `text` fires when
        // the model finishes its prose for a turn (just before any
        // tool calls), `textComplete` fires once at the very end of
        // the response. Drain the markdown buffer (partial trailing
        // line, dangling code fence reset, etc.) and terminate with
        // a newline so the next output starts on its own row.
        this.markdown.flush();
        if (this.textLineOpen) {
          process.stdout.write('\n');
          this.textLineOpen = false;
        }
        // End-of-stream memory snapshot — the `[mem] stream end` line
        // brackets the streaming window so the delta vs.
        // `beforeRequest` shows whether streaming itself bloated the
        // heap (chunk accumulation inside the AI lib + ginny's
        // markdown buffer).
        logger.mem(`stream end (textChunks=${this.partialChunks} textBytes=${this.streamBytesText})`);
        break;
      }

      case 'refusal': {
        this.breakIfText();
        const line = `refusal: ${preview(event.content ?? '')}`;
        process.stderr.write(`${this.c(RED, line)}\n`);
        logger.log(`refusal: ${event.content ?? ''}`);
        this.last = 'text';
        break;
      }

      case 'toolStart': {
        this.toolStarts.set(event.args, Date.now());
        this.breakIfText();
        const line = `→ ${event.tool.name}(${preview(event.args)})`;
        process.stderr.write(`${this.c(CYAN, line)}\n`);
        logger.log(line);
        // Memory snapshot bracketing each tool call. Pair with the
        // matching toolOutput snapshot below to see per-tool deltas
        // when post-morteming an OOM via grep ginny.log.
        logger.mem(`tool=${event.tool.name} start`);
        this.last = 'tool';
        break;
      }

      case 'toolOutput': {
        const started = this.toolStarts.get(event.args);
        const elapsed = started ? Date.now() - started : 0;
        const line = `← ${event.tool.name} (${elapsed}ms): ${preview(event.result)}`;
        process.stderr.write(`${this.c(GREEN, line)}\n`);
        logger.log(line);
        logger.mem(`tool=${event.tool.name} done`);
        this.last = 'tool';
        break;
      }

      case 'toolArgRepairAttempt': {
        // Core's parse-fallback fired — one or more top-level fields
        // arrived as JSON-encoded strings (Claude Sonnet 4.x has been
        // observed doing this when tool args grow large). `success`
        // tells us whether the repaired value actually validated;
        // failed repair still surfaces so the model misbehavior is
        // visible (silent absorption was the prior bug).
        const fields = (event as { fields?: ReadonlyArray<string> }).fields ?? [];
        const success = (event as { success?: boolean }).success ?? false;
        const verb = success ? 'repaired' : 'repair-failed';
        const line = `~ ${event.tool.name} args ${verb} (fields: ${fields.join(', ')})`;
        process.stderr.write(`${this.c(DIM, line)}\n`);
        logger.log(line);
        this.last = 'tool';
        break;
      }

      case 'toolError': {
        const started = this.toolStarts.get(event.args);
        const elapsed = started ? Date.now() - started : 0;
        // Cap the on-screen error: zod / aggregate errors can run hundreds
        // of lines and bury the live view. Full text still goes to ginny.log.
        // The 6-char id ties the one-liner to the full stack/args
        // dumped to ginny.log — grep `<id>` to surface everything.
        const id = genId();
        const line = `✗ ${event.tool.name} [${id}] (${elapsed}ms): ${preview(event.error)}`;
        process.stderr.write(`${this.c(RED, line)}\n`);
        logger.log(`[${id}] tool=${event.tool.name} (${elapsed}ms) error: ${event.error}`);
        const stack = (event.error as { stack?: string } | undefined)?.stack;
        if (stack) logger.log(`[${id}] stack:\n${stack}`);
        try { logger.log(`[${id}] args: ${JSON.stringify(event.args)}`); } catch { /* ignore */ }
        // The model-facing `event.error` is truncated to keep the
        // next-turn prompt reasonable; `event.rawArgs` is the full
        // untruncated payload the model actually sent. Log it
        // separately so post-mortems get the complete picture.
        const rawArgs = (event as { rawArgs?: string }).rawArgs;
        if (rawArgs) logger.log(`[${id}] rawArgs (${rawArgs.length} chars):\n${rawArgs}`);
        this.last = 'tool';
        break;
      }

      case 'toolInterrupt': {
        const line = `⏸ ${event.tool.name} interrupted`;
        process.stderr.write(`${this.c(RED, line)}\n`);
        logger.log(line);
        this.last = 'tool';
        break;
      }

      case 'textReset': {
        // The reason can be a multi-line forget/output retry message
        // (e.g. zod validation). Show a one-liner; full text → ginny.log.
        const line = `(reset: ${preview(event.reason ?? 'unspecified')})`;
        process.stderr.write(`${this.c(DIM, line)}\n`);
        logger.log(`(reset: ${event.reason ?? 'unspecified'})`);
        break;
      }
    }
  }

  /** Did we ever stream user-visible text during the run? */
  get producedText(): boolean {
    return this.hasProducedText;
  }
}
