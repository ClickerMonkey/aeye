/**
 * `jsonSource` — a POSITIONED canonical JSON stringifier.
 *
 * Why this exists: `Problem.path` is a structural pointer like
 * `['fields', 0, 'expr', 'left']` into the JSON an LLM authored. To underline
 * the OFFENDING value in the model's own JSON (compiler-style `^^^`), the
 * renderer needs the exact char range each path points at. `JSON.stringify`
 * gives the text but throws the positions away. `jsonSource` re-emits that same
 * canonical text itself while recording, for EVERY node, the `[start, end)`
 * char offsets of that value's text — so a `Code` built over it can resolve
 * `Problem.path → Span → (line, col)` and render the underline.
 *
 * Contract: `text` is BYTE-IDENTICAL to `JSON.stringify(value, null, 2)`
 * (2-space indent, `": "` after keys, `,\n` separators, no trailing spaces),
 * and every recorded span's `text.slice(start, end)` is exactly that value's
 * canonical token (strings include their quotes). A span is recorded for the
 * ROOT (path `[]`), every object property VALUE (path incl. the key), and
 * every array ELEMENT (path incl. the index) — the same `(string | number)[]`
 * shape `Problem.path` uses.
 *
 * Scope: intended for plain JSON-derived values (objects, arrays, strings,
 * numbers, booleans, null) — the shape an LLM tool receives after `JSON.parse`.
 * Values `JSON.stringify` OMITS from an object (`undefined` / functions /
 * symbols) are dropped; the same values as ARRAY elements serialize to `null`,
 * matching `JSON.stringify`.
 */

/** A value's canonical char range tied to its structural path (same shape as `Problem.path`). */
export interface JsonSpan {
  /** Structural path to this value — same shape as `Problem.path`. */
  path: (string | number)[];
  /** Inclusive char offset of the value's token in `text`. */
  start: number;
  /** Exclusive char offset. */
  end: number;
}

/** The canonical JSON text plus a positioned span for every node within it. */
export interface JsonSource {
  /** Exactly `JSON.stringify(value, null, 2)`. */
  text: string;
  /** One span per node (root, every property value, every array element). */
  spans: ReadonlyArray<JsonSpan>;
}

/** Type-safe object narrowing (no `any`): a non-null, non-array object with string-keyed values. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Type-safe array narrowing that keeps elements `unknown` (rather than `any[]`). */
function isArray(value: unknown): value is ReadonlyArray<unknown> {
  return Array.isArray(value);
}

/** Whether `JSON.stringify` KEEPS this value as an object property (drops `undefined` / functions / symbols). */
function includable(value: unknown): boolean {
  return JSON.stringify(value) !== undefined;
}

/** Serialize a leaf: `null`, a quoted string, a number, or a boolean — matching `JSON.stringify`. */
function serializeLeaf(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      // Numbers already collapse NaN / Infinity to `null` via JSON.stringify.
      return JSON.stringify(value);
    default:
      // `undefined` / function / symbol as an ARRAY element ⇒ `null`.
      return 'null';
  }
}

/**
 * Emit `value` as canonical 2-space JSON while recording a span for it and
 * every descendant. Returns `{ text, spans }` where `text` equals
 * `JSON.stringify(value, null, 2)` byte-for-byte and each span's
 * `text.slice(start, end)` is that node's exact token.
 */
export function jsonSource(value: unknown): JsonSource {
  const spans: JsonSpan[] = [];
  let text = '';

  const emit = (node: unknown, path: ReadonlyArray<string | number>, level: number): void => {
    const start = text.length;
    if (isArray(node)) {
      emitArray(node, path, level);
    } else if (isRecord(node)) {
      emitObject(node, path, level);
    } else {
      text += serializeLeaf(node);
    }
    spans.push({ path: [...path], start, end: text.length });
  };

  const emitObject = (
    node: Record<string, unknown>,
    path: ReadonlyArray<string | number>,
    level: number,
  ): void => {
    const keys = Object.keys(node).filter((k) => includable(node[k]));
    if (keys.length === 0) {
      text += '{}';
      return;
    }
    const childIndent = '  '.repeat(level + 1);
    const closeIndent = '  '.repeat(level);
    text += '{\n';
    keys.forEach((key, i) => {
      text += `${childIndent}${JSON.stringify(key)}: `;
      emit(node[key], [...path, key], level + 1);
      text += i < keys.length - 1 ? ',\n' : '\n';
    });
    text += `${closeIndent}}`;
  };

  const emitArray = (
    node: ReadonlyArray<unknown>,
    path: ReadonlyArray<string | number>,
    level: number,
  ): void => {
    if (node.length === 0) {
      text += '[]';
      return;
    }
    const childIndent = '  '.repeat(level + 1);
    const closeIndent = '  '.repeat(level);
    text += '[\n';
    node.forEach((el, i) => {
      text += childIndent;
      emit(el, [...path, i], level + 1);
      text += i < node.length - 1 ? ',\n' : '\n';
    });
    text += `${closeIndent}]`;
  };

  emit(value, [], 0);
  return { text, spans };
}
