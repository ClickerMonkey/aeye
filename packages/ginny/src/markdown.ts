/**
 * Streaming markdown renderer for the terminal.
 *
 * Inputs are raw markdown chunks (as produced by an LLM token stream).
 * Outputs ANSI-colored, line-aware text suitable for `process.stdout.write`.
 *
 * Why streaming: LLM `textPartial` chunks land mid-token. Rendering
 * each chunk independently would mangle bold/italic/code spans that
 * straddle a chunk boundary. The stream class buffers until a newline
 * arrives, then renders the completed line. The trailing partial line
 * stays in the buffer until the next newline OR `flush()` is called
 * (which we do on `text` / `textComplete` events).
 *
 * Algorithmic skeleton (block detection, inline parsing, blockquote
 * markers, code-fence toggling) is ported from
 * `packages/cletus/src/components/Markdown.tsx`. The big difference is
 * that cletus emits React nodes against Ink — here we emit ANSI escape
 * sequences against a plain `WriteStream`. No Ink, no React, no extra
 * dependencies.
 *
 * Tables and complex multi-line markdown features (raw HTML, footnotes,
 * etc.) are NOT supported — they need full-document buffering, which
 * defeats the streaming UX. Tables fall back to one literal line per
 * row, which is at least readable.
 */

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const UNDERLINE = `${ESC}4m`;
const STRIKETHROUGH = `${ESC}9m`;

const FG_CYAN = `${ESC}36m`;
const FG_BRIGHT_CYAN = `${ESC}96m`;
const FG_BLUE = `${ESC}34m`;
const FG_BRIGHT_BLUE = `${ESC}94m`;
const FG_GREEN = `${ESC}32m`;
const FG_YELLOW = `${ESC}33m`;
const FG_MAGENTA = `${ESC}35m`;

/** Heading colors by level (h1 brightest, h6 dimmest). */
const HEADING_COLORS = [
  FG_BRIGHT_CYAN,
  FG_CYAN,
  FG_BRIGHT_BLUE,
  FG_BLUE,
  FG_MAGENTA,
  FG_MAGENTA,
];

const HR_CHAR = '─';
const HR_WIDTH = 60;

/**
 * Streaming markdown → ANSI text renderer.
 *
 * Usage:
 *   const md = new MarkdownStream();
 *   md.write(chunk);     // many times, as chunks arrive
 *   md.flush();          // once, when the stream is done
 *
 * The class is stateful — `inCodeBlock` carries across `write` calls
 * so a fence opened by an earlier chunk affects later ones.
 */
export class MarkdownStream {
  private buffer = '';
  private inCodeBlock = false;
  private codeLang: string | undefined = undefined;
  private out: NodeJS.WritableStream;
  private color: boolean;

  constructor(out: NodeJS.WritableStream = process.stdout, color = !!(process.stdout as { isTTY?: boolean }).isTTY) {
    this.out = out;
    this.color = color;
  }

  /** Append a chunk to the buffer; flush every newline-terminated line through the renderer. */
  write(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk;
    while (true) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.out.write(this.renderLine(line) + '\n');
    }
  }

  /** Render whatever's still buffered, then reset state. Call once when the stream ends. */
  flush(): void {
    if (this.buffer.length > 0) {
      this.out.write(this.renderLine(this.buffer));
      this.buffer = '';
    }
    if (this.inCodeBlock && this.color) {
      // Defensive: stream ended mid-code-block. Emit a reset so any
      // dangling color doesn't bleed into the next prompt line.
      this.out.write(RESET);
    }
    this.inCodeBlock = false;
    this.codeLang = undefined;
  }

  /** Throw away any buffered partial line. Used when a run is cancelled mid-stream. */
  reset(): void {
    this.buffer = '';
    this.inCodeBlock = false;
    this.codeLang = undefined;
  }

  // ── Per-line rendering ───────────────────────────────────────────────────

  private renderLine(line: string): string {
    // Code-fence toggle. Lines starting with ``` flip the code-block
    // mode; the fence line itself renders dim. The optional language
    // tag after the fence is captured for potential future use
    // (syntax highlight, etc.).
    if (line.trim().startsWith('```')) {
      const before = this.inCodeBlock;
      this.inCodeBlock = !this.inCodeBlock;
      this.codeLang = !before ? line.trim().slice(3).trim() : undefined;
      return this.dim(line);
    }

    // Inside a fenced code block: render verbatim with a dim color so
    // the LLM's code is visually distinct from prose. No inline
    // markdown parsing — `*` / `_` / etc. are literal in code.
    if (this.inCodeBlock) {
      return this.color ? `${FG_YELLOW}${line}${RESET}` : line;
    }

    // Heading: `#`...`######` followed by a space.
    const heading = line.match(/^(\s*)(#{1,6})\s+(.*)$/);
    if (heading) {
      const [, indent, hashes, text] = heading;
      const level = Math.min(hashes.length, HEADING_COLORS.length) - 1;
      const color = HEADING_COLORS[level] ?? FG_CYAN;
      const inner = this.renderInline(text);
      return this.color
        ? `${indent}${BOLD}${color}${inner}${RESET}`
        : `${indent}${inner}`;
    }

    // Horizontal rule: a line of three or more `-`, `*`, or `_` (and only those).
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      return this.dim(HR_CHAR.repeat(HR_WIDTH));
    }

    // Blockquote: leading `> ` (possibly nested as `> > ...`). Render
    // each level as a `│ ` indent in dim color, then re-render the
    // quote body through the inline pass.
    const blockquote = line.match(/^((?:>\s?)+)(.*)$/);
    if (blockquote) {
      const [, markers, rest] = blockquote;
      const level = (markers.match(/>/g) || []).length;
      const indent = this.color
        ? `${DIM}${'│ '.repeat(level)}${RESET}`
        : '│ '.repeat(level);
      return indent + this.renderInline(rest);
    }

    // Bullet list: replace leading `- ` or `* ` with `• ` for clearer
    // rendering. Numbered lists are passed through as-is.
    const bullet = line.match(/^(\s*)([-*])(\s+)(.*)$/);
    if (bullet) {
      const [, indent, , space, rest] = bullet;
      return `${indent}•${space}${this.renderInline(rest)}`;
    }

    // Default — inline parse the whole line.
    return this.renderInline(line);
  }

  // ── Inline parsing ───────────────────────────────────────────────────────

  /**
   * Apply inline markdown — code spans, links, bold, italic, underline,
   * strikethrough — in priority order. Code spans and links protect
   * their content from formatting passes (a `*` inside `` `*x*` ``
   * stays literal). Mirrors cletus's `parseInlineFormatting` algorithm,
   * but produces an ANSI string instead of segment objects.
   */
  private renderInline(line: string): string {
    if (!line) return '';

    // Step 0: process escape characters — `\*`, `\_`, etc. become
    // literal. We rebuild a "processed" string with escapes stripped
    // but the escaped char preserved, plus a parallel mask marking
    // positions that were originally escaped (so the formatting
    // regexes don't grab them).
    const ESCAPE_TARGETS = '*_~`[]()\\|';
    let processed = '';
    const escapedAt: boolean[] = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\' && i + 1 < line.length && ESCAPE_TARGETS.includes(line[i + 1]!)) {
        processed += line[i + 1];
        escapedAt.push(true);
        i++;
        continue;
      }
      processed += line[i];
      escapedAt.push(false);
    }

    // Step 1: collect protected spans (code, links). They get formatted
    // as a unit, and inline-formatting passes skip over them.
    type Span = { start: number; end: number; render: () => string };
    const spans: Span[] = [];

    // Code spans: `code` (or ``code with `backtick` inside``).
    const codeRegex = /`([^`]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = codeRegex.exec(processed)) !== null) {
      if (escapedAt[m.index]) continue;
      const content = m[1]!;
      spans.push({
        start: m.index,
        end: m.index + m[0].length,
        render: () => this.color ? `${FG_YELLOW}${content}${RESET}` : `\`${content}\``,
      });
    }

    // Links: [text](url). Emits OSC 8 hyperlinks for terminals that
    // support them; the text portion is underlined+blue regardless so
    // it's still distinguishable on terminals that don't.
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    while ((m = linkRegex.exec(processed)) !== null) {
      if (escapedAt[m.index]) continue;
      const text = m[1]!;
      const url = m[2]!;
      spans.push({
        start: m.index,
        end: m.index + m[0].length,
        render: () => {
          if (!this.color) return `${text} (${url})`;
          // OSC 8 hyperlink + underlined blue label.
          return `\x1b]8;;${url}\x07${UNDERLINE}${FG_BRIGHT_BLUE}${text}${RESET}\x1b]8;;\x07`;
        },
      });
    }

    // Sort + dedupe overlaps (later span wins — first-come takes
    // precedence by start position, but if two start at same point,
    // the longer one absorbs).
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const filtered: Span[] = [];
    let cursor = 0;
    for (const s of spans) {
      if (s.start < cursor) continue;
      filtered.push(s);
      cursor = s.end;
    }

    // Step 2: walk processed, alternately emitting:
    //   - free text (run through `applyFormatting` for bold/italic/etc.)
    //   - a protected span's render()
    let result = '';
    let pos = 0;
    for (const s of filtered) {
      if (s.start > pos) result += this.applyFormatting(processed.slice(pos, s.start));
      result += s.render();
      pos = s.end;
    }
    if (pos < processed.length) result += this.applyFormatting(processed.slice(pos));
    return result;
  }

  /**
   * Apply bold / italic / underline / strikethrough to a stretch of
   * plain text (no code spans, no links — those are protected
   * upstream). Order matters: bold (`**`) before italic (`*`) so the
   * italic regex doesn't claw at bold delimiters. Mirrors cletus's
   * `applyFormatting`.
   */
  private applyFormatting(text: string): string {
    if (!text) return '';
    if (!this.color) return text;

    // Marker-based approach: find every (start, end, type) span, sort
    // by start, then walk emitting text + ANSI toggles. We build
    // ranges for each style independently; overlapping ranges produce
    // nested ANSI codes, which most terminals handle (we always emit
    // a full `RESET` on close so styles don't leak).
    type Range = { start: number; end: number; open: string };
    const ranges: Range[] = [];

    const push = (re: RegExp, open: string) => {
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(text)) !== null) {
        const matched = mm[0];
        const inner = mm[1] ?? '';
        const start = mm.index;
        const end = start + matched.length;
        ranges.push({ start, end, open });
        // Use an empty inner check to keep the regex from infinite-
        // looping on zero-width matches.
        if (matched.length === 0) re.lastIndex++;
        void inner;
      }
    };

    // Bold first (so `**` doesn't get clobbered by italic).
    push(/(?<!\w)\*\*(.+?)\*\*(?!\w)/g, BOLD);
    push(/(?<!\w)__(.+?)__(?!\w)/g, UNDERLINE);
    push(/(?<!\w)~~(.+?)~~(?!\w)/g, STRIKETHROUGH);
    // Italic — single `*` or `_`, not part of `**` / `__`. The
    // surrounding negative lookarounds keep it from grabbing within a
    // word like `foo_bar_baz`.
    push(/(?<!\w)(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)(?!\w)/g, ITALIC);
    push(/(?<!\w)(?<!_)_(?!_)(.+?)(?<!_)_(?!_)(?!\w)/g, ITALIC);

    if (ranges.length === 0) return text;

    // Sort ranges by start then by length DESC, so longer wrapping
    // spans open before nested ones. Then walk.
    ranges.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

    // Build the output. For each range we emit `open<inner>RESET`,
    // recursing into `applyFormatting` on the inner so nested styles
    // also work.
    let out = '';
    let cursor = 0;
    for (const r of ranges) {
      if (r.start < cursor) continue; // overlap — already inside another range
      // Plain text up to this range.
      if (r.start > cursor) out += text.slice(cursor, r.start);
      // Inside the range — strip the marker chars (2 on each side for
      // **/__/~~, 1 each for */_), recurse for nested styles.
      const markerLen = r.open === ITALIC ? 1 : 2;
      const inner = text.slice(r.start + markerLen, r.end - markerLen);
      out += `${r.open}${this.applyFormatting(inner)}${RESET}`;
      cursor = r.end;
    }
    if (cursor < text.length) out += text.slice(cursor);
    return out;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private dim(s: string): string {
    return this.color ? `${DIM}${s}${RESET}` : s;
  }
}

/**
 * One-shot convenience: render a complete markdown string and return
 * the ANSI-decorated text. Equivalent to constructing a stream and
 * piping the whole text through it; useful for non-streaming spots
 * (the `(no output)` placeholder, error messages, etc.).
 */
export function renderMarkdown(text: string, color = !!(process.stdout as { isTTY?: boolean }).isTTY): string {
  const chunks: string[] = [];
  const sink: NodeJS.WritableStream = {
    write(chunk: string | Uint8Array) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
  } as NodeJS.WritableStream;
  const md = new MarkdownStream(sink, color);
  md.write(text);
  md.flush();
  return chunks.join('');
}
