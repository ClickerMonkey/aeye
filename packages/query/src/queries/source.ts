/**
 * QuerySource — a resolved FROM / derived source. One of three authored
 * shapes (`SourceDef`) collapses into TWO runtime kinds here:
 *  - a TYPE source (`sourceKind: 'type'`) — a registered Type or a CTE
 *    referenced by name. Authored either as the plain `{ kind:'type' }` (bound
 *    under its type name) or the `{ kind:'aliased' }` escape hatch (bound under
 *    a custom `as`). Both resolve to a Type; only the bound `alias` differs.
 *  - a SUBQUERY source (`sourceKind: 'subquery'`) — a derived source aliased
 *    into the scope.
 *
 * Provides three views:
 *  - RESOLUTION (`resolvedType` / `bindInto`) — bind the alias to a typed
 *    type so fields referencing it type-check.
 *  - VALIDATION (`validateWalk`).
 *  - RUNTIME (`rows`) — produce the initial `SourceRow`s for the source.
 */
import type { SourceDef, JsonValue } from '../schema';
import type { Registry } from '../registry';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType, TypeResolved } from '../resolved-type';
import type { Problems } from '../problem';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow, SourceRecord } from '../runtime/row';
import { Type } from '../type';
import { didYouMean } from '../aids';
import type { Query } from './query';
import { syntheticType } from './query';
import { TabularFunctionCallExpr } from '../exprs/index';
import {
  parseNamedArgs,
  namedArgsToJSON,
} from '../exprs/_function-args';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';

/** A resolved FROM / derived source — a TYPE source (registered Type or CTE by name), a SUBQUERY source, or a tabular FUNCTION source. */
export class QuerySource {
  private constructor(
    /** The runtime source kind: a registered type / CTE, a derived subquery, or a tabular function. */
    readonly sourceKind: 'type' | 'subquery' | 'function',
    /** The alias this source is bound under. */
    readonly alias: string,
    /** Type / CTE name for a type source. */
    readonly typeName: string | undefined,
    /** Parsed subquery for a derived source. */
    readonly subquery: Query | undefined,
    /** Parsed tabular-function call for a function source. */
    readonly tabular: TabularFunctionCallExpr | undefined = undefined,
  ) {}

  /** Build a `QuerySource` from its authored `SourceDef`, collapsing the three authored shapes into the two runtime kinds. */
  static from(def: SourceDef, registry: Registry): QuerySource {
    switch (def.kind) {
      case 'type':
        // Plain type source: bound under (and referenced by) its TYPE NAME.
        return new QuerySource('type', def.type, def.type, undefined);
      case 'aliased':
        // Explicit escape hatch: a type read under a custom alias (self-join /
        // collision break). Bound under `as`, but still a `type` source kind —
        // it resolves to the Type named `type`.
        return new QuerySource('type', def.as, def.type, undefined);
      case 'subquery':
        return new QuerySource('subquery', def.as, undefined, registry.parseQuery(def.query));
      case 'function':
        return new QuerySource(
          'function',
          def.as,
          undefined,
          undefined,
          new TabularFunctionCallExpr(def.function, parseNamedArgs(def.args, registry)),
        );
      /* v8 ignore next 2 -- exhaustive over the SourceDef union; unreachable */
      default:
        return assertNeverSource(def);
    }
  }

  /** Resolve the type this source binds (its alias → typed type). */
  resolvedType(engine: QueryEngine, scope: QueryScope): TypeResolved {
    if (this.sourceKind === 'function' && this.tabular) {
      // A tabular function resolves to its declared output Type; re-source it
      // under THIS source's alias so field-refs into it use the alias.
      const out = this.tabular.resolve(engine, scope);
      /* v8 ignore start -- TabularFunctionCallExpr.resolve always yields a type-kind (declared or synthetic), so the non-type fallback is unreachable */
      if (out.kind === 'type') return { kind: 'type', type: out.type, source: this.alias, synthetic: true };
      return {
        kind: 'type',
        type: new Type({ name: this.alias, fields: [], indexes: [], count: 0, bytes: 0 }),
        source: this.alias,
        synthetic: true,
      };
    }
    /* v8 ignore stop */
    if (this.sourceKind === 'type' && this.typeName !== undefined) {
      const type = engine.type(this.typeName);
      if (type) return { kind: 'type', type, source: this.alias, synthetic: false };
      // A CTE (or upstream binding) referenced by name.
      const bound = scope.lookup(this.typeName);
      if (bound && bound.kind === 'type') {
        return { kind: 'type', type: bound.type, source: this.alias, synthetic: bound.synthetic };
      }
      // Unknown — keep resolution total; validateWalk reports the problem.
      return {
        kind: 'type',
        type: new Type({ name: this.typeName, fields: [], indexes: [], count: 0, bytes: 0 }),
        source: this.alias,
        synthetic: true,
      };
    }
    const cols = this.subquery!.outputFields(engine, scope.child());
    return { kind: 'type', type: syntheticType(this.alias, cols), source: this.alias, synthetic: true };
  }

  /** Bind this source's alias into `scope`. */
  bindInto(engine: QueryEngine, scope: QueryScope): void {
    scope.bind(this.alias, this.resolvedType(engine, scope));
  }

  /** Validate this source: an unknown type / CTE name, or a bad tabular-function call / subquery. */
  validateWalk(engine: QueryEngine, scope: QueryScope, p: Problems): void {
    if (this.sourceKind === 'function' && this.tabular) {
      // Validate the tabular call (unknown / non-tabular function + arg types).
      this.tabular.validateWalk(engine, scope, p, {
        inAggregate: false,
        inWindow: false,
        allowAggregate: false,
        groupKeys: [],
        inGroupBy: false,
      });
      return;
    }
    if (this.sourceKind === 'type' && this.typeName !== undefined) {
      if (!engine.type(this.typeName) && !scope.has(this.typeName)) {
        // Candidates: every registered Type name PLUS the CTE / source names
        // currently in scope (either is a valid `type` reference here).
        const candidates = [
          ...engine.registry.typeList().map((t) => t.name),
          ...scope.sources(),
        ];
        p.error('source.unknown-type', `Unknown source type / CTE '${this.typeName}'.${didYouMean(this.typeName, candidates)}`);
      }
      return;
    }
    if (this.subquery) {
      this.subquery.validateWalk(engine, scope.child(), p, {
        inAggregate: false,
        inWindow: false,
        allowAggregate: true,
        groupKeys: [],
        inGroupBy: false,
      });
    }
  }

  /** Produce the initial runtime rows (one per record, under the alias). */
  async rows(ctx: RuntimeContext): Promise<SourceRow[]> {
    if (this.sourceKind === 'function' && this.tabular) {
      // Invoke the registered tabular function for its rows (raw JSON array).
      const value = await this.tabular.evaluate(ctx, null);
      const raw = value.raw;
      if (!Array.isArray(raw)) return [];
      return raw.map((r) => ({ [this.alias]: asRecord(r) }));
    }
    if (this.sourceKind === 'type' && this.typeName !== undefined) {
      const recs = await ctx.recordsFor(this.typeName);
      if (!recs) return [];
      return recs.map((r) => ({ [this.alias]: r }));
    }
    // A FROM subquery is a NESTED query — run it non-root so a Type's
    // `defaultOrder` with `applyTo: 'result'` does not treat it as the entry.
    const result = await ctx.withNonRoot(() => this.subquery!.execute(ctx));
    return result.rows.map((r) => ({ [this.alias]: r }));
  }

  /** The Type names this source reads: the type name, a subquery's referenced types, or none for a function. */
  referencedTypes(): readonly string[] {
    if (this.sourceKind === 'function') return [];
    if (this.sourceKind === 'type' && this.typeName !== undefined) return [this.typeName];
    /* v8 ignore next -- only a subquery source reaches here, so `subquery` is always defined */
    return this.subquery ? this.subquery.referencedTypes() : [];
  }

  /** Emit this source's FROM fragment: `… AS "alias"`. */
  fromSQL(dialect: Dialect, ctx: SqlContext): SqlText {
    if (this.sourceKind === 'function' && this.tabular) {
      // `<function>(args) AS "alias"`.
      return SqlText.concat([this.tabular.toSQL(dialect, ctx), SqlText.raw(' AS '), dialect.ident(this.alias)]);
    }
    if (this.sourceKind === 'type' && this.typeName !== undefined) {
      // A backed Type emits its real underlying source name, still aliased to
      // the bound alias; a CTE (no backing) keeps its own name.
      const table = ctx.engine.sourceTable(this.typeName);
      return SqlText.concat([dialect.ident(table), SqlText.raw(' AS '), dialect.ident(this.alias)]);
    }
    const sub = this.subquery!.toSQL(dialect, ctx).parens();
    return SqlText.concat([sub, SqlText.raw(' AS '), dialect.ident(this.alias)]);
  }

  /** Serialize back to a `SourceDef` (the plain `type` shape, or the `aliased` shape when the alias differs from the type name). */
  toJSON(): SourceDef {
    if (this.sourceKind === 'function' && this.tabular) {
      const def = this.tabular.toJSON();
      return { kind: 'function', function: def.function, args: namedArgsToJSON(this.tabular.args), as: this.alias };
    }
    if (this.sourceKind === 'type' && this.typeName !== undefined) {
      // Bound under its type name ⇒ the plain `type` source; a custom alias
      // (self-join / collision break) ⇒ the explicit `aliased` escape hatch.
      return this.alias === this.typeName
        ? { kind: 'type', type: this.typeName }
        : { kind: 'aliased', type: this.typeName, as: this.alias };
    }
    return { kind: 'subquery', as: this.alias, query: this.subquery!.toJSON() };
  }

  /** Deep-clone this source (cloning any nested subquery / tabular call). */
  clone(): QuerySource {
    return new QuerySource(
      this.sourceKind,
      this.alias,
      this.typeName,
      this.subquery?.clone(),
      this.tabular?.clone(),
    );
  }
}

/**
 * A tabular function's produced row as a `SourceRecord`. A JSON object value
 * IS already a `{ field → JsonValue }` map; a non-object row (array / scalar /
 * null) has no columns, so it yields an empty record.
 */
function asRecord(value: JsonValue): SourceRecord {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

/* v8 ignore start -- compile-time exhaustiveness guard; unreachable at runtime */
/** Exhaustiveness guard for the `SourceDef` discriminated union. */
function assertNeverSource(def: never): never {
  throw new Error(`QuerySource.from: unhandled source kind ${JSON.stringify(def)}`);
}
/* v8 ignore stop */
