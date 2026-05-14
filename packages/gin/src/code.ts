/**
 * Structured code representation with spans tying every rendered range
 * back to the node + validator path that produced it.
 *
 * Why this exists: today `engine.toCode(expr)` returns a flat string and
 * `engine.validate(expr)` returns Problems with structural paths like
 * `['vars', 0, 'value', 'ifs', 0, 'condition']`. The two are decoupled.
 * The reader (LLM or human) has to manually map a path to its rendered
 * position. With Code, every render call also produces a Span list:
 * each span carries the same path the validator would emit, plus its
 * char range in the rendered text. `formatProblem` then resolves
 * `Problem.path → Span → (line, col)` and emits compiler-style output:
 *
 *   const x: num = "wrong"
 *                  ^^^^^^^
 *   error: var 'x' value type 'text' not compatible with declared 'num'
 *
 * Storage is single-string + offset spans (not nested lines) — simpler
 * to manipulate (concat, indent, replace) and `toLines()` derives the
 * line view on demand. Multi-line spans cross newlines naturally.
 *
 * The primary builder is the `code\`...\`` tagged template. Interpolating
 * `string` values appends them verbatim; interpolating `Code` values
 * appends their text AND shifts their spans into the new combined
 * range. A tree of nested `code\`...\`` calls accumulates a flat span
 * list spanning the whole rendered text.
 */
import type { Expr } from './expr';
import type { Type } from './type';
import type { Problem, Problems } from './problem';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Span {
  /** Inclusive char offset into Code.text. */
  start: number;
  /** Exclusive char offset. */
  end: number;
  /**
   * Validator-style structural path — same shape as `Problem.path`.
   * Used by `Code.spanFor(target)` to resolve a problem to its
   * rendered position via longest-prefix match.
   */
  path: ReadonlyArray<string | number>;
  /** Optional back-reference to the node that produced this span. */
  expr?: Expr;
  type?: Type;
}

export interface CodeLine {
  /** This line's text, without trailing newline. */
  text: string;
  /**
   * Spans intersecting this line, with offsets re-anchored to the
   * line's start. A multi-line span appears once per line it covers,
   * clipped to that line's range.
   */
  spans: ReadonlyArray<Span>;
  /** 1-based line number. */
  lineNum: number;
}

// ─── Code class ────────────────────────────────────────────────────────────

export class Code {
  constructor(
    readonly text: string,
    readonly spans: ReadonlyArray<Span> = [],
  ) {}

  toString(): string {
    return this.text;
  }

  /**
   * Append `other` to this Code. `other`'s spans get shifted by
   * `this.text.length` so they continue to point at the right
   * characters in the combined text.
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
   * Indent every line AFTER the first by `prefix`. Mirrors the existing
   * `indentCode` string helper but re-anchors spans across the
   * inserted whitespace. Spans that straddle a newline have their `end`
   * shifted by the cumulative prefix length.
   */
  indent(prefix: string): Code {
    if (!prefix || !this.text.includes('\n')) return this;
    // Build offset-shift map: for each char position, how many extra
    // chars get inserted before it. Each `\n` adds `prefix.length` to
    // every following position.
    const len = this.text.length;
    const shifts = new Int32Array(len + 1); // shifts[i] = total chars added before original position i
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

  /**
   * Find the span whose `path` is the longest prefix of `target`. Used
   * by `formatProblem` to map a Problem.path to its rendered range.
   * Returns undefined when no span matches (caller falls back to a
   * path-string format).
   *
   * Ties broken by smaller (more specific) char range — the smaller
   * span is more localized and gives a tighter underline.
   */
  spanFor(target: ReadonlyArray<string | number>): Span | undefined {
    let best: Span | undefined;
    let bestPathLen = -1;
    let bestRange = Number.POSITIVE_INFINITY;
    for (const span of this.spans) {
      if (!isPathPrefix(span.path, target)) continue;
      const range = span.end - span.start;
      if (
        span.path.length > bestPathLen ||
        (span.path.length === bestPathLen && range < bestRange)
      ) {
        best = span;
        bestPathLen = span.path.length;
        bestRange = range;
      }
    }
    return best;
  }

  /**
   * Split into lines. Each line carries its own `spans` array with
   * offsets re-anchored to the line's start. Multi-line spans appear
   * in EVERY line they intersect, clipped to that line's char range.
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

/**
 * Plain-text Code with no spans. Equivalent to `new Code(text)`.
 * Convenience for callers that want to mix string content into a
 * `code\`...\`` chain without losing type uniformity.
 */
export function plain(text: string): Code {
  return new Code(text);
}

/**
 * Wrap an inner Code (or string) with an outer span covering the
 * entire text. Child spans (if `inner` is already a Code) are
 * preserved beneath. Use this at every node-level toGinCode/toJSONCode
 * boundary to attach the node's own path + back-reference.
 */
export function span(
  inner: Code | string,
  meta: { path: ReadonlyArray<string | number>; expr?: Expr; type?: Type },
): Code {
  const innerCode = typeof inner === 'string' ? new Code(inner) : inner;
  const outer: Span = {
    start: 0,
    end: innerCode.text.length,
    path: meta.path,
    expr: meta.expr,
    type: meta.type,
  };
  // Outer span first so it's iterated before the inner ones — affects
  // tie-breaking only marginally (longest-prefix wins regardless).
  return new Code(innerCode.text, [outer, ...innerCode.spans]);
}

/**
 * Tagged template — primary builder. Interpolates strings and Codes
 * into a single Code, shifting child spans to their position in the
 * combined text. Newlines and indentation are preserved verbatim;
 * use `.indent(prefix)` on a Code for line-relative reindentation.
 *
 * Example:
 *   const head = this.value.toGinCode(reg, opts, [...path, 'value']);
 *   return code`switch (${head}) {\n${body}\n}`;
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

/**
 * Join an array of Code (or string) values with a separator into one
 * Code. Like `Array.prototype.join` but span-preserving. Common
 * pattern: rendering a list of cases / lines / fields.
 */
export function joinCode(parts: ReadonlyArray<Code | string>, sep: string | Code = ''): Code {
  if (parts.length === 0) return new Code('');
  const sepCode = typeof sep === 'string' ? new Code(sep) : sep;
  let result = typeof parts[0] === 'string' ? new Code(parts[0]) : parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    result = result.concat(sepCode).concat(parts[i]!);
  }
  return result;
}

/**
 * Convenience: `joinCode(parts, '\n')`. Used heavily by composite
 * Exprs that emit one rendered line per child (block lines, define
 * vars, switch cases, …).
 */
export function joinLines(parts: ReadonlyArray<Code | string>): Code {
  return joinCode(parts, '\n');
}

// ─── JSON builders (for `toJSONCode` overrides) ──────────────────────────────

export interface JSONEntry {
  key: string;
  /** Field value rendered as Code (or pre-stringified primitive). When
   *  `undefined`, the entry is OMITTED — matches `JSON.stringify`'s
   *  behaviour of dropping `undefined` properties. */
  value: Code | string | undefined;
}

/**
 * Build a JSON object literal as a `Code` with the same indentation
 * shape `JSON.stringify(obj, null, indent)` produces. Each entry's
 * `value` is appended verbatim, so child `Code` values must already
 * be rendered for the matching depth (`level + 1`). The outer
 * `{ ... }` block is wrapped in a single span tagged with `meta`.
 *
 * Empty objects render as `{}` on one line, like JSON.stringify.
 */
export function jsonObject(
  entries: ReadonlyArray<JSONEntry>,
  meta: { path: ReadonlyArray<string | number>; expr?: Expr; type?: Type },
  level: number = 0,
  indent: number = 2,
): Code {
  const filtered = entries.filter((e) => e.value !== undefined);
  if (filtered.length === 0) return span('{}', meta);
  const childIndent = ' '.repeat((level + 1) * indent);
  const closeIndent = ' '.repeat(level * indent);
  const lines: Code[] = filtered.map(({ key, value }) => {
    const valueCode = typeof value === 'string' ? new Code(value) : value as Code;
    return code`${childIndent}${JSON.stringify(key)}: ${valueCode}`;
  });
  return span(code`{\n${joinCode(lines, ',\n')}\n${closeIndent}}`, meta);
}

/**
 * Build a JSON array literal. Items are rendered verbatim, comma-and-
 * newline separated, with `(level + 1) * indent` spaces of leading
 * indent on each item.
 */
export function jsonArray(
  items: ReadonlyArray<Code | string>,
  meta: { path: ReadonlyArray<string | number>; expr?: Expr; type?: Type },
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

/** Quote-and-escape a JSON string value. Convenience for tagged-template
 *  callers that want an inline literal without leaving the `code`/`span`
 *  builder world. */
export function jsonString(value: string): string {
  return JSON.stringify(value);
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

export interface FormatOptions {
  /** Emit ANSI color codes. Default false. */
  color?: boolean;
}

export interface FormatProblemsOptions extends FormatOptions {
  /** Number of context lines above/below each problem's span. Adjacent
   *  problems whose context windows touch get merged into one section.
   *  Default 2. */
  contextLines?: number;
  /** Show `── lines N-M ───` header above each merged section. Default true. */
  sectionHeaders?: boolean;
  /** Show 1-based line-number gutter (`  5 │ <line>`). Default true. */
  lineNumbers?: boolean;
  /** Cap on the number of problems rendered. Default Infinity. */
  maxProblems?: number;
}

interface ResolvedProblem {
  problem: Problem;
  firstLine: number;
  lastLine: number;
  /** Map from line index → that line's clipped (startCol, endCol) of the span. */
  hits: Map<number, { startCol: number; endCol: number }>;
}

interface Section {
  firstLine: number;
  lastLine: number;
  problems: ResolvedProblem[];
}

/**
 * Render one Problem against `code`. Convenience wrapper that builds a
 * one-element Problems-like list and delegates to the section renderer
 * so the output stays consistent with `formatProblems`.
 */
export function formatProblem(
  code: Code,
  problem: Problem,
  opts: FormatOptions = {},
): string {
  return renderProblems(code, [problem], {
    ...opts,
    // Single-problem renders default to no section header / no line
    // numbers — matches the older terse output callers expect.
    sectionHeaders: false,
    lineNumbers: false,
    contextLines: 0,
  });
}

/**
 * Render every Problem against `code` as a sequence of sections. Each
 * section is a contiguous block of source lines containing one or more
 * problems plus a configurable buffer of surrounding context. Sections
 * whose context windows overlap are merged so problems near each other
 * share their surrounding code instead of repeating it.
 *
 * Output shape (with defaults):
 *
 *   ── lines 5-7 ───────────────────
 *     5 │ const x: num = "wrong";
 *                        ^^^^^^^
 *                        error: var 'x' value type 'text' not compatible with declared 'num'
 *     6 │ x;
 *     7 │ }
 *
 *   ── lines 12-14 ──────────────────
 *    12 │ if (1) {
 *              ^
 *              warning: if condition should be bool, got 'num'
 *    13 │   x;
 *    14 │ }
 *
 * Problems whose path resolves to no span fall through to a plain
 * `<severity>: <message> @ <path>` line appended after the sections.
 */
export function formatProblems(
  code: Code,
  problems: Problems,
  opts: FormatProblemsOptions = {},
): string {
  return renderProblems(code, problems.list, opts);
}

function renderProblems(
  code: Code,
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
  const lines = code.toLines();

  const resolved: ResolvedProblem[] = [];
  const fallback: string[] = [];
  let suppressed = 0;
  for (let i = 0; i < list.length; i++) {
    if (i >= max) { suppressed = list.length - i; break; }
    const p = list[i]!;
    const r = resolveProblem(code, lines, p);
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

/** Resolve a Problem to its line/column hits across the rendered code. */
function resolveProblem(code: Code, lines: CodeLine[], problem: Problem): ResolvedProblem | null {
  const matched = code.spanFor(problem.path);
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

/** Group resolved problems into sections of contiguous lines. Each
 *  problem's lines are extended by `contextLines` above/below; sections
 *  whose extended ranges touch get merged and accumulate their problems. */
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
      // Adjacent / overlapping windows merge into the prior section.
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
  const { color, sectionHeaders, lineNumbers, gutterWidth, c } = opts;
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

  // Severity ordering — when multiple problems share an identical
  // (startCol, endCol) range on a line, the underline is rendered once
  // colored by the most severe of the group. Index = sort key (lower
  // wins → more severe).
  const SEV_RANK: Record<Problem['severity'], number> = { error: 0, warning: 1, info: 2 };

  for (let i = section.firstLine; i <= section.lastLine; i++) {
    out.push(numberedGutter(i + 1) + lines[i]!.text);

    // Dedupe underlines on this line: multiple problems whose spans
    // collapse to the SAME (startCol, endCol) on this line share one
    // underline instead of stacking 5 identical `^^^^` rows. The most
    // severe color wins. (Different ranges still render separately.)
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

    // Messages: every problem whose span ENDS on this line gets its
    // severity-prefixed message immediately under its underline. This
    // keeps the message anchored to the bottom of its underlined block,
    // which reads naturally for both single-line and multi-line spans.
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
