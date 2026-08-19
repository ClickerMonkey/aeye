/**
 * `{slot}` SQL TEMPLATES — the scanner two declarations share.
 *
 * A refinement declares `sql` / `cast` templates whose slots are its declared
 * OPTIONS (`geometry({subtype},{srid})`); an operator declares `emit` templates
 * whose slots are its declared OPERANDS (`({left} && {right})`). The two fill
 * their slots with entirely different things — one splices a validated token,
 * the other an already-emitted `SqlText` fragment — but they SCAN identically,
 * and a scanner that differed by one character between them would let a slot
 * spelling pass one declaration road and be read as literal text on the other.
 *
 * So this module owns exactly the part that must not differ: finding the slots,
 * splitting the literal text around them, and handing each slot name back to the
 * caller to resolve. Every decision that is not scanning — what a slot may name,
 * what the resolved text must look like, what a missing one means — stays with
 * the declaration that owns it.
 *
 * A LIST of parts rather than a string with placeholders left in it, because a
 * slot's value is filled later (per column, per emit) and re-scanning for `{…}`
 * at that point would let a resolved value that happened to contain braces be
 * read as a slot of its own.
 */

/** Every `{slot}` occurrence in a template. */
const TEMPLATE_SLOT = /\{([^{}]*)\}/g;

/** One piece of a compiled template: literal SQL the declarer wrote, or a slot still to be filled. */
export type TemplatePart = { readonly text: string } | { readonly slot: string };

/** A compiled template — literal parts and the slots still to be filled. */
export type Template = readonly TemplatePart[];

/** Whether `part` is an unresolved slot (the discriminator, in one place). */
export function isSlot(part: TemplatePart): part is { readonly slot: string } {
  return 'slot' in part;
}

/**
 * Split `template` into its literal parts and its `{slot}` parts, asking
 * `resolve` what each slot name means.
 *
 * `resolve` returns the part to emit — `{ text }` for a slot that resolves NOW
 * (a refinement's base option is a declaration-time constant) or `{ slot }` for
 * one that resolves later — and is expected to THROW for a name it does not
 * recognise. Refusing is the caller's job because only the caller can say what
 * the legal names were and what they are for, and a slot silently kept as
 * literal text is the failure this whole mechanism exists to prevent: it would
 * emit `{srid}` into SQL verbatim.
 */
export function scanTemplate(template: string, resolve: (slot: string) => TemplatePart): Template {
  const parts: TemplatePart[] = [];
  let at = 0;
  TEMPLATE_SLOT.lastIndex = 0;
  for (let m = TEMPLATE_SLOT.exec(template); m !== null; m = TEMPLATE_SLOT.exec(template)) {
    if (m.index > at) parts.push({ text: template.slice(at, m.index) });
    at = m.index + m[0].length;
    /* v8 ignore next -- group 1 always participates in a match of this regex, so the `??` is a type narrowing rather than a case */
    parts.push(resolve(m[1] ?? ''));
  }
  if (at < template.length) parts.push({ text: template.slice(at) });
  return parts;
}

/** Every slot name `template` still carries, in first-appearance order. */
export function templateSlotNames(template: Template): Set<string> {
  const slots = new Set<string>();
  for (const part of template) {
    if (isSlot(part)) slots.add(part.slot);
  }
  return slots;
}
