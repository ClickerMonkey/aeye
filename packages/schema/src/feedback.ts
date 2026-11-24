/**
 * Errors for the model: what a model is told when its answer doesn't fit.
 *
 * The approach is gin's and query's (`Code.formatProblems`, `aids.ts`): the
 * model's own JSON echoed back with a marker under each bad spot, the message
 * at the marker, and "did you mean" for names it misspelt. Here it is the
 * native output of every decode, with a size budget, so a huge schema (the
 * whole gin grammar, query's `typed` functions) still gets a short message.
 *
 * Everything is in the MODEL's shape: the paths and the JSON are what it
 * wrote (pairs, `null` for absent, JSON text, a tool called through the
 * dispatcher), never the code shape. The expected type at a bad spot is read
 * from the JSON Schema the model was given, so it is the wire type too.
 *
 * Cost: nothing is computed on the happy path. On a failure, only the
 * problems that are shown get suggestions and expected types, and the echo
 * walks only the paths to them (siblings are summarized, never serialized
 * whole).
 */
import type { Issue, JsonSchema, Node, PathSeg } from './render';
import { nearest, rankNear } from './suggest';

// ============================================================================
// Options
// ============================================================================

/**
 * How much the model is told:
 *
 * - `'summary'` — one line: the first problem and how many more.
 * - `'list'` — one line per problem: where and what (and "did you mean").
 * - `'markers'` — the model's JSON echoed back, trimmed around the problems,
 *   with a marker (`^^^`) and the message under each bad spot.
 * - `'full'` — markers, plus the expected type at each spot.
 */
export type ErrorDetail = 'summary' | 'list' | 'markers' | 'full';

/** Options for the error feedback a model gets. Set on a tool / prompt, overridable per call. */
export interface ErrorFormat {
  /** Default `'full'`. */
  readonly detail?: ErrorDetail;
  /** Distinct problems shown (repeats of one mistake count once); the rest are counted. Default 5. */
  readonly maxErrors?: number;
  /** Hard cap on the message, in characters. Detail is dropped step by step to fit. Default 2000. */
  readonly maxChars?: number;
  /** "Did you mean" for unknown keys, enum values, tags and tool names. Default true. */
  readonly suggestions?: boolean;
  /** The expected type (a short TypeScript-like type of just that spot). Default: on for `'full'`. */
  readonly expected?: boolean;
  /** Sibling keys / items shown next to a bad spot in the echo. Default 3. */
  readonly context?: number;
  /** Levels of the answer shown above a bad spot; a deeper spot is echoed from there down. Default 6. */
  readonly depth?: number;
  /** The first line saying how many problems there are and in what. Default true. */
  readonly header?: boolean;
}

/** An `ErrorFormat`, or just its detail level. */
export type ErrorFormatInput = ErrorDetail | ErrorFormat;

/** The defaults (`expected` follows the detail level unless set). */
export const DEFAULT_ERROR_FORMAT: Readonly<Required<Omit<ErrorFormat, 'expected'>>> = Object.freeze({
  detail: 'full',
  maxErrors: 5,
  maxChars: 2000,
  suggestions: true,
  context: 3,
  depth: 6,
  header: true,
});

export type ResolvedErrorFormat = Required<ErrorFormat>;

/** Merge formats left to right (later wins: request, then definition, then call), without filling defaults. */
export function mergeErrorFormats(...inputs: readonly (ErrorFormatInput | undefined)[]): ErrorFormat | undefined {
  let merged: ErrorFormat | undefined;
  for (const i of inputs) if (i !== undefined) merged = { ...merged, ...stripUndefined(typeof i === 'string' ? { detail: i } : i) };
  return merged;
}

/** Merge formats left to right (later wins) and fill the defaults. */
export function errorFormat(...inputs: readonly (ErrorFormatInput | undefined)[]): ResolvedErrorFormat {
  const merged: ErrorFormat = mergeErrorFormats(...inputs) ?? {};
  const detail = merged.detail ?? DEFAULT_ERROR_FORMAT.detail;
  return {
    ...DEFAULT_ERROR_FORMAT,
    ...merged,
    detail,
    expected: merged.expected ?? detail === 'full',
  };
}

function stripUndefined(o: ErrorFormat): ErrorFormat {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as ErrorFormat;
}

/** Whether a format echoes the answer (so a failed in-place decode must keep the original). */
export function echoes(f: ErrorFormatInput | undefined): boolean {
  const d = typeof f === 'string' ? f : f?.detail ?? DEFAULT_ERROR_FORMAT.detail;
  return d === 'markers' || d === 'full';
}

// ============================================================================
// What a failure was about
// ============================================================================

/**
 * The kind of a problem. It decides what "did you mean" compares, and
 * whether the expected type adds anything to the message.
 */
export type IssueKind =
  | 'type'         // a value of the wrong JSON type
  | 'required'     // a missing key
  | 'unknown-key'  // a key a closed object doesn't have
  | 'not-allowed'  // a key the model may not send (people-only, never)
  | 'enum'         // a string outside an enum
  | 'literal'      // not the one allowed value
  | 'tag'          // a discriminator that names no option
  | 'tool'         // a dispatcher (or request) call to no such tool
  | 'union'        // matched no option of a union
  | 'rule'         // a constraint or refinement
  | 'json'         // not valid JSON text
  | 'other';

/** Kept per issue, off the issue object (issues stay plain `{ path, codePath, message }`). */
export interface IssueInfo {
  readonly kind: IssueKind;
  /** The node that failed (its JSON Schema is the expected type). */
  node?: Node | undefined;
  /** The value the model wrote there, when a suggestion compares it. */
  readonly received?: unknown;
  /** The names a misspelling is compared with. */
  readonly candidates?: (() => readonly string[]) | undefined;
}

const infos = new WeakMap<Issue, IssueInfo>();

/** @internal Attach what a failure was about to its issue. */
export function recordIssue(issue: Issue, info: IssueInfo): void {
  infos.set(issue, info);
}

/** @internal The issues from `from` on that have no node yet were raised by `node` (the innermost to finish). */
export function claimIssues(issues: readonly Issue[], from: number, node: Node): void {
  for (let i = from; i < issues.length; i++) {
    const info = infos.get(issues[i]!);
    if (info && !info.node) info.node = node;
  }
}

/** What an issue was about (`'other'` for issues not made by a decode). */
export function issueKind(issue: Issue): IssueKind {
  return infos.get(issue)?.kind ?? 'other';
}

/**
 * The nearest valid name to what the model wrote at an issue (an unknown key,
 * enum value, tag or tool), if it is a genuine typo. For a missing key, the
 * key the model wrote instead of it (`pth` for a missing `path`).
 */
export function suggestionFor(issue: Issue): string | undefined {
  const info = infos.get(issue);
  if (!info?.candidates) return undefined;
  const input = info.kind === 'unknown-key' || info.kind === 'required' ? issue.path[issue.path.length - 1] : info.received;
  if (typeof input !== 'string') return undefined;
  return nearest(input, info.candidates());
}

// ============================================================================
// Paths, as the model reads them
// ============================================================================

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** `rows[2].tags`, with a JSON-text step written `→ JSON text →`. */
export function modelPath(path: readonly PathSeg[]): string {
  let out = '';
  let part = '';
  for (const seg of path) {
    if (seg === '(json)') {
      out += `${part || '(root)'} → JSON text → `;
      part = '';
      continue;
    }
    part += typeof seg === 'number' ? `[${seg}]` : IDENT.test(seg) ? (part ? `.${seg}` : seg) : `[${JSON.stringify(seg)}]`;
  }
  if (out && !part) return out.slice(0, -3);
  return out + (part || (out ? '' : '(root)'));
}

const ABSENT: unique symbol = Symbol('absent');

/** The value at a wire path: through JSON text (`(json)`) and containers sent as JSON strings. */
function valueAt(root: unknown, path: readonly PathSeg[]): unknown {
  let v: unknown = root;
  for (const seg of path) {
    if (seg === '(json)') {
      if (typeof v !== 'string') continue; // written directly where JSON text was asked for (repaired)
      v = parseOr(v);
      if (v === ABSENT) return ABSENT;
      continue;
    }
    if (typeof v === 'string') v = parseOr(v);
    if (v === null || typeof v !== 'object') return ABSENT;
    if (!Object.prototype.hasOwnProperty.call(v, seg)) return ABSENT;
    v = (v as Record<string, unknown>)[seg as string];
  }
  return v;
}

/** JSON texts parsed while formatting one message (a deep grammar's JSON text is read at every step otherwise). */
let parsedTexts: Map<string, unknown> | undefined;

function parseOr(s: string): unknown {
  const hit = parsedTexts?.get(s);
  if (hit !== undefined) return hit;
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    v = ABSENT;
  }
  parsedTexts?.set(s, v);
  return v;
}

// ============================================================================
// Expected types: a short TypeScript-like type of one spot
// ============================================================================

/** A short TypeScript-like type of a JSON Schema (what the model was given at one spot), at most `max` characters. */
export function shortType(json: JsonSchema, max = 160): string {
  for (const depth of [2, 1, 0]) {
    const t = tsOf(json, depth, 6);
    if (t.length <= max) return t;
  }
  const t = tsOf(json, 0, 3);
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function refName(ref: string): string {
  const name = ref.replace(/^#\/\$defs\//, '');
  return name.replace(/~1/g, '/').replace(/~0/g, '~');
}

function tsOf(j: JsonSchema, depth: number, width: number): string {
  if (typeof j.$ref === 'string') return refName(j.$ref);
  if ('const' in j) return JSON.stringify(j.const);
  if (Array.isArray(j.enum)) return listed(j.enum.map((v) => JSON.stringify(v)), width, ' | ');
  const opts = (j.anyOf ?? j.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(opts)) {
    const ts = [...new Set(opts.map((o) => tsOf(o, depth, width)))];
    return listed(ts, width, ' | ', 'options');
  }
  if (Array.isArray(j.allOf)) return (j.allOf as JsonSchema[]).map((o) => paren(tsOf(o, depth, width))).join(' & ');
  if (Array.isArray(j.type)) return (j.type as string[]).map((t) => tsOf({ ...j, type: t }, depth, width)).join(' | ');
  if (j.nullable === true) return `${paren(tsOf({ ...j, nullable: false }, depth, width))} | null`;
  switch (j.type) {
    case 'string': {
      if (typeof j.description === 'string' && /JSON text/.test(j.description)) {
        const m = /TypeScript type: ([^\n(]+?)(?: \(its named types|\.\s*$)/.exec(j.description);
        return m ? `string (JSON text of ${m[1]!.trim()})` : 'string (JSON text)';
      }
      return typeof j.format === 'string' ? `string (${j.format})` : 'string';
    }
    case 'integer': return 'integer';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': {
      if (Array.isArray(j.prefixItems)) return `[${(j.prefixItems as JsonSchema[]).map((x) => tsOf(x, depth - 1, width)).join(', ')}]`;
      const items = j.items && typeof j.items === 'object' ? tsOf(j.items as JsonSchema, depth - 1, width) : 'any';
      return `${paren(items)}[]`;
    }
    case 'object': {
      const props = (j.properties ?? {}) as Record<string, JsonSchema>;
      const keys = Object.keys(props);
      const extra = j.additionalProperties && typeof j.additionalProperties === 'object' ? (j.additionalProperties as JsonSchema) : undefined;
      if (!keys.length && !extra) return j.additionalProperties === false ? '{}' : 'object';
      if (depth <= 0) return '{…}';
      const req = new Set((j.required ?? []) as string[]);
      const parts = keys.slice(0, width).map((k) => `${IDENT.test(k) ? k : JSON.stringify(k)}${req.has(k) ? '' : '?'}: ${tsOf(props[k]!, depth - 1, width)}`);
      if (keys.length > width) parts.push(`… ${keys.length - width} more`);
      if (extra) parts.push(`[key: string]: ${tsOf(extra, depth - 1, width)}`);
      return `{ ${parts.join('; ')} }`;
    }
    default:
      return 'any JSON value';
  }
}

function paren(t: string): string {
  return / \| | & /.test(t) && !/^[{[(]/.test(t) ? `(${t})` : t;
}

function listed(items: readonly string[], width: number, sep: string, noun = 'more'): string {
  if (items.length <= width) return items.join(sep);
  return `${items.slice(0, width).join(sep)}${sep}… (${items.length} ${noun === 'more' ? 'values' : noun})`;
}

/** The expected type at an issue, or undefined when the message already says it. */
function expectedOf(issue: Issue, info: IssueInfo | undefined): string | undefined {
  const node = info?.node;
  if (!node || !info) return undefined;
  if (info.kind === 'enum' || info.kind === 'literal' || info.kind === 'tag' || info.kind === 'tool' || info.kind === 'rule' || info.kind === 'unknown-key' || info.kind === 'not-allowed') return undefined;
  try {
    if (node.jsonText && node.schema) {
      const text = node.typeText();
      return `string (JSON text of ${text.length > 120 ? `${text.slice(0, 119)}…` : text})`;
    }
    const t = shortType(node.json());
    // "Expected a number, got string." already says it.
    if (info.kind === 'type' && /^(string|number|integer|boolean|null)$/.test(t)) return undefined;
    return t;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Problems: issues grouped, with suggestions
// ============================================================================

interface Problem {
  readonly issue: Issue;
  readonly info: IssueInfo | undefined;
  /** Every issue of this group (the same mistake repeated at like paths). */
  readonly paths: PathSeg[][];
}

function groupKey(i: Issue): string {
  let k = i.message;
  for (const s of i.path) k += `\u0000${typeof s === 'number' ? '#' : s}`;
  return k;
}

function problemsOf(issues: readonly Issue[]): Problem[] {
  const out: Problem[] = [];
  const byKey = new Map<string, Problem>();
  for (const issue of issues) {
    const key = groupKey(issue);
    const g = byKey.get(key);
    if (g) { g.paths.push(issue.path as PathSeg[]); continue; }
    const p: Problem = { issue, info: infos.get(issue), paths: [issue.path as PathSeg[]] };
    byKey.set(key, p);
    out.push(p);
  }
  return out;
}

/** The message, its "did you mean" and the repeats, as the model reads them. */
function problemText(p: Problem, f: Shaping): string {
  let text = p.issue.message;
  const kind = p.info?.kind;
  // Short of space: a list of allowed values becomes their count (the suggestion stays).
  if (f.terse && p.info?.candidates && (kind === 'enum' || kind === 'tag' || kind === 'tool')) {
    const n = p.info.candidates().length;
    text = text.replace(/ one of: .*$/s, ` one of ${n} value${n === 1 ? '' : 's'}.`);
  }
  if (f.suggestions && p.info?.candidates) {
    const s = suggestionText(p.issue, p.info);
    if (s) text = text.replace(/\.$/, '') + s;
  }
  if (p.paths.length > 1) {
    if (f.terse) text += ` (the same at ${p.paths.length - 1} more place${p.paths.length === 2 ? '' : 's'})`;
    else {
      const more = p.paths.slice(1, 3).map(modelPath);
      const rest = p.paths.length - 1 - more.length;
      text += ` (the same at ${more.join(', ')}${rest > 0 ? ` and ${rest} more place${rest === 1 ? '' : 's'}` : ''})`;
    }
  }
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

function suggestionText(issue: Issue, info: IssueInfo): string {
  const cands = info.candidates!();
  if (!cands.length) return '';
  if (info.kind === 'required') {
    const key = issue.path[issue.path.length - 1];
    if (typeof key !== 'string') return '';
    const near = nearest(key, cands);
    return near ? ` — you wrote \`${near}\`; did you mean \`${key}\`?` : '';
  }
  const input = info.kind === 'unknown-key' ? issue.path[issue.path.length - 1] : info.received;
  if (typeof input !== 'string') return '';
  const near = rankNear(input, cands)[0];
  return near !== undefined && near !== input ? ` — did you mean \`${near}\`?` : '';
}

// ============================================================================
// The message
// ============================================================================

/**
 * The message for a failed decode: `issues` (from `parse`) over `wire`, the
 * value the model sent (untouched: `parse` keeps it when it echoes). `label`
 * names what the model wrote: `'your answer'`, `'the arguments of search'`.
 */
export function formatErrors(issues: readonly Issue[], wire: unknown, format?: ErrorFormatInput | ResolvedErrorFormat, label = 'your answer'): string {
  if (!issues.length) return '';
  const f = isResolved(format) ? format : errorFormat(format);
  const all = problemsOf(f.suggestions ? oneMistakeOnce(issues) : issues);
  const outer = parsedTexts;
  parsedTexts = new Map();
  try {
    for (const attempt of attempts(f)) {
      const out = render(all, wire, attempt, label);
      if (out.length <= f.maxChars) return out;
    }
    const last = render(all, wire, { ...f, detail: 'summary', maxErrors: 1, terse: true }, label);
    return last.length <= f.maxChars ? last : `${last.slice(0, Math.max(0, f.maxChars - 1))}…`;
  } finally {
    parsedTexts = outer;
  }
}

/**
 * A misspelt key on a closed object is two issues: the unknown key, and the
 * missing key it was meant to be. When the missing key's "did you mean" names
 * the unknown one, it is one mistake, told once (at the missing key).
 */
function oneMistakeOnce(issues: readonly Issue[]): readonly Issue[] {
  let drop: Set<string> | undefined;
  let checked = 0;
  for (const i of issues) {
    const info = infos.get(i);
    if (info?.kind !== 'required' || !info.candidates || ++checked > 50) continue;
    const key = i.path[i.path.length - 1];
    const near = typeof key === 'string' ? nearest(key, info.candidates()) : undefined;
    if (near !== undefined) (drop ??= new Set()).add(keyOf([...i.path.slice(0, -1), near]));
  }
  if (!drop) return issues;
  return issues.filter((i) => !(infos.get(i)?.kind === 'unknown-key' && drop!.has(keyOf(i.path))));
}

function isResolved(f: unknown): f is ResolvedErrorFormat {
  return typeof f === 'object' && f !== null && 'detail' in f && 'maxChars' in f && 'expected' in f && 'context' in f && 'depth' in f && 'header' in f && 'suggestions' in f && 'maxErrors' in f;
}

/** A resolved format plus `terse` (value lists and repeat paths shortened), the last step before cutting. */
type Shaping = ResolvedErrorFormat & { readonly terse?: boolean };

/** Richest first; each step drops some detail until the message fits `maxChars`, trying it terse before dropping more. */
function* attempts(f: ResolvedErrorFormat): Generator<Shaping> {
  for (const s of steps(f)) {
    yield s;
    yield { ...s, terse: true };
  }
}

function* steps(f: Shaping): Generator<Shaping> {
  let cur = f;
  yield cur;
  if (cur.detail === 'markers' || cur.detail === 'full') {
    if (cur.expected) yield (cur = { ...cur, expected: false });
    if (cur.context > 0) yield (cur = { ...cur, context: 0 });
    if (cur.depth > 2) yield (cur = { ...cur, depth: 2 });
    while (cur.maxErrors > 1) yield (cur = { ...cur, maxErrors: Math.max(1, Math.floor(cur.maxErrors / 2)) });
    yield (cur = { ...cur, detail: 'list', maxErrors: f.maxErrors });
  }
  while (cur.maxErrors > 1) yield (cur = { ...cur, maxErrors: Math.max(1, Math.floor(cur.maxErrors / 2)) });
  if (cur.detail !== 'summary') yield { ...cur, detail: 'summary' };
}

function render(all: readonly Problem[], wire: unknown, f: Shaping, label: string): string {
  const shown = all.slice(0, Math.max(1, f.maxErrors));
  const total = all.reduce((n, p) => n + p.paths.length, 0);
  const hiddenGroups = all.length - shown.length;
  const hidden = all.slice(shown.length).reduce((n, p) => n + p.paths.length, 0);
  const count = `${total} problem${total === 1 ? '' : 's'}`;
  if (f.detail === 'summary') {
    const p = shown[0]!;
    const more = total - p.paths.length;
    return `${f.header ? `${total === 1 ? 'A problem' : count} in ${label}: ` : ''}at ${modelPath(p.issue.path)}: ${problemText(p, f)}${more > 0 ? ` (and ${more} more problem${more === 1 ? '' : 's'})` : ''}`;
  }
  const lines: string[] = [];
  if (f.header) lines.push(`${count} in ${label}:`);
  if (f.detail === 'list') {
    for (const p of shown) {
      const exp = f.expected ? expectedOf(p.issue, p.info) : undefined;
      lines.push(`- at ${modelPath(p.issue.path)}: ${problemText(p, f)}${exp ? ` (expected: ${exp})` : ''}`);
    }
  } else {
    if (f.header) lines.push('');
    lines.push(...echo(shown, wire, f));
  }
  if (hidden > 0) lines.push(`… and ${hidden} more problem${hidden === 1 ? '' : 's'}${hiddenGroups > 1 ? ` (${hiddenGroups} kinds)` : ''} not shown.`);
  return lines.join('\n');
}

// ============================================================================
// The echo: the model's JSON with markers
// ============================================================================

type Where = 'value' | 'key' | 'missing';
interface Mark {
  readonly p: Problem;
  readonly where: Where;
}

const keyOf = (path: readonly PathSeg[]): string => {
  let k = '';
  for (const s of path) k += `${typeof s === 'number' ? '#' : '$'}${s}\u0000`;
  return k;
};

function cmpPath(a: readonly PathSeg[], b: readonly PathSeg[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return a.length - b.length;
}

function commonPrefix(a: readonly PathSeg[], b: readonly PathSeg[]): PathSeg[] {
  const out: PathSeg[] = [];
  for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) out.push(a[i]!);
  return out;
}

/** Depth of a path in levels of the answer (a JSON-text step is not a level). */
const levels = (path: readonly PathSeg[]): number => path.filter((s) => s !== '(json)').length;

function echo(shown: readonly Problem[], wire: unknown, f: Shaping): string[] {
  // Where each problem is marked: at its value, at its key (a key that isn't allowed), or at its object (a missing key).
  const located: { p: Problem; at: PathSeg[]; where: Where }[] = [];
  const unplaced: Problem[] = [];
  for (const p of shown) {
    const path = p.issue.path as PathSeg[];
    const kind = p.info?.kind;
    if (wire === undefined) unplaced.push(p);
    else if (valueAt(wire, path) !== ABSENT) {
      located.push({ p, at: path, where: kind === 'unknown-key' || kind === 'not-allowed' ? 'key' : 'value' });
    } else if (path.length && isContainer(valueAt(wire, path.slice(0, -1)))) {
      located.push({ p, at: path.slice(0, -1), where: 'missing' });
    } else unplaced.push(p);
  }
  located.sort((x, y) => cmpPath(x.p.issue.path, y.p.issue.path));

  // Sections: each echoed from an anchor at most `depth` levels above its problems.
  const sections: { anchor: PathSeg[]; members: typeof located }[] = [];
  const anchorFor = (path: readonly PathSeg[]): PathSeg[] => {
    const out: PathSeg[] = [];
    for (const seg of path) {
      if (levels(path) - levels(out) <= f.depth) break;
      out.push(seg);
    }
    return out;
  };
  for (const l of located) {
    const cur = sections[sections.length - 1];
    if (cur) {
      const cp = commonPrefix(cur.anchor, l.at);
      const fits = [...cur.members, l].every((m) => levels(m.at) - levels(cp) <= f.depth + 1);
      if (fits) { cur.anchor = cp; cur.members.push(l); continue; }
    }
    sections.push({ anchor: anchorFor(l.at), members: [l] });
  }

  const out: string[] = [];
  for (const s of sections) {
    let anchor = s.anchor;
    while (anchor.length && valueAt(wire, anchor) === ABSENT) anchor = anchor.slice(0, -1);
    const marks = new Map<string, Mark[]>();
    const below = new Map<string, Set<PathSeg>>();
    for (const m of s.members) {
      const k = keyOf(m.at);
      const list = marks.get(k);
      if (list) list.push({ p: m.p, where: m.where }); else marks.set(k, [{ p: m.p, where: m.where }]);
      for (let i = anchor.length; i < m.at.length; i++) {
        const pk = keyOf(m.at.slice(0, i));
        const kids = below.get(pk);
        if (kids) kids.add(m.at[i]!); else below.set(pk, new Set([m.at[i]!]));
      }
    }
    if (out.length) out.push('');
    if (anchor.length) out.push(`at ${modelPath(anchor)}:`);
    new Echo(marks, below, f, out, anchor.length).node(valueAt(wire, anchor), anchor, '', '', '');
  }
  for (const p of unplaced) out.push(`- at ${modelPath(p.issue.path)}: ${problemText(p, f)}`);
  return out;
}

const isContainer = (v: unknown): v is object => typeof v === 'object' && v !== null;

/** A path below a section's header path: `….ifs[0].body.kind`, `…[3].name`, `… → JSON text → kind`. */
function relPath(rest: readonly PathSeg[]): string {
  if (!rest.length) return '…';
  const head = rest[0]!;
  const text = modelPath(rest);
  if (head === '(json)') return `… → ${text.replace(/^\(root\) → /, '')}`;
  return typeof head === 'number' || !IDENT.test(head) ? `…${text}` : `….${text}`;
}

class Echo {
  constructor(
    private readonly marks: ReadonlyMap<string, Mark[]>,
    /** Paths above a problem, with the child segments that lead to one. */
    private readonly below: ReadonlyMap<string, ReadonlySet<PathSeg>>,
    private readonly f: Shaping,
    private readonly out: string[],
    /** Segments of the section's path (its header): a marker names its path from there, after `…`. */
    private readonly from = 0,
  ) {}

  node(v: unknown, path: PathSeg[], indent: string, prefix: string, comma: string): void {
    const k = keyOf(path);
    const deeper = this.below.has(k);
    // JSON text (or a container sent as a string) with problems inside: shown parsed.
    if (typeof v === 'string' && deeper) {
      const parsed = parseOr(v);
      if (parsed !== ABSENT) {
        const jp = [...path, '(json)'];
        const jk = keyOf(jp);
        if (this.marks.has(jk) || this.below.has(jk)) return this.node(parsed, jp, indent, `${prefix}/* JSON text */ `, comma);
        return this.node(parsed, path, indent, prefix, comma);
      }
    }
    const marks = this.marks.get(k) ?? [];
    const open = isContainer(v) && (deeper || marks.some((m) => m.where === 'missing'));
    if (!open) {
      const text = inline(v, 60);
      this.out.push(indent + prefix + text + comma);
      for (const m of marks) {
        if (m.where === 'key') this.mark(m.p, indent.length, prefix.length + text.length);
        else this.mark(m.p, indent.length + prefix.length, text.length);
      }
      return;
    }
    const arr = Array.isArray(v);
    this.out.push(`${indent}${prefix}${arr ? '[' : '{'}`);
    for (const m of marks) this.mark(m.p, indent.length + prefix.length, 1);
    const inner = `${indent}  `;
    if (arr) this.items(v as unknown[], path, inner);
    else this.keys(v as Record<string, unknown>, path, inner);
    this.out.push(`${indent}${arr ? ']' : '}'}${comma}`);
  }


  private keys(obj: Record<string, unknown>, path: PathSeg[], indent: string): void {
    const keys = Object.keys(obj);
    const kids = this.below.get(keyOf(path));
    const on = keys.filter((key) => kids?.has(key));
    // Context: up to `context` other keys, the short ones (a `kind`, a name) first, in their order.
    const others = keys.filter((key) => !on.includes(key));
    const short = new Set(others.filter((key) => inline(obj[key], 40).length <= 40 && !isContainer(obj[key])).slice(0, this.f.context));
    for (const key of others) if (short.size < this.f.context && !short.has(key)) short.add(key);
    const show = keys.filter((key) => on.includes(key) || short.has(key));
    const elided = keys.length - show.length;
    show.forEach((key, i) => {
      const last = i === show.length - 1 && !elided;
      this.node(obj[key], [...path, key], indent, `${JSON.stringify(key)}: `, last ? '' : ',');
    });
    if (elided) this.out.push(`${indent}… ${elided} more key${elided === 1 ? '' : 's'}`);
  }

  private items(arr: unknown[], path: PathSeg[], indent: string): void {
    const on = new Set<number>();
    for (const i of this.below.get(keyOf(path)) ?? []) if (typeof i === 'number' && i < arr.length) on.add(i);
    // A short list is shown whole (when its items are short); otherwise only the items with problems.
    const whole = arr.length - on.size <= this.f.context && arr.every((x, i) => on.has(i) || inline(x, 40).length <= 40);
    let skipped = 0;
    let elidedAny = false;
    const flush = () => {
      if (!skipped) return;
      this.out.push(`${indent}… ${skipped} item${skipped === 1 ? '' : 's'}`);
      skipped = 0;
      elidedAny = true;
    };
    for (let i = 0; i < arr.length; i++) {
      if (!whole && !on.has(i)) { skipped++; continue; }
      flush();
      const last = i === arr.length - 1;
      const tag = elidedAny || (!whole && i > 0) ? `/* ${i} */ ` : '';
      this.node(arr[i], [...path, i], indent, tag, last ? '' : ',');
    }
    flush();
  }

  private mark(p: Problem, col: number, width: number): void {
    const w = Math.max(1, Math.min(width, 40));
    const text = `${this.from ? relPath(p.issue.path.slice(this.from)) : modelPath(p.issue.path)}: ${problemText(p, this.f)}`;
    this.out.push(`${' '.repeat(col)}${'^'.repeat(w)} ${text}`);
    const exp = this.f.expected ? expectedOf(p.issue, p.info) : undefined;
    if (exp) this.out.push(`${' '.repeat(col + w + 1)}expected: ${exp}`);
  }
}

/**
 * One-line JSON of a value, at most about `max` characters: a short value as
 * is, a long string cut, a bigger container summarized (`{… 4 keys}`,
 * `[… 1000 items]`). Never serializes more than `max` characters of it.
 */
function inline(v: unknown, max: number): string {
  if (typeof v === 'string') {
    const s = JSON.stringify(v);
    return s.length <= max ? s : `${s.slice(0, max - 2)}…"`;
  }
  if (!isContainer(v)) return v === undefined ? 'undefined' : JSON.stringify(v);
  const small = boundedJson(v, max);
  if (small !== undefined) return small;
  if (Array.isArray(v)) return `[… ${v.length} item${v.length === 1 ? '' : 's'}]`;
  const n = Object.keys(v).length;
  return `{… ${n} key${n === 1 ? '' : 's'}}`;
}

/** Compact JSON of `v` if it is at most `max` characters, else undefined (stops early). */
function boundedJson(v: unknown, max: number): string | undefined {
  let out = '';
  const go = (x: unknown): boolean => {
    if (out.length > max) return false;
    if (Array.isArray(x)) {
      out += '[';
      for (let i = 0; i < x.length; i++) {
        if (i) out += ',';
        if (!go(x[i])) return false;
      }
      out += ']';
      return out.length <= max;
    }
    if (isContainer(x)) {
      out += '{';
      let first = true;
      for (const k of Object.keys(x)) {
        const val = (x as Record<string, unknown>)[k];
        if (val === undefined) continue;
        if (!first) out += ',';
        first = false;
        out += `${JSON.stringify(k)}:`;
        if (!go(val)) return false;
      }
      out += '}';
      return out.length <= max;
    }
    out += x === undefined ? 'null' : JSON.stringify(x);
    return out.length <= max;
  };
  return go(v) ? out : undefined;
}
