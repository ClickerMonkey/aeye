/**
 * Structured code representation with spans tying every rendered range
 * back to the node + validator path that produced it. Adapted (owned copy)
 * from gin's `code.ts`.
 *
 * Why this exists: a validator produces `Problems` whose `path` is a
 * structural pointer like `['fields', 2, 'type', 'min']`. A renderer
 * produces text. The two are decoupled — a reader has to manually map a
 * path to a position. `Code` closes that gap: every render call also emits
 * a `Span` list, each span carrying the same kind of path the validator
 * emits plus its char range in the rendered text. `formatProblem` then
 * resolves `Problem.path → Span → (line, col)` and emits compiler-style
 * output:
 *
 *   fields[2].type.min: -1
 *                       ^^
 *   error: min cannot be negative
 *
 * Storage is a single string + offset spans (not nested lines) — simpler
 * to manipulate (concat / indent / replace); `toLines()` derives the line
 * view on demand. Multi-line spans cross newlines naturally.
 *
 * The primary builder is the `code\`...\`` tagged template. Interpolating
 * a `string` appends it verbatim; interpolating a `Code` appends its text
 * AND shifts its spans into the combined range, so a tree of nested
 * `code\`...\`` calls accumulates one flat span list over the whole text.
 *
 * The query-specific change vs gin: spans carry a generic `node?: Node`
 * back-reference instead of gin's separate `expr?` / `type?` slots — query
 * doesn't need to distinguish them at the span level, and this avoids a
 * dependency on the (phase-2) Expr class.
 */
import type { Node } from './node';
import type { Problem, Problems } from './problem';
import { jsonSource } from './json-source';

// ─── Types ─────────────────────────────────────────────────────────────────

/** A rendered char range tied back to a validator-style structural path (and optionally its node). */
export interface Span {
  /** Inclusive char offset into Code.text. */
  start: number;
  /** Exclusive char offset. */
  end: number;
  /**
   * Validator-style structural path — same shape as `Problem.path`.
   * Used by `Code.spanFor(target)` to resolve a problem to its rendered
   * position via longest-prefix match.
   */
  path: ReadonlyArray<string | number>;
  /** Optional back-reference to the node that produced this span. */
  node?: Node;
}

/** One line of rendered code plus the spans intersecting it (re-anchored to the line start). */
export interface CodeLine {
  /** This line's text, without trailing newline. */
  text: string;
  /**
   * Spans intersecting this line, with offsets re-anchored to the line's
   * start. A multi-line span appears once per line it covers, clipped.
   */
  spans: ReadonlyArray<Span>;
  /** 1-based line number. */
  lineNum: number;
}

/** Metadata attached when wrapping a render in a span. */
export interface SpanMeta {
  path: ReadonlyArray<string | number>;
  node?: Node;
}

// ─── Code class ──────────────────────────────────────────────────────────────

/**
 * Rendered text plus its span list — the structured, span-carrying code
 * representation whose builders (`code`, `span`, `concat`, `indent`) keep
 * every char range tied to the path that produced it.
 */
export class Code {
  /** Wrap rendered `text` with its (optional) span list. */
  constructor(
    readonly text: string,
    readonly spans: ReadonlyArray<Span> = [],
  ) {}

  /**
   * Build a `Code` over the canonical JSON of `value`, with a `Span`
   * pre-registered for EVERY node (root, each object property value, each
   * array element). Its `text` is byte-identical to
   * `JSON.stringify(value, null, 2)`, and each span carries the value's
   * structural path — so `formatProblems` can resolve a `Problem.path` (e.g.
   * `['fields', 0, 'expr', 'op']`) to that node's char range and underline it
   * compiler-style. A problem whose path matches no node falls through to the
   * existing plain fallback line.
   */
  static fromJson(value: unknown): Code {
    const { text, spans } = jsonSource(value);
    return new Code(text, spans);
  }

  /** The rendered text (drops the spans). */
  toString(): string {
    return this.text;
  }

  /**
   * Append `other`. Its spans shift by `this.text.length` so they keep
   * pointing at the right characters in the combined text.
   */
  concat(other: Code | string): Code {
    if (typeof other === 'string') {
      return new Code(this.text + other, this.spans);
    }
    const offset = this.text.length;
    const shifted = other.spans.map((s) => ({
      ...s,
      start: s.start + offset,
      end: s.end + offset,
    }));
    return new Code(this.text + other.text, [...this.spans, ...shifted]);
  }

  /**
   * Indent every line AFTER the first by `prefix`, re-anchoring spans
   * across the inserted whitespace.
   */
  indent(prefix: string): Code {
    if (!prefix || !this.text.includes('\n')) return this;
    const len = this.text.length;
    // shifts[i] = total chars inserted before original position i.
    const shifts = new Int32Array(len + 1);
    let cumulative = 0;
    for (let i = 0; i < len; i++) {
      shifts[i] = cumulative;
      if (this.text[i] === '\n') cumulative += prefix.length;
    }
    shifts[len] = cumulative;

    const newText = this.text.replace(/\n/g, `\n${prefix}`);
    const newSpans: Span[] = this.spans.map((s) => ({
      ...s,
      start: s.start + shifts[s.start]!,
      end: s.end + shifts[s.end]!,
    }));
    return new Code(newText, newSpans);
  }

  // ─── JSON builders (for `toJSONCode` overrides in later phases) ─────────

  /**
   * Build a JSON object literal as a `Code` with the same indentation
   * `JSON.stringify(obj, null, indent)` produces. Each entry's `value` is
   * appended verbatim, so child `Code` values must already be rendered for
   * the matching depth. The whole `{ ... }` block is wrapped in one span.
   * Entries whose value is `undefined` are dropped (matching
   * `JSON.stringify`'s behaviour).
   */
  static jsonObject(
    entries: ReadonlyArray<JSONEntry>,
    meta: SpanMeta,
    level: number = 0,
    indent: number = 2,
  ): Code {
    const filtered = entries.filter((e) => e.value !== undefined);
    if (filtered.length === 0) return span('{}', meta);
    const childIndent = ' '.repeat((level + 1) * indent);
    const closeIndent = ' '.repeat(level * indent);
    const lines: Code[] = filtered.map(({ key, value }) => {
      // `filtered` dropped undefined values at runtime; the `?? new Code('')`
      // keeps TS happy without a cast.
      /* v8 ignore next -- `filtered` already dropped undefined values, so the `?? new Code('')` fallback is unreachable */
      const valueCode = typeof value === 'string' ? new Code(value) : (value ?? new Code(''));
      return code`${childIndent}${JSON.stringify(key)}: ${valueCode}`;
    });
    return span(code`{\n${joinCode(lines, ',\n')}\n${closeIndent}}`, meta);
  }

  /** Build a JSON array literal, comma-and-newline separated. */
  static jsonArray(
    items: ReadonlyArray<Code | string>,
    meta: SpanMeta,
    level: number = 0,
    indent: number = 2,
  ): Code {
    if (items.length === 0) return span('[]', meta);
    const childIndent = ' '.repeat((level + 1) * indent);
    const closeIndent = ' '.repeat(level * indent);
    const itemCodes: Code[] = items.map((it) => {
      const c = typeof it === 'string' ? new Code(it) : it;
      return code`${childIndent}${c}`;
    });
    return span(code`[\n${joinCode(itemCodes, ',\n')}\n${closeIndent}]`, meta);
  }

  /** Quote-and-escape a JSON string value. */
  static jsonString(value: string): string {
    return JSON.stringify(value);
  }

  /**
   * Render every problem as a sequence of sections. Each section is a
   * contiguous block of source lines containing one or more problems plus
   * a configurable buffer of surrounding context. Sections whose context
   * windows overlap merge. Output shape:
   *
   *   ── lines 5-7 ───────────────────
   *     5 │ fields[2].type.min: -1
   *                            ^^
   *                            error: min cannot be negative
   *
   * Problems whose path resolves to no span fall through to a plain
   * `<severity>: <message> @ <path>` line appended after the sections.
   */
  formatProblems(problems: Problems, opts: FormatProblemsOptions = {}): string {
    return renderProblems(this, problems.list, opts);
  }

  /** Render a single problem with terser defaults (no header / no line
   *  numbers / no context). */
  formatProblem(problem: Problem, opts: FormatOptions = {}): string {
    return renderProblems(this, [problem], {
      ...opts,
      sectionHeaders: false,
      lineNumbers: false,
      contextLines: 0,
    });
  }

  /**
   * Find the span whose `path` is the longest prefix of `target`. Ties
   * broken by smaller (more specific) char range. Returns undefined when
   * no span matches.
   */
  spanFor(target: ReadonlyArray<string | number>): Span | undefined {
    let best: Span | undefined;
    let bestPathLen = -1;
    let bestRange = Number.POSITIVE_INFINITY;
    for (const s of this.spans) {
      if (!isPathPrefix(s.path, target)) continue;
      const range = s.end - s.start;
      if (
        s.path.length > bestPathLen ||
        (s.path.length === bestPathLen && range < bestRange)
      ) {
        best = s;
        bestPathLen = s.path.length;
        bestRange = range;
      }
    }
    return best;
  }

  /**
   * Split into lines. Each line carries its own `spans` array re-anchored
   * to the line's start; multi-line spans appear in every line they
   * intersect, clipped to that line's range.
   */
  toLines(): CodeLine[] {
    const out: CodeLine[] = [];
    const lines = this.text.split('\n');
    let cursor = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]!;
      const lineStart = cursor;
      const lineEnd = cursor + lineText.length;
      const lineSpans: Span[] = [];
      for (const s of this.spans) {
        if (s.end <= lineStart || s.start >= lineEnd) continue;
        const start = Math.max(s.start, lineStart) - lineStart;
        const end = Math.min(s.end, lineEnd) - lineStart;
        lineSpans.push({ ...s, start, end });
      }
      out.push({ text: lineText, spans: lineSpans, lineNum: i + 1 });
      cursor = lineEnd + 1; // +1 for the consumed `\n`
    }
    return out;
  }
}

// ─── Builders ──────────────────────────────────────────────────────────────

/** Plain-text Code with no spans. */
export function plain(text: string): Code {
  return new Code(text);
}

/**
 * Wrap an inner Code (or string) with an outer span covering its entire
 * text. Child spans (when `inner` is already a Code) are preserved beneath.
 * Use at every node-level render boundary to attach the node's path +
 * back-reference.
 */
export function span(inner: Code | string, meta: SpanMeta): Code {
  const innerCode = typeof inner === 'string' ? new Code(inner) : inner;
  const outer: Span = {
    start: 0,
    end: innerCode.text.length,
    path: meta.path,
    node: meta.node,
  };
  // Outer span first so it's iterated before inner ones.
  return new Code(innerCode.text, [outer, ...innerCode.spans]);
}

/**
 * Tagged template — the primary builder. Interpolates strings and Codes
 * into one Code, shifting child spans to their position in the combined
 * text. Newlines / indentation are preserved verbatim.
 */
export function code(
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<string | Code>
): Code {
  let text = '';
  const spans: Span[] = [];
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) {
      const v = values[i]!;
      if (typeof v === 'string') {
        text += v;
      } else {
        const offset = text.length;
        text += v.text;
        for (const s of v.spans) {
          spans.push({ ...s, start: s.start + offset, end: s.end + offset });
        }
      }
    }
  }
  return new Code(text, spans);
}

/** Join Code (or string) values with a separator into one Code, span-preserving. */
export function joinCode(parts: ReadonlyArray<Code | string>, sep: string | Code = ''): Code {
  if (parts.length === 0) return new Code('');
  const sepCode = typeof sep === 'string' ? new Code(sep) : sep;
  let result = typeof parts[0] === 'string' ? new Code(parts[0]) : parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    result = result.concat(sepCode).concat(parts[i]!);
  }
  return result;
}

/** Convenience: `joinCode(parts, '\n')`. */
export function joinLines(parts: ReadonlyArray<Code | string>): Code {
  return joinCode(parts, '\n');
}

/** One key/value entry for `Code.jsonObject`; an `undefined` value drops the entry. */
export interface JSONEntry {
  key: string;
  /** Field value as Code (or pre-stringified primitive). `undefined` → entry omitted. */
  value: Code | string | undefined;
}

// ─── Error formatting ──────────────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const SEVERITY_LABEL: Record<Problem['severity'], string> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
};

const SEVERITY_COLOR: Record<Problem['severity'], string> = {
  error: ANSI.red,
  warning: ANSI.yellow,
  info: ANSI.blue,
};

/** Options shared by single-problem and multi-problem formatting. */
export interface FormatOptions {
  /** Emit ANSI color codes. Default false. */
  color?: boolean;
}

/** Options controlling `Code.formatProblems` (context, headers, gutter, cap). */
export interface FormatProblemsOptions extends FormatOptions {
  /** Context lines above/below each problem's span. Default 2. */
  contextLines?: number;
  /** Show `── lines N-M ───` header per merged section. Default true. */
  sectionHeaders?: boolean;
  /** Show 1-based line-number gutter. Default true. */
  lineNumbers?: boolean;
  /** Cap on problems rendered. Default Infinity. */
  maxProblems?: number;
}

interface ResolvedProblem {
  problem: Problem;
  firstLine: number;
  lastLine: number;
  hits: Map<number, { startCol: number; endCol: number }>;
}

interface Section {
  firstLine: number;
  lastLine: number;
  problems: ResolvedProblem[];
}

function renderProblems(
  codeValue: Code,
  list: ReadonlyArray<Problem>,
  opts: FormatProblemsOptions,
): string {
  if (list.length === 0) return '';
  const color = opts.color ?? false;
  const contextLines = opts.contextLines ?? 2;
  const sectionHeaders = opts.sectionHeaders ?? true;
  const lineNumbers = opts.lineNumbers ?? true;
  const max = opts.maxProblems ?? Number.POSITIVE_INFINITY;

  const c = (ansi: string, s: string): string => (color ? `${ansi}${s}${ANSI.reset}` : s);
  const lines = codeValue.toLines();

  const resolved: ResolvedProblem[] = [];
  const fallback: string[] = [];
  let suppressed = 0;
  for (let i = 0; i < list.length; i++) {
    if (i >= max) {
      suppressed = list.length - i;
      break;
    }
    const p = list[i]!;
    const r = resolveProblem(codeValue, lines, p);
    if (r) {
      resolved.push(r);
    } else {
      const sevColor = SEVERITY_COLOR[p.severity];
      const sevLabel = `${SEVERITY_LABEL[p.severity]}:`;
      const pathStr = p.path.length > 0 ? ` @ ${p.path.join('.')}` : '';
      fallback.push(`${c(sevColor, sevLabel)} ${p.message}${pathStr}`);
    }
  }

  const sections = mergeSections(resolved, lines.length, contextLines);
  const totalLines = lines.length;
  const gutterWidth = lineNumbers ? String(totalLines).length : 0;

  const blocks: string[] = sections.map((section) =>
    renderSection(section, lines, { color, sectionHeaders, lineNumbers, gutterWidth, c }),
  );
  if (fallback.length > 0) blocks.push(fallback.join('\n'));
  if (suppressed > 0) blocks.push(`… (${suppressed} more problem${suppressed === 1 ? '' : 's'} suppressed)`);

  return blocks.join('\n\n');
}

function resolveProblem(codeValue: Code, lines: CodeLine[], problem: Problem): ResolvedProblem | null {
  const matched = codeValue.spanFor(problem.path);
  if (!matched) return null;
  const hits = new Map<number, { startCol: number; endCol: number }>();
  let cursor = 0;
  let firstLine = -1;
  let lastLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!.text;
    const lineStart = cursor;
    const lineEnd = cursor + lineText.length;
    if (matched.end > lineStart && matched.start <= lineEnd) {
      const startCol = Math.max(matched.start, lineStart) - lineStart;
      const endCol = Math.min(matched.end, lineEnd) - lineStart;
      hits.set(i, { startCol, endCol });
      if (firstLine < 0) firstLine = i;
      lastLine = i;
    }
    cursor = lineEnd + 1;
  }
  if (firstLine < 0) return null;
  return { problem, firstLine, lastLine, hits };
}

function mergeSections(
  resolved: ReadonlyArray<ResolvedProblem>,
  totalLines: number,
  contextLines: number,
): Section[] {
  if (resolved.length === 0) return [];
  const sorted = [...resolved].sort((a, b) => a.firstLine - b.firstLine);
  const sections: Section[] = [];
  for (const r of sorted) {
    const start = Math.max(0, r.firstLine - contextLines);
    const end = Math.min(totalLines - 1, r.lastLine + contextLines);
    const last = sections[sections.length - 1];
    if (last && start <= last.lastLine + 1) {
      last.lastLine = Math.max(last.lastLine, end);
      last.problems.push(r);
    } else {
      sections.push({ firstLine: start, lastLine: end, problems: [r] });
    }
  }
  return sections;
}

function renderSection(
  section: Section,
  lines: CodeLine[],
  opts: {
    color: boolean;
    sectionHeaders: boolean;
    lineNumbers: boolean;
    gutterWidth: number;
    c: (ansi: string, s: string) => string;
  },
): string {
  const { sectionHeaders, lineNumbers, gutterWidth, c } = opts;
  const out: string[] = [];

  const numberedGutter = (n: number): string =>
    lineNumbers ? c(ANSI.dim, `${String(n).padStart(gutterWidth)} │ `) : '';
  const blankGutter = (): string =>
    lineNumbers ? c(ANSI.dim, `${' '.repeat(gutterWidth)} │ `) : '';

  if (sectionHeaders) {
    const range = section.firstLine === section.lastLine
      ? `line ${section.firstLine + 1}`
      : `lines ${section.firstLine + 1}-${section.lastLine + 1}`;
    const dashes = '─'.repeat(Math.max(3, 60 - range.length - 4));
    out.push(c(ANSI.dim, `── ${range} ${dashes}`));
  }

  const SEV_RANK: Record<Problem['severity'], number> = { error: 0, warning: 1, info: 2 };

  for (let i = section.firstLine; i <= section.lastLine; i++) {
    out.push(numberedGutter(i + 1) + lines[i]!.text);

    // Dedupe identical underlines on this line; most severe color wins.
    const seenRanges = new Map<string, Problem['severity']>();
    for (const p of section.problems) {
      const hit = p.hits.get(i);
      if (!hit) continue;
      const key = `${hit.startCol}:${hit.endCol}`;
      const existing = seenRanges.get(key);
      if (!existing || SEV_RANK[p.problem.severity] < SEV_RANK[existing]) {
        seenRanges.set(key, p.problem.severity);
      }
    }
    for (const [key, sev] of seenRanges) {
      const [startStr, endStr] = key.split(':');
      const startCol = Number(startStr);
      const endCol = Number(endStr);
      const underline = ' '.repeat(startCol) + '^'.repeat(Math.max(1, endCol - startCol));
      out.push(blankGutter() + c(SEVERITY_COLOR[sev], underline));
    }

    // Messages: every problem whose span ENDS on this line.
    for (const p of section.problems) {
      if (p.lastLine !== i) continue;
      const sev = p.problem.severity;
      const label = c(SEVERITY_COLOR[sev], `${SEVERITY_LABEL[sev]}:`);
      out.push(blankGutter() + `${label} ${p.problem.message}`);
    }
  }

  return out.join('\n');
}

// ─── Path matching helpers ─────────────────────────────────────────────────

function isPathPrefix(prefix: ReadonlyArray<string | number>, target: ReadonlyArray<string | number>): boolean {
  if (prefix.length > target.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== target[i]) return false;
  }
  return true;
}
