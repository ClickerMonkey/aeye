/**
 * Write-model helpers — the ONE place the INSERT-requiredness rule and the
 * effective per-field write permissions live, so validation (`queries/{insert,
 * update,delete}`) and schema-building (`llm/schemas` / `schema-build`) agree
 * byte-for-byte on what a Type / field permits.
 *
 * The model:
 *  - a Type is `insertable` / `updatable` / `deletable` (default true) — see the
 *    `Type` getters;
 *  - a field is `insertable` / `updatable` (default true), with an EXPLICIT flag
 *    overriding the computed-field default (a `FieldBacking.compute` field is
 *    non-insertable / non-updatable unless explicitly re-enabled) — see
 *    `Field.insertableFor` / `Field.updatableFor`;
 *  - a `FieldBacking.default` (value or factory) makes a field OPTIONAL-on-insert
 *    and is materialized at runtime.
 *
 * THE derived rule (`requiredOnInsert`): a field is REQUIRED on INSERT iff it is
 * insertable AND non-nullable AND has NO default AND is NOT computed. Everything
 * else is optional (nullable / has-default) or excluded (non-insertable).
 */
import type { Field } from './field';
import type { FieldBacking } from './backing';
import { hasFieldDefault } from './backing';
import type { ExprKind } from './schema';
import type { Problems } from './problem';

/**
 * Whether `field` is REQUIRED to be supplied on INSERT, given its backing `fb`.
 * The single rule both the schema builder (required-vs-optional) and the
 * validator (`insert.missing-required`) consult. Non-required insertable fields
 * are OPTIONAL; non-insertable fields are excluded from insert entirely.
 */
export function requiredOnInsert(field: Field, fb: FieldBacking | undefined): boolean {
  if (!field.insertableFor(fb)) return false;
  if (field.nullable) return false;
  if (hasFieldDefault(fb)) return false;
  if (fb?.compute) return false;
  return true;
}

/**
 * Gate expr `kind` against `field`'s `exprs` RESTRICTION at a site that names the
 * field directly (`source.field`), pushing `field.expr-denied` when the
 * restriction excludes the kind. Only the field's declared restriction is
 * enforced here — the field-TYPE floor (e.g. `array-op` needs an array field) is
 * each expr's own concern (`array-op.not-array`, `text-search.non-text`, …), so
 * this never double-reports a type mismatch. A field with no `exprs` is a no-op.
 */
export function checkFieldExpr(kind: ExprKind, field: Field, source: string, p: Problems): void {
  const exprs = field.exprs;
  if (!exprs) return;
  const denied = 'only' in exprs ? !exprs.only.includes(kind) : exprs.not.includes(kind);
  if (denied) {
    p.error(
      'field.expr-denied',
      `Field '${field.name}' (source '${source}') does not allow '${kind}' expressions.`,
    );
  }
}
