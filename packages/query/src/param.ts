/**
 * ParamSet — contextual bind-parameter type inference (plan algorithm "b").
 *
 * A `param` expression (`{ kind: 'param', name }`) carries only a name; its
 * type is inferred from HOW it is used. A single `ParamSet` lives on the root
 * `QueryScope` and is shared by every child scope, so observations made deep
 * in a tree accumulate in one place.
 *
 * Two interleaved streams of information feed a ParamSet during a validate
 * walk:
 *
 *  - `reference(name, at)` — a `ParamExpr` announces it exists at a JSON
 *    path. Used to detect params that are never given a type
 *    (`param.untyped`).
 *  - `observe(name, fieldType, at)` — an operator (comparison / in / between
 *    / function-call / …) resolved its NON-param side and tells the set what
 *    field type the param is being compared against, plus where. Used to
 *    unify a type and to detect incompatible uses (`param.conflict`).
 *
 * After the walk, `problems(p)` emits the two diagnostics, and `resolved` /
 * `toJSON` export the inferred types for building an input schema + binding.
 *
 * Type-safety note: this module performs ZERO casts. Field-type unification
 * is decided purely through `FieldType.comparableWith`, a total method on the
 * value-category union.
 */
import type { FieldType } from './field-type';
import type { ParamDef } from './schema';
import type { Problems } from './problem';

/** One recorded use of a param, tagged with where in the JSON it happened. */
interface ParamObservation {
  /** The field type the param was observed against. */
  fieldType: FieldType;
  /** Structural JSON path of the observing operand. */
  at: ReadonlyArray<string | number>;
}

/** Internal per-name accumulation. */
interface ParamRecord {
  /** Every place the bare `param` expr was referenced. */
  references: Array<ReadonlyArray<string | number>>;
  /** Every typed observation made for this param. */
  observations: ParamObservation[];
}

/** Accumulates bind-parameter references + type observations across a query, and reports conflicts as Problems. */
export class ParamSet {
  /** name → accumulated references + observations. Insertion-ordered. */
  private readonly records = new Map<string, ParamRecord>();

  private record(name: string): ParamRecord {
    let r = this.records.get(name);
    if (!r) {
      r = { references: [], observations: [] };
      this.records.set(name, r);
    }
    return r;
  }

  /** Announce that a `param` expression with `name` exists at JSON path `at`. */
  reference(name: string, at: ReadonlyArray<string | number> = []): void {
    this.record(name).references.push(at.slice());
  }

  /**
   * Record that `name` is used where a value of `fieldType` is expected, at
   * JSON path `at`. Callers invoke this AFTER resolving their non-param side.
   */
  observe(name: string, fieldType: FieldType, at: ReadonlyArray<string | number> = []): void {
    this.record(name).observations.push({ fieldType, at: at.slice() });
  }

  /** Names of every param seen (referenced and/or observed), in first-seen order. */
  names(): string[] {
    return Array.from(this.records.keys());
  }

  /**
   * The unified field type inferred for `name`, or `undefined` when it was
   * never observed OR its observations conflict. The first observation seeds
   * the unification; every later observation must be `comparableWith` it.
   */
  resolved(name: string): FieldType | undefined {
    const r = this.records.get(name);
    if (!r || r.observations.length === 0) return undefined;
    const first = r.observations[0]!.fieldType;
    for (let i = 1; i < r.observations.length; i++) {
      if (!first.comparableWith(r.observations[i]!.fieldType)) return undefined;
    }
    return first;
  }

  /**
   * Emit param diagnostics into `p`:
   *  - `param.untyped`  — referenced but never observed against any type, so
   *    its input type cannot be inferred. Reported at each reference site.
   *  - `param.conflict` — observed against mutually-incompatible types. The
   *    message names every conflicting use path; reported at the first
   *    offending observation.
   */
  problems(p: Problems): void {
    for (const [name, r] of this.records) {
      if (r.observations.length === 0) {
        // Never observed → untyped. Report at every place it was referenced.
        for (const at of r.references) {
          p.at([...at], () => {
            p.error(
              'param.untyped',
              `Parameter '${name}' is never compared against a typed value, so its type cannot be inferred. Use it in a comparison / filter / function argument against a known field.`,
            );
          });
        }
        continue;
      }
      // Detect the first observation incompatible with the seed.
      const seed = r.observations[0]!;
      for (let i = 1; i < r.observations.length; i++) {
        const other = r.observations[i]!;
        if (!seed.fieldType.comparableWith(other.fieldType)) {
          const seedPath = seed.at.join('.') || '(root)';
          const otherPath = other.at.join('.') || '(root)';
          p.at([...other.at], () => {
            p.error(
              'param.conflict',
              `Parameter '${name}' is used inconsistently: '${seed.fieldType.resolve()}' at ${seedPath} but '${other.fieldType.resolve()}' at ${otherPath}.`,
            );
          });
          break;
        }
      }
    }
  }

  /**
   * Export the resolved params as `ParamDef[]` for building the query's input
   * schema + binding map. Params that are untyped or in conflict are skipped
   * (their problems are reported separately by `problems`).
   */
  toJSON(): ParamDef[] {
    const out: ParamDef[] = [];
    for (const name of this.records.keys()) {
      const ft = this.resolved(name);
      if (ft) out.push({ name, type: ft.toJSON() });
    }
    return out;
  }
}
