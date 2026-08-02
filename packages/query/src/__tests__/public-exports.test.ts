/**
 * A3 — types that were reachable only STRUCTURALLY are now exported by name.
 *
 * `RelationBacking` in particular is the type a consumer needs to write the
 * composite-FK / custom-`ON` escape hatch the package documents; without an
 * export, every call site had to re-declare a structural twin that can drift
 * from the real one. This test is a compile-time assertion in test's clothing:
 * if an export is dropped, `tsc` fails on the import, not on an expectation.
 */
import { describe, it, expect } from 'vitest';
import * as pkg from '../index';
import type {
  RelationBacking,
  RelationOn,
  RelationOnPair,
  SearchBacking,
  SemanticBacking,
  DefaultOrder,
  DefaultOrderTerm,
  DefaultOrderDir,
  DefaultOrderScope,
  RelationKeyPair,
  RelationResolved,
} from '../index';
import { IndexPart, Index, renameSource, aliasedDigest, relationKeyColumns, relationOf, valueFieldType } from '../index';
import { TextFieldType } from '../field-types/index';

describe('A3 — the public barrel', () => {
  it('exports the previously structural-only TYPES (compile-time)', () => {
    // Each alias is USED, so an unexported name is a type error above.
    const keys: RelationBacking = { keys: [{ local: 'a', foreign: 'b' }] };
    const on: RelationOn = { sql: () => undefined };
    const pair: RelationOnPair = { localField: 'a', foreignField: 'b' };
    const search: SearchBacking = { vectorField: 'tsv' };
    const semantic: SemanticBacking = { vectorField: 'embedding' };
    const dir: DefaultOrderDir = { dir: 'asc' };
    const term: DefaultOrderTerm = { ...dir, expr: () => undefined };
    const scope: DefaultOrderScope = 'result';
    const order: DefaultOrder = { terms: [term], applyTo: scope };
    const keyPair: RelationKeyPair = { local: 'a', foreign: 'b', keyType: new TextFieldType() };
    const resolved: RelationResolved = {
      source: 's', field: 'f', keyField: 'a', keyType: keyPair.keyType,
      to: 't', count: 1, belongsTo: true, keys: [keyPair],
    };
    expect([keys, on, pair, search, semantic, order, resolved].every((v) => v !== undefined)).toBe(true);
  });

  it('exports the previously unexported VALUES', () => {
    expect(typeof IndexPart).toBe('function');
    expect(typeof renameSource).toBe('function');
    expect(typeof aliasedDigest).toBe('function');
    expect(typeof relationKeyColumns).toBe('function');
    expect(typeof relationOf).toBe('function');
    expect(typeof valueFieldType).toBe('function');
    // And they are the same bindings the barrel re-exports.
    expect(pkg.IndexPart).toBe(IndexPart);
    expect(pkg.Index).toBe(Index);
  });
});
