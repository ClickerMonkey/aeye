/**
 * The shape of a type name: a `\w+` identifier, optionally qualified by one
 * or more namespace segments joined with `/` — `Entry`, `fs/Entry`,
 * `my-app/billing/Invoice`. A namespace segment may also hold `-`, since
 * namespaces are usually package or system names; the final segment is the
 * type's own identifier.
 *
 * A host that loads types from several sources (systems, packages, plugins)
 * keeps their names apart by qualifying them, so gin takes the qualified form
 * as it stands rather than making every host escape it into `\w+` and back.
 * Whitespace and other punctuation are still refused: an LLM-emitted name
 * with a stray space otherwise fails much later as a baffling structural
 * mismatch.
 *
 * The one rule every check uses — `registry.parse` for `name`, `extends` and
 * `satisfies`, and the extension schema an LLM writes against.
 */
export const TYPE_NAME = /^(?:\w[\w-]*\/)*\w+$/;

/** Whether `name` is a valid type name (see {@link TYPE_NAME}). */
export function isTypeName(name: unknown): name is string {
  return typeof name === 'string' && TYPE_NAME.test(name);
}
