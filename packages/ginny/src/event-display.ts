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

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const DIM = `${ESC}2m`;

const PREVIEW_MAX = 120;

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

  constructor(useColor = !!process.stderr.isTTY) {
    this.color = useColor;
  }

  private c(code: string, text: string): string {
    return this.color ? `${code}${text}${RESET}` : text;
  }

  private breakIfText(): void {
    if (this.textLineOpen) {
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
        if (event.iterations > 0) logger.log(`── turn ${(event.iterations ?? 0) + 1} ──`);
        break;
      }

      case 'reasonPartial': {
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
        break;
      }

      case 'textPartial': {
        const chunk = event.content ?? '';
        if (chunk) {
          process.stdout.write(chunk);
          this.last = 'text';
          this.textLineOpen = true;
          this.hasProducedText = true;
        }
        break;
      }

      case 'text':
      case 'textComplete': {
        // Streaming for this text segment is done — `text` fires when
        // the model finishes its prose for a turn (just before any
        // tool calls), `textComplete` fires once at the very end of
        // the response. Either way, terminate the streamed line so
        // whatever prints next (tool boundary, prompt, etc.) starts
        // on its own row instead of butting up against the last word.
        this.breakIfText();
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
        this.last = 'tool';
        break;
      }

      case 'toolOutput': {
        const started = this.toolStarts.get(event.args);
        const elapsed = started ? Date.now() - started : 0;
        const line = `← ${event.tool.name} (${elapsed}ms): ${preview(event.result)}`;
        process.stderr.write(`${this.c(GREEN, line)}\n`);
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
