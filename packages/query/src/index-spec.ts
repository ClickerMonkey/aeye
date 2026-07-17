/**
 * Index — a stored COMPOSITE index on a Type: an ordered list of `parts`, each
 * an indexed expression plus a PREFIX cardinality `count` (the distinct-row
 * count when the index is used up to and including that part). The index is
 * UNIQUE iff its LAST part's `count === 1`.
 *
 * Phase-1 caveat: the runtime `Expr` classes (and the canonical
 * `canonicalize(expr)` digest) arrive in Phase 2. So each part stores its
 * expression as the raw `ExprDef` JSON and derives a stable canonical digest
 * string from it directly. `prefixReduction(used)` compares digests — when
 * Phase 2 lands, the digest source switches to `canonicalize(Expr)` (which
 * normalizes equivalently), and this class's interface stays put.
 */
import type { ExprDef, IndexDef, IndexPartDef, JsonValue } from './schema';
import type { Type } from './type';

/** The fallback average bytes for an index part that is not a plain field-ref. */
const NON_FIELD_PART_BYTES = 8;

/**
 * Deterministic, key-sorted stringification of a JSON value. Two
 * structurally-equal JSON trees always produce the same string regardless
 * of original key order — the basis for the index digest.
 */
function stableStringify(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Canonical digest of an expression def. Round-trips through JSON to obtain
 * a plain `JsonValue` (dropping `undefined`s and class identity), then
 * key-sorts it. No casts: `JSON.parse` yields `any`, immediately constrained
 * to `JsonValue` by the annotation.
 */
export function exprDigest(expr: ExprDef): string {
  const json: JsonValue = JSON.parse(JSON.stringify(expr));
  return stableStringify(json);
}

/** One ordered part of a composite index: an expr + its prefix cardinality. */
export class IndexPart {
  /** Lazily computed canonical digest of `expr`. */
  private _digest?: string;

  constructor(
    /** The indexed expression, stored as raw JSON this phase. */
    readonly expr: ExprDef,
    /** Distinct rows when the index is used up to and including this part. */
    readonly count: number,
  ) {}

  /** Canonical digest string, computed once on first access. */
  get digest(): string {
    if (this._digest === undefined) this._digest = exprDigest(this.expr);
    return this._digest;
  }

  /** Serialize to its `IndexPartDef` JSON (deep-cloning the stored expr). */
  toJSON(): IndexPartDef {
    // Deep-clone the expr so callers can't mutate our stored def.
    const expr: ExprDef = JSON.parse(JSON.stringify(this.expr));
    return { expr, count: this.count };
  }
}

/**
 * A stored COMPOSITE index on a Type: an ordered list of {@link IndexPart}s.
 * The index is UNIQUE iff its last part's `count === 1`.
 */
export class Index {
  /** The ordered parts of this composite index (at least one). */
  readonly parts: readonly IndexPart[];
  /** Explicit average bytes per index entry, when authored (else derived from parts). */
  private readonly explicitBytes?: number;

  /** Construct an index from its ordered parts (at least one) and optional entry-byte size. */
  constructor(parts: readonly IndexPart[], bytes?: number) {
    this.parts = parts;
    this.explicitBytes = bytes;
  }

  /**
   * Estimated average bytes of one INDEX ENTRY — an explicit authored `bytes`,
   * else the SUM of the parts' byte sizes: a field-ref part uses that field's
   * {@link Field.bytes}; any other expr part uses a small fixed default. Drives
   * the index-only (covered) scan estimate, where reading index entries is
   * cheaper than reading whole rows.
   */
  bytes(type: Type): number {
    if (this.explicitBytes !== undefined) return this.explicitBytes;
    let total = 0;
    for (const part of this.parts) {
      const field = part.expr.kind === 'field-ref' ? type.field(part.expr.field) : undefined;
      total += field ? field.bytes() : NON_FIELD_PART_BYTES;
    }
    return total;
  }

  /**
   * True when a full-key equality lookup yields at most one row — i.e. the
   * LAST part's distinct-row count is 1.
   */
  get unique(): boolean {
    const last = this.parts[this.parts.length - 1];
    return last !== undefined && last.count === 1;
  }

  /**
   * The distinct-row `count` of the LONGEST LEADING PREFIX of parts that are
   * ALL present in `used` (each `used` entry serializes to an `ExprDef`).
   * Returns `undefined` when even the first part is not matched.
   *
   * Because part counts are non-increasing, a longer matched prefix always
   * yields a smaller (or equal) estimate — so this returns the tightest bound
   * the supplied predicates can achieve via this index.
   */
  prefixReduction(used: ReadonlyArray<{ toJSON(): ExprDef }>): number | undefined {
    const digests = used.map((u) => exprDigest(u.toJSON()));
    let reduction: number | undefined;
    for (const part of this.parts) {
      if (!digests.includes(part.digest)) break;
      reduction = part.count;
    }
    return reduction;
  }

  /** Build an Index from its `IndexDef` JSON. */
  static from(json: IndexDef): Index {
    return new Index(json.exprs.map((p) => new IndexPart(p.expr, p.count)), json.bytes);
  }

  /** Serialize to its `IndexDef` JSON shape (emitting `bytes` only when authored explicitly). */
  toJSON(): IndexDef {
    const def: IndexDef = { exprs: this.parts.map((p) => p.toJSON()) };
    if (this.explicitBytes !== undefined) def.bytes = this.explicitBytes;
    return def;
  }

  /** Deep-copy this index (round-trips through JSON). */
  clone(): Index {
    return Index.from(this.toJSON());
  }
}
