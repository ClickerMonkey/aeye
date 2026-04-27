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
import { logger } from './logger';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;

const PREVIEW_MAX = 120;

function preview(value: unknown): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s == null) return '';
  s = s.replace(/\s+/g, ' ');
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s;
}

type LastEventKind = 'turn' | 'thinking' | 'text' | 'tool' | null;

export class EventDisplay {
  private toolStarts = new WeakMap<object, number>();
  private last: LastEventKind = null;
  private color: boolean;
  private thinkingShownThisTurn = false;

  constructor(useColor = !!process.stderr.isTTY) {
    this.color = useColor;
  }

  private c(code: string, text: string): string {
    return this.color ? `${code}${text}${RESET}` : text;
  }

  private breakIfText(): void {
    if (this.last === 'text') {
      process.stdout.write('\n');
    }
  }

  /** Handle a single PromptEvent. Returns true if any content was streamed to stdout. */
  handle(event: { type: string; [k: string]: any }): void {
    switch (event.type) {
      case 'request': {
        const turn = (event.iterations ?? 0) + 1;
        if (event.iterations > 0) {
          this.breakIfText();
          process.stderr.write(`\n${this.c(BOLD, `── turn ${turn} ──`)}\n`);
          this.last = 'turn';
          this.thinkingShownThisTurn = false;
          logger.log(`── turn ${turn} ──`);
        }
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
        process.stdout.write(event.content ?? '');
        this.last = 'text';
        break;
      }

      case 'refusal': {
        this.breakIfText();
        process.stderr.write(`${this.c(RED, `refusal: ${event.content ?? ''}`)}\n`);
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
        const line = `✗ ${event.tool.name} (${elapsed}ms): ${event.error}`;
        process.stderr.write(`${this.c(RED, line)}\n`);
        logger.log(line);
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
        const line = `(reset: ${event.reason ?? 'unspecified'})`;
        process.stderr.write(`${this.c(DIM, line)}\n`);
        logger.log(line);
        break;
      }
    }
  }

  /** Did we ever stream user-visible text? */
  get producedText(): boolean {
    return this.last === 'text';
  }
}
