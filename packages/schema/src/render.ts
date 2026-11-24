/**
 * Rendering: one compiled `Node` per (schema, profile). A node knows how to
 *
 * - `json()`   — emit the JSON Schema the model is given (memoized),
 * - `run()`    — validate the model's answer AND decode it into the code
 *                shape in one walk, reporting errors at the path the model
 *                wrote (wire path) and the path the code sees (code path),
 * - `encode()` — turn a code-shape value into the wire shape (examples,
 *                few-shot messages, values shown in instructions, echoing
 *                prior arguments back).
 *
 * The schema classes in `schema.ts` own their logic (`compile`); this file
 * holds the shared machinery: the compiler (refs, `$defs`, cycles, depth, the
 * JSON-text escape hatch), the walk context with copy accounting, and the
 * `Rendered` result callers hold.
 *
 * COPY RULES (asserted in tests, tabled in aeye-schema.md):
 * - Decoding a subtree whose wire shape is its code shape allocates nothing:
 *   it is validated and returned as the SAME reference.
 * - Default `inPlace: true` (the caller owns the `JSON.parse` result): a
 *   changed child is written back into its parent (`edits`), `null`-for-absent
 *   keys are deleted (`edits`). Parents are never copied.
 * - `inPlace: false` (copy-on-write): the first change inside an object/array
 *   clones THAT container once (`objects`/`arrays`); untouched siblings and
 *   subtrees are shared, never cloned.
 * - The only unavoidable allocations are shape changes: a record sent as
 *   `[{key, value}]` becomes one new object (values moved, not copied); a
 *   tuple sent as `{"0":…}` becomes one new array; JSON text is parsed once
 *   (`parsed`); a container sent as a JSON string is parsed once (`repaired`).
 * - Encoding never mutates the code value. A node whose wire shape is its
 *   code shape (`needs === false`) returns the value itself; otherwise only
 *   the containers on the path to a change are new.
 */
import type { Profile, View } from './profile';
import { LENIENT, viewOf } from './profile';
import type { AnySchema, Text } from './schema';
import { measureJson, type SchemaMeasure } from './measure';
import { SchemaDefinitionError, SchemaParseError } from './errors';
import { claimIssues, echoes, errorFormat, formatErrors, recordIssue, type ErrorFormatInput, type IssueKind } from './feedback';

export type JsonSchema = { [key: string]: unknown };
export type PathSeg = string | number;

/** One problem with the model's answer. */
export interface Issue {
  /** Where it is in what the MODEL wrote (e.g. `['tags', 2, 'value']` for a pairs record). */
  readonly path: readonly PathSeg[];
  /** Where it is in the CODE shape (e.g. `['tags', 'urgent']`). */
  readonly codePath: readonly PathSeg[];
  readonly message: string;
}

/** Allocation counters for one `parse` or `encode`. */
export interface CopyStats {
  /** Objects allocated (records from pairs, copy-on-write clones, encoded objects). */
  objects: number;
  /** Arrays allocated (tuples from numeric-key objects, copy-on-write clones, encoded arrays). */
  arrays: number;
  /** In-place writes/deletes into the caller's value. */
  edits: number;
  /** JSON texts parsed (escape hatches, `json-text` any). */
  parsed: number;
  /** Values repaired: a container sent as a JSON string, or a value sent where JSON text was asked for. */
  repaired: number;
}

export function newStats(): CopyStats {
  return { objects: 0, arrays: 0, edits: 0, parsed: 0, repaired: 0 };
}

export function formatPath(path: readonly PathSeg[]): string {
  let out = '';
  for (const seg of path) {
    out += typeof seg === 'number' ? `[${seg}]` : /^[A-Za-z_$][\w$]*$/.test(seg) ? (out ? `.${seg}` : seg) : `[${JSON.stringify(seg)}]`;
  }
  return out || '(root)';
}

/** What a count-only dry run records for each failure (its only use is `errors.length`). */
const COUNTED: Issue = Object.freeze({ path: [], codePath: [], message: '' });
/** Dry runs never write their stats. */
const DRY_STATS: CopyStats = newStats();
/** Undo-log value of a key that was absent. */
const ABSENT = Symbol('absent');
/** Undo-log key of an object's key order, saved before its first delete. */
const ORDER = Symbol('order');
/** One spare undo log, reused by the next decode (a nested decode makes its own). */
let spareUndo: unknown[] | undefined;

/**
 * The walk context. Paths are stacks with explicit depths, so the happy path
 * allocates nothing: `push`/`pop` on a plain array let V8 shrink and regrow
 * its storage at every level, an allocation per value decoded; these only grow.
 */
export class Cx {
  readonly errors: Issue[] = [];
  /**
   * In-place writes, as (container, key, old value) triples, so a failed
   * decode can put the model's answer back as it was sent (the echo shows
   * the wire, not a half-decoded mix). Only kept when the message echoes.
   */
  undo: unknown[] | undefined;
  private undoN = 0;
  private readonly wire: PathSeg[] = [];
  private readonly code: PathSeg[] = [];
  private wd = 0;
  private cd = 0;
  constructor(
    /** Mutate the caller's value (default) or copy-on-write. */
    readonly inPlace: boolean,
    /** Dry run: validate only, never write (used to pick a union option). */
    readonly dry: boolean,
    readonly stats: CopyStats,
    /** Accept a container sent as JSON text, and a value sent where JSON text was asked for. */
    readonly repair = true,
    /** Only whether it fails matters (union option trials): no issue objects, no paths. */
    readonly countOnly = false,
  ) {}
  /**
   * Record a problem at the current path. `kind` and `candidates` drive the
   * model's message ("did you mean"); `received` is what the model wrote
   * there; `node` is the expected type when it isn't the failing node (which
   * claims its issues as the run unwinds: nothing is tracked while it passes).
   */
  fail(message: string, kind: IssueKind = 'other', received?: unknown, candidates?: () => readonly string[], node?: Node): void {
    if (this.countOnly) {
      this.errors.push(COUNTED);
      return;
    }
    const issue: Issue = { path: this.wire.slice(0, this.wd), codePath: this.code.slice(0, this.cd), message };
    this.errors.push(issue);
    recordIssue(issue, { kind, node, received, candidates });
  }
  enter(wire: PathSeg, code: PathSeg | null = wire): void {
    this.wire[this.wd++] = wire;
    if (code !== null) this.code[this.cd++] = code;
  }
  leave(code = true): void {
    this.wd--;
    if (code) this.cd--;
  }
  /**
   * A dry sibling (for union option tests). Count-only by default: only
   * whether it fails is read. With `issues`, its failures are real issues
   * at the current paths (they are copied into this context).
   */
  dryRun(issues = false): Cx {
    if (!issues) return new Cx(false, true, DRY_STATS, this.repair, true);
    const d = new Cx(false, true, DRY_STATS, this.repair);
    for (let i = 0; i < this.wd; i++) d.wire[d.wd++] = this.wire[i]!;
    for (let i = 0; i < this.cd; i++) d.code[d.cd++] = this.code[i]!;
    return d;
  }
  /**
   * Before an in-place write of `key`: remember its old value (when keeping
   * the undo log). Before the first delete from an object, its key order too:
   * a key put back after a delete would otherwise come last.
   */
  saving(container: object, key: PathSeg, deleting = false): void {
    const u = this.undo;
    if (!u) return;
    if (deleting && this.ordered !== container) {
      this.ordered = container;
      u[this.undoN++] = container;
      u[this.undoN++] = ORDER;
      u[this.undoN++] = Object.keys(container);
    }
    const has = Object.prototype.hasOwnProperty.call(container, key);
    u[this.undoN++] = container;
    u[this.undoN++] = key;
    u[this.undoN++] = has ? (container as Record<PathSeg, unknown>)[key] : ABSENT;
  }
  private ordered: object | undefined;
  /** Put every in-place write back, newest first: the caller's value is as the model sent it. */
  restore(): void {
    const u = this.undo;
    if (!u) return;
    for (let i = this.undoN - 3; i >= 0; i -= 3) {
      const c = u[i] as Record<PathSeg, unknown>;
      const k = u[i + 1] as PathSeg | typeof ORDER;
      const old = u[i + 2];
      if (k === ORDER) {
        // Re-insert in the order the model wrote (values are already restored).
        for (const key of old as string[]) {
          const v = c[key];
          delete c[key];
          c[key] = v;
        }
      } else if (old === ABSENT) delete c[k];
      else c[k] = old;
    }
  }
  /** Start keeping the undo log (a reused buffer). */
  keepUndo(): void {
    this.undo = spareUndo ?? [];
    spareUndo = undefined;
    this.undoN = 0;
  }
  /** Drop the undo log's references and hand the buffer back. */
  releaseUndo(): void {
    const u = this.undo;
    if (!u) return;
    for (let i = 0; i < this.undoN; i++) u[i] = undefined;
    this.undo = undefined;
    this.undoN = 0;
    if (u.length <= 65536) spareUndo = u;
  }
}

/** What a schema class supplies to build its node. */
export interface NodeImpl {
  /** This node itself changes the value's shape (pairs→record, null→absent, JSON text…). */
  readonly own?: boolean;
  /** Child nodes (for the `needs` fixpoint). */
  readonly deps?: readonly Node[];
  /** Automatic description text this node adds for the model, e.g. how pairs work. */
  readonly hint?: (view: View) => string | undefined;
  emit(): JsonSchema;
  run(value: unknown, cx: Cx): unknown;
  /** Code shape → wire shape. Only called when `needs` is true; must not mutate `value`. */
  encode(value: unknown, stats: CopyStats): unknown;
  /** The node of a child at a code-path segment (`'*'` for "any element"), for encoding a part. */
  child?(seg: PathSeg): Node | undefined;
}

/** A compiled (schema, profile) node. */
export class Node {
  /** True when decoding or encoding may change this subtree (its own change or any dependency's). */
  needs = false;
  schema: AnySchema | undefined;
  /** An outer wrapper (e.g. `.optional()` around a field) whose metadata also applies. */
  outer: AnySchema | undefined;
  /** The model writes this value as a string of JSON text (an escape, or "any" on a dialect without it). */
  jsonText = false;
  private _json: JsonSchema | undefined;
  constructor(public impl: NodeImpl | undefined, readonly compiler: Compiler) {}

  get own(): boolean { return !!this.impl?.own; }
  get deps(): readonly Node[] { return this.impl?.deps ?? []; }

  json(): JsonSchema {
    if (!this._json) this._json = this.compiler.decorate(this, this.impl!.emit());
    return this._json;
  }

  run(value: unknown, cx: Cx): unknown {
    const errors = cx.errors;
    const before = errors.length;
    const out = this.impl!.run(value, cx);
    if (errors.length === before) {
      if (this.schema?.checks.length) this.check(out, cx, this.schema);
      if (this.outer?.checks.length && errors.length === before) this.check(out, cx, this.outer);
      if (errors.length === before) return out;
    }
    // The innermost failing node is the expected type of its new issues (failure path only).
    if (!cx.countOnly) claimIssues(errors, before, this);
    return out;
  }

  private check(value: unknown, cx: Cx, schema: AnySchema | undefined): void {
    if (!schema) return;
    for (const c of schema.checks) {
      const r = c.fn(value);
      if (r === true) continue;
      if (Array.isArray(r)) { for (const m of r) cx.fail(m, 'rule'); continue; }
      cx.fail(typeof r === 'string' ? r : c.message ?? 'Failed a check.', 'rule');
    }
  }

  /** This node's schema as TypeScript-like text (the code shape; for spots written as JSON text). */
  typeText(): string {
    return this.schema ? this.schema.print(new Printer(this.compiler.env)) : 'any JSON value';
  }

  encode(value: unknown, stats: CopyStats = newStats()): unknown {
    return this.needs ? this.impl!.encode(value, stats) : value;
  }

  child(seg: PathSeg): Node | undefined {
    return this.impl?.child?.(seg);
  }
}

/** Builds and prints a TypeScript-like shape (escape-hatch descriptions, prompt-text delivery). */
export class Printer {
  private readonly names = new Set<string>();
  constructor(readonly env: ReadonlyMap<string, AnySchema>) {}
  print(s: AnySchema): string {
    return s.print(this);
  }
  ref(name: string): string {
    this.names.add(name);
    return name;
  }
  /** The named types printed so far. */
  used(): string[] {
    return [...this.names];
  }
  /** `type X = …` for these named types and every named type they reach. */
  definitions(names: Iterable<string>): string {
    for (const n of names) this.names.add(n);
    const lines: string[] = [];
    const done = new Set<string>();
    for (let again = true; again; ) {
      again = false;
      for (const n of [...this.names]) {
        if (done.has(n)) continue;
        done.add(n);
        again = true;
        const def = this.env.get(n);
        if (def) lines.push(`type ${n} = ${def.print(this)}`);
      }
    }
    return lines.join('\n');
  }
  /** The shape plus a `type X = …` line for every named type it reaches. */
  full(s: AnySchema): string {
    const head = this.print(s);
    const lines: string[] = [];
    const done = new Set<string>();
    for (let again = true; again; ) {
      again = false;
      for (const n of [...this.names]) {
        if (done.has(n)) continue;
        done.add(n);
        again = true;
        const def = this.env.get(n);
        if (def) lines.push(`type ${n} = ${def.print(this)}`);
      }
    }
    return lines.length ? `${head}\nwhere\n${lines.join('\n')}` : head;
  }
}

const CONTAINERS = new Set(['object', 'array', 'record', 'tuple']);

const dynamicBelow = new WeakMap<AnySchema, boolean>();
/** A sibling-typed field below: its schema is made per decode and may name the bind's types, so its node isn't shared. */
function hasDependent(s: AnySchema): boolean {
  let d = dynamicBelow.get(s);
  if (d === undefined) {
    d = s.kind === 'dependent' || s.children().some(hasDependent);
    dynamicBelow.set(s, d);
  }
  return d;
}

const nesting = new WeakMap<AnySchema, number>();
/** Container depth of a ref-free schema (memoized per instance). */
function nestingOf(s: AnySchema): number {
  let n = nesting.get(s);
  if (n === undefined) {
    n = (CONTAINERS.has(s.kind) ? 1 : 0) + Math.max(0, ...s.children().map(nestingOf));
    nesting.set(s, n);
  }
  return n;
}

/**
 * Node cache for REF-FREE schemas, keyed by schema instance then profile id.
 * A ref-free subtree renders the same whatever the bound refs are, so it is
 * compiled once per profile for as long as the schema instance lives (the
 * WeakMap lets it go with the schema). This is what makes re-binding a
 * dynamic bundle cheap: only nodes that touch a ref are rebuilt.
 */
const refFreeCache = new WeakMap<AnySchema, Map<string, Node>>();

/**
 * The compiler a ref-free node is compiled in, one per profile. A node keeps
 * its compiler (for `json()` and its closures), so a cached node made by the
 * compiler of some bind would keep that whole bind alive — its env, its nodes
 * and every profile it rendered — for as long as the (usually static) schema
 * lives. The shared compiler has no env, and forgets its nodes once their
 * `needs` are known, so it holds nothing but the profile.
 */
const sharedCompilers = new WeakMap<Profile, Compiler>();
function sharedCompiler(profile: Profile): Compiler {
  let c = sharedCompilers.get(profile);
  if (!c) sharedCompilers.set(profile, (c = new Compiler(profile, EMPTY_ENV, sharedLenient, false, true)));
  return c;
}
const EMPTY_ENV: ReadonlyMap<string, AnySchema> = new Map();
let sharedLenientRendered: Rendered<unknown> | undefined;
/** The LENIENT rendering escape hatches and union checks use for ref-free schemas. */
function sharedLenient(): Rendered<unknown> {
  if (!sharedLenientRendered) {
    const c = sharedCompiler(LENIENT);
    sharedLenientRendered = new Rendered<unknown>(c, c.node({ emit: () => ({}), run: (v) => v, encode: (v) => v }));
  }
  return sharedLenientRendered;
}

/** Nodes an inlining (no `$defs`) compile may make before it restarts as `inlineOnce`. */
export const INLINE_BUDGET = 4000;
/** Thrown inside a compile that inlined past `INLINE_BUDGET`; `Bound.render` restarts it. */
export class InlineBudgetExceeded extends Error {}

/** Compiles schemas for one (bound env, profile). */
export class Compiler {
  readonly nodes: Node[] = [];
  /** Named types emitted into `$defs` (defs mode). */
  readonly defs = new Map<string, DefTarget>();
  /** Named types the JSON-text escapes mention: defined once, in the root description. */
  readonly glossary = new Set<string>();
  /** Without `$defs`: recursive named types inlined so far (`inlineOnce` mode). */
  private readonly inlined = new Set<string>();
  private readonly recursive = new Map<string, boolean>();
  readonly view: View;
  /** Named types being compiled, with the guard level at their start. */
  private readonly stack: { readonly name: string; readonly guard: number }[] = [];
  private depth = 0;
  /** How many optional / nullable / may-be-empty containers enclose the current position. */
  private guard = 0;

  constructor(
    readonly profile: Profile,
    readonly env: ReadonlyMap<string, AnySchema>,
    /** The LENIENT rendering of the same bound env (escape hatches validate against it). */
    readonly lenient: () => Rendered<unknown>,
    /**
     * Without `$defs` every use of a named type is inlined, which for a big
     * recursive grammar (query's Expr ⇄ Query) grows exponentially. Past
     * `INLINE_BUDGET` nodes the compile restarts in this mode: each recursive
     * named type is written out once, its later uses are JSON text of it.
     */
    readonly inlineOnce = false,
    /** The per-profile compiler of ref-free nodes (`sharedCompiler`): it forgets its nodes after `finish`. */
    readonly shared = false,
  ) {
    this.view = viewOf(profile);
  }

  /** Does a named type reach itself? */
  private isRecursive(name: string): boolean {
    let r = this.recursive.get(name);
    if (r === undefined) {
      const seen = new Set<string>();
      const stack = [...(this.env.get(name)?.refNames() ?? [])];
      r = false;
      while (stack.length) {
        const n = stack.pop()!;
        if (n === name) { r = true; break; }
        if (seen.has(n)) continue;
        seen.add(n);
        stack.push(...(this.env.get(n)?.refNames() ?? []));
      }
      this.recursive.set(name, r);
    }
    return r;
  }

  node(impl: NodeImpl): Node {
    return new Node(impl, this);
  }

  /** Compile a schema; `outer` is a wrapper whose metadata/checks also apply (an optional field). */
  compile(s: AnySchema, outer?: AnySchema): Node {
    // A model sees the narrower `forModels` variant; its output fits the original.
    if (this.profile.audience !== 'people' && s.meta.forModels) {
      const { forModels, ...rest } = s.meta;
      const m = forModels as AnySchema;
      s = m.meta.description === undefined && rest.description !== undefined ? m.describe(rest.description) : m;
    }
    const container = CONTAINERS.has(s.kind);
    if (container && this.profile.maxDepth !== undefined && this.depth >= this.profile.maxDepth) {
      return this.escape(s, `Nested too deep for this model to describe directly.`);
    }
    // Ref-free and certain not to hit the depth limit below here → the node is the same in every bind.
    const cacheable = !outer && s.refNames().size === 0 && !hasDependent(s)
      && (this.profile.maxDepth === undefined || this.depth + nestingOf(s) < this.profile.maxDepth);
    if (cacheable) {
      const hit = refFreeCache.get(s)?.get(this.profile.id);
      if (hit) return hit;
      if (!this.shared) {
        const shared = sharedCompiler(this.profile);
        const n = shared.compile(s);
        shared.finish();
        return n;
      }
    }
    if (container) this.depth++;
    const n = s.compile(this);
    if (container) this.depth--;
    n.schema = s;
    n.outer = outer;
    this.nodes.push(n);
    if (cacheable) {
      let m = refFreeCache.get(s);
      if (!m) refFreeCache.set(s, (m = new Map()));
      m.set(this.profile.id, n);
    }
    return n;
  }

  /** Compile below a position the value may skip (optional, nullable, an array that may be empty). */
  guarded(s: AnySchema, outer?: AnySchema): Node {
    this.guard++;
    try {
      return this.compile(s, outer);
    } finally {
      this.guard--;
    }
  }

  /** A use of a named type. */
  ref(name: string): Node {
    const s = this.env.get(name);
    if (!s) throw new SchemaDefinitionError(`ref "${name}" is not defined (the chain's types should have prevented this).`);
    const p = this.profile;
    const open = this.stack.find((e) => e.name === name);
    if (open) {
      const allowed = p.defs && (p.recursion === true || (p.recursion === 'guarded' && this.guard > open.guard));
      if (allowed) return this.defRef(name, this.defs.get(name)!);
      return this.escape(s, `"${name}" contains itself, which this model cannot describe directly.`, name);
    }
    if (p.defs) {
      const existing = this.defs.get(name);
      if (existing) return this.defRef(name, existing);
      const target = new DefTarget(this);
      this.defs.set(name, target);
      this.stack.push({ name, guard: this.guard });
      target.target = this.compile(s);
      this.stack.pop();
      this.nodes.push(target);
      return this.defRef(name, target);
    }
    if (this.inlineOnce && this.isRecursive(name)) {
      if (this.inlined.has(name)) return this.escape(s, `"${name}" is written out once elsewhere in this schema.`, name);
      this.inlined.add(name);
    } else if (!this.inlineOnce && this.nodes.length > INLINE_BUDGET) {
      throw new InlineBudgetExceeded();
    }
    this.stack.push({ name, guard: this.guard });
    const n = this.compile(s);
    this.stack.pop();
    return n;
  }

  private defRef(name: string, def: DefTarget): Node {
    const n = this.node({
      deps: [def],
      // JSON Pointer escaping: a named type like `shop/Product` is `#/$defs/shop~1Product`.
      emit: () => ({ $ref: `#/$defs/${name.replace(/~/g, '~0').replace(/\//g, '~1')}` }),
      run: (v, cx) => def.run(v, cx),
      encode: (v, st) => def.encode(v, st),
      child: (seg) => def.child(seg),
    });
    this.nodes.push(n);
    (n as RefNode).refName = name;
    return n;
  }

  /**
   * The escape hatch: a string holding JSON text in the CODE shape, used for
   * whatever the profile cannot express (recursion, depth, "any"). The JSON
   * text is parsed once and validated by the LENIENT rendering of the same
   * schema, so nothing is lost — only moved into a string.
   */
  escape(s: AnySchema, why: string, name?: string): Node {
    // The shape is said by name; the named types it reaches are defined ONCE,
    // in the root's description (`Rendered.jsonSchema`), not at every escape —
    // a recursive grammar escapes at many places.
    const printer = new Printer(this.env);
    const shape = name ?? printer.print(s);
    for (const n of name ? [name] : printer.used()) this.glossary.add(n);
    const where = name || printer.used().length ? ' (its named types are defined in the description of the whole schema)' : '';
    let inner: Node | undefined;
    const lenientNode = () => (inner ??= this.lenient().nodeFor(s));
    const n = this.node({
      own: true,
      emit: () => ({ type: 'string', description: `${why} Write it as JSON text of this TypeScript type: ${shape}${where}.` }),
      run: (v, cx) => {
        const parsed = readJsonText(v, cx);
        if (parsed === FAILED) return v;
        cx.enter('(json)', null);
        const out = lenientNode().run(parsed, cx);
        cx.leave(false);
        return out;
      },
      encode: (v) => JSON.stringify(v),
    });
    n.jsonText = true;
    this.nodes.push(n);
    return n;
  }

  /** A node for a subschema in this compiler, compiled on demand (after `finish`). */
  late(s: AnySchema): Node {
    const n = this.compile(s);
    this.finish();
    return n;
  }

  /** Least fixpoint of `needs = own || any(dep.needs)` (handles cycles). */
  finish(): void {
    for (let changed = true; changed; ) {
      changed = false;
      for (const n of this.nodes) {
        if (n.needs) continue;
        if (n.own || n.deps.some((d) => d.needs)) {
          n.needs = true;
          changed = true;
        }
      }
    }
    // The shared compiler's nodes are reached through `refFreeCache` (weakly, by schema); keeping them here would pin every schema it ever compiled.
    if (this.shared) this.nodes.length = 0;
  }

  /** Text of a `Text` for this profile. */
  text(t: Text | undefined): string | undefined {
    return t === undefined ? undefined : typeof t === 'function' ? t(this.view) : t;
  }

  /** `T | null` in this profile's spelling. */
  nullable(j: JsonSchema): JsonSchema {
    const spelling = this.profile.nulls;
    // Already nullable (a nullable inside an optional, null-for-absent): once is enough.
    if (j.nullable === true || (Array.isArray(j.type) && j.type.includes('null')) || j.type === 'null') return j;
    if (spelling === 'nullable') return { ...j, nullable: true };
    if (spelling === 'type-array' && typeof j.type === 'string' && !('$ref' in j) && !('anyOf' in j)) {
      const out: JsonSchema = { ...j, type: [j.type, 'null'] };
      if (Array.isArray(j.enum)) out.enum = [...j.enum, null];
      return out;
    }
    if (Array.isArray(j.anyOf) && !('$ref' in j)) {
      if ((j.anyOf as JsonSchema[]).some((o) => o.type === 'null')) return j;
      return { ...j, anyOf: [...(j.anyOf as JsonSchema[]), { type: 'null' }] };
    }
    const { description, ...rest } = j;
    return description === undefined ? { anyOf: [rest, { type: 'null' }] } : { anyOf: [rest, { type: 'null' }], description };
  }

  /** An object schema, closed when the profile closes objects. */
  object(properties: Record<string, JsonSchema>, required: readonly string[], closed = this.profile.closedObjects): JsonSchema {
    const j: JsonSchema = { type: 'object', properties, required: [...required] };
    if (closed) j.additionalProperties = false;
    if (this.profile.propertyOrdering) j.propertyOrdering = Object.keys(properties);
    return j;
  }

  /** Add description, examples and title to an emitted schema. */
  decorate(node: Node, json: JsonSchema): JsonSchema {
    const parts: string[] = [];
    const metas = [node.schema?.meta, node.outer?.meta];
    let title: string | undefined;
    const examples: unknown[] = [];
    for (const m of metas) {
      if (!m) continue;
      const d = this.text(m.description);
      if (d) parts.push(d);
      if (m.title) title = m.title;
      if (m.examples) {
        for (const e of m.examples) {
          this.checkExample(node, e);
          examples.push(node.encode(e));
        }
      }
    }
    const hint = node.impl?.hint?.(this.view);
    if (hint) parts.push(hint);
    const prior = typeof json.description === 'string' ? json.description : undefined;
    if (prior) parts.push(prior);
    const out: JsonSchema = { ...json };
    if (title) out.title = title;
    if (examples.length) {
      if (this.profile.examples === 'keyword') out.examples = examples;
      else if (this.profile.examples === 'description')
        parts.push(`Example${examples.length > 1 ? 's' : ''}: ${examples.map((e) => JSON.stringify(e)).join(' ; ')}`);
    }
    if (parts.length) out.description = parts.join('\n');
    return out;
  }

  /** An example is typed in the code shape; one that doesn't fit is a definition mistake, reported once. */
  private checkExample(node: Node, example: unknown): void {
    const s = node.schema;
    if (!s) return;
    const cx = new Cx(false, true, newStats(), false);
    this.lenient().nodeFor(s).run(example, cx);
    if (cx.errors.length) {
      throw new SchemaDefinitionError(`example ${JSON.stringify(example)} does not fit its schema:\n${formatIssues(cx.errors)}`);
    }
  }
}

interface RefNode extends Node {
  refName?: string;
}

/** The `$defs` entry of a named type; filled in after its body compiles (cycles point at it first). */
export class DefTarget extends Node {
  target!: Node;
  constructor(compiler: Compiler) {
    super(undefined, compiler);
  }
  override get own(): boolean { return false; }
  override get deps(): readonly Node[] { return this.target ? [this.target] : []; }
  override json(): JsonSchema { return this.target.json(); }
  override run(v: unknown, cx: Cx): unknown { return this.target.run(v, cx); }
  override encode(v: unknown, stats: CopyStats = newStats()): unknown { return this.target.encode(v, stats); }
  override child(seg: PathSeg): Node | undefined { return this.target.child(seg); }
}

/** Returned by `readJsonText` when the value was not usable. */
export const FAILED: unique symbol = Symbol('failed');

/**
 * Read a value the model was asked to write as JSON text. With repair on, a
 * value written directly (an object where a string of JSON was asked for) is
 * taken as it is — models do this often, and it is unambiguous.
 */
export function readJsonText(v: unknown, cx: Cx): unknown {
  if (typeof v !== 'string') {
    if (cx.repair && v !== undefined) {
      if (!cx.dry) cx.stats.repaired++;
      return v;
    }
    cx.fail('Expected a string of JSON text.', 'type');
    return FAILED;
  }
  try {
    const out = JSON.parse(v);
    if (!cx.dry) cx.stats.parsed++;
    return out;
  } catch (e) {
    cx.fail(`Not valid JSON text: ${(e as Error).message}`, 'json');
    return FAILED;
  }
}

/** Options for `Rendered.parse`. */
export interface ParseOptions {
  /** Decode into the caller's value (default `true`), or copy-on-write. */
  readonly inPlace?: boolean;
  /**
   * Accept common slips (default `true`): an object/array/record sent as a
   * string of JSON text (also double-encoded), and a value sent directly
   * where JSON text was asked for. Each is counted in `stats.repaired`.
   */
  readonly repair?: boolean;
  /**
   * How the failure `message` is written for the model: detail level, size
   * cap, suggestions, expected types (feedback.ts). Default `'full'` within
   * 2000 characters; a request entry passes its tool's / prompt's format.
   */
  readonly errorFormat?: ErrorFormatInput | undefined;
  /** What the model wrote, for the message's first line (default `'your answer'`). */
  readonly label?: string | undefined;
}

/** Successful or failed parse. */
export type ParseResult<Out> =
  | { readonly ok: true; readonly value: Out; readonly stats: CopyStats }
  | { readonly ok: false; readonly issues: readonly Issue[]; readonly message: string; readonly stats: CopyStats };

/** Options for `Rendered.encodeText` and the template helpers. */
export interface EncodeTextOptions {
  /** Indent the JSON (`true` = 2 spaces). */
  readonly pretty?: boolean | number;
  /**
   * Encode a PART: the value given is what sits at this code path of the
   * schema (`limits`, `rows.*.tags`; `*` is any element or key).
   */
  readonly path?: string | readonly PathSeg[];
}

/** Encode values in a rendering's wire shape, needing only the value. */
export interface Encoder<Out> {
  /** The value as the model would write it, as JSON text. */
  (value: Out, opts?: EncodeTextOptions): string;
  /** The value as the model would write it, as a JSON value. */
  readonly wire: (value: Out, path?: EncodeTextOptions['path']) => unknown;
}

/** A schema rendered for one profile: JSON schema + codec + validation, memoized. */
export class Rendered<Out> {
  declare readonly _out: Out;
  private _json: JsonSchema | undefined;
  private _body: JsonSchema | undefined;
  private _wrapped: boolean | undefined;
  private _measure: SchemaMeasure | undefined;
  private _encoder: Encoder<Out> | undefined;

  constructor(readonly compiler: Compiler, readonly root: Node) {}

  get profile(): Profile { return this.compiler.profile; }

  /** The root schema without `$defs` (a root ref is inlined). */
  private body(): JsonSchema {
    if (!this._body) {
      const refName = (this.root as RefNode).refName;
      this._body = refName ? this.compiler.defs.get(refName)!.json() : this.root.json();
    }
    return this._body;
  }

  /**
   * True when the profile needs an object root and this schema's root isn't
   * one: the model then writes `{ "input": … }`, unwrapped on decode.
   */
  get wrapped(): boolean {
    if (this._wrapped === undefined) {
      const b = this.body();
      this._wrapped = this.profile.rootObject && !(b.type === 'object' && !('anyOf' in b));
    }
    return this._wrapped;
  }

  /** The JSON Schema the model is given. */
  get jsonSchema(): JsonSchema {
    if (this._json) return this._json;
    let body = this.body();
    if (this.wrapped) body = this.compiler.object({ input: body }, ['input'], this.profile.closedObjects || this.profile.strict);
    if (this.compiler.glossary.size) {
      const defs = new Printer(this.compiler.env).definitions(this.compiler.glossary);
      const note = `Named types used by the fields written as JSON text:\n${defs}`;
      body = { ...body, description: typeof body.description === 'string' ? `${body.description}\n${note}` : note };
    }
    const defs: Record<string, JsonSchema> = {};
    for (const [name, def] of this.compiler.defs) defs[name] = def.json();
    this._json = this.compiler.defs.size ? { ...body, $defs: defs } : body;
    return this._json;
  }

  /** Size of the emitted schema: properties, depth, enum values, optionals, unions (memoized). */
  get measure(): SchemaMeasure {
    return (this._measure ??= measureJson(this.jsonSchema));
  }

  /**
   * Validate + decode the model's answer (already `JSON.parse`d). With
   * `inPlace` (default) the value is decoded in place and returned; see the
   * copy rules at the top of this file. On failure `message` is the feedback
   * for the model (`opts.errorFormat`, see feedback.ts); with an echoing
   * format (the default) the value is first put back as the model sent it.
   */
  parse(wire: unknown, opts?: ParseOptions): ParseResult<Out> {
    return this.decode(wire, opts, undefined);
  }

  private decode(wire: unknown, opts: ParseOptions | undefined, original: (() => unknown) | undefined): ParseResult<Out> {
    const stats = newStats();
    const inPlace = opts?.inPlace ?? true;
    const cx = new Cx(inPlace, false, stats, opts?.repair ?? true);
    // An echoing message needs the answer as sent: in-place writes are logged and put back on failure.
    const keep = inPlace && !original && echoes(opts?.errorFormat);
    if (keep) cx.keepUndo();
    let value: unknown;
    if (this.wrapped) {
      if (typeof wire !== 'object' || wire === null || Array.isArray(wire) || !('input' in wire)) {
        cx.fail('Expected an object with an "input" field.', 'type');
      } else {
        cx.enter('input', null);
        value = this.root.run((wire as { input: unknown }).input, cx);
        cx.leave(false);
      }
    } else {
      value = this.root.run(wire, cx);
    }
    if (cx.errors.length) {
      cx.restore();
      cx.releaseUndo();
      const sent = original ? original() : wire;
      return { ok: false, issues: cx.errors, message: formatErrors(cx.errors, sent, errorFormat(opts?.errorFormat), opts?.label), stats };
    }
    if (keep) cx.releaseUndo();
    return { ok: true, value: value as Out, stats };
  }

  /** `JSON.parse` then decode in place (we own the parsed value; a failure's echo re-reads the text). */
  parseText(text: string, opts?: Omit<ParseOptions, 'inPlace'>): ParseResult<Out> {
    let wire: unknown;
    try {
      wire = JSON.parse(text);
    } catch (e) {
      const issues: Issue[] = [{ path: [], codePath: [], message: `Not valid JSON: ${(e as Error).message}` }];
      recordIssue(issues[0]!, { kind: 'json' });
      return { ok: false, issues, message: formatErrors(issues, undefined, errorFormat(opts?.errorFormat), opts?.label), stats: newStats() };
    }
    return this.decode(wire, opts, () => JSON.parse(text));
  }

  /** `parse`, throwing a `SchemaParseError` (with the issues and the model's message) on failure. */
  parseOrThrow(wire: unknown, opts?: ParseOptions): Out {
    const r = this.parse(wire, opts);
    if (!r.ok) throw new SchemaParseError(r.issues, r.message);
    return r.value;
  }

  /**
   * Code shape → the shape this model writes (few-shot examples, values in
   * instructions, echoing prior args). Never mutates `value`; untouched
   * subtrees are shared. Pass `stats` to count what was allocated.
   */
  encode(value: Out, stats: CopyStats = newStats()): unknown {
    const enc = this.root.encode(value, stats);
    if (!this.wrapped) return enc;
    stats.objects++;
    return { input: enc };
  }

  /** `encode` of a part: `value` is the value at code path `path` (`'limits'`, `['rows', '*', 'tags']`). */
  encodeAt(value: unknown, path: EncodeTextOptions['path'], stats: CopyStats = newStats()): unknown {
    const segs = splitPath(path);
    if (!segs.length) return this.encode(value as Out, stats);
    let node: Node | undefined = this.root;
    for (const seg of segs) {
      node = node?.child(seg);
      if (!node) throw new SchemaDefinitionError(`no schema at path ${formatPath(segs)}.`);
    }
    return node!.encode(value, stats);
  }

  /** `encode` as JSON text (of a part, with `opts.path`). */
  encodeText(value: Out, opts: EncodeTextOptions = {}): string {
    const wire = opts.path === undefined ? this.encode(value) : this.encodeAt(value, opts.path);
    const indent = opts.pretty === true ? 2 : typeof opts.pretty === 'number' ? opts.pretty : undefined;
    return JSON.stringify(wire, null, indent);
  }

  /** An encoder bound to this rendering: hand it to code that has only the value. */
  get encoder(): Encoder<Out> {
    if (!this._encoder) {
      const fn = ((value: Out, opts?: EncodeTextOptions) => this.encodeText(value, opts)) as Encoder<Out>;
      (fn as { wire: Encoder<Out>['wire'] }).wire = (value, path) => (path === undefined ? this.encode(value) : this.encodeAt(value, path));
      this._encoder = Object.freeze(fn);
    }
    return this._encoder;
  }

  /**
   * Node for a subschema in this rendering (escape hatches use the LENIENT one),
   * compiled once per subschema instance: union encoding and checks ask for the
   * same option nodes on every value, and a fresh compile each time grew the
   * compiler (and its `needs` fixpoint) by the subschema's size per call.
   */
  nodeFor(s: AnySchema): Node {
    let n = this.lateNodes.get(s);
    if (!n) this.lateNodes.set(s, (n = this.compiler.late(s)));
    return n;
  }
  private readonly lateNodes = new WeakMap<AnySchema, Node>();

  /** The whole shape as TypeScript-like text (prompt-text delivery). */
  typescript(): string {
    const s = this.root.schema!;
    return new Printer(this.compiler.env).full(s);
  }
}

function splitPath(path: EncodeTextOptions['path']): PathSeg[] {
  if (path === undefined || path === '') return [];
  if (typeof path !== 'string') return [...path];
  return path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/**
 * Issues as bare lines, `- at <path>: <message>` (paths where the model wrote
 * them). The model's message is `formatErrors` (feedback.ts), with markers,
 * suggestions and a size cap.
 */
export function formatIssues(issues: readonly Issue[]): string {
  return issues.map((i) => `- at ${formatPath(i.path)}: ${i.message}`).join('\n');
}

export { LENIENT };
