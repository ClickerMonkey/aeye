/**
 * Transactional type mutation helpers shared by INSERT / UPDATE / DELETE.
 * They operate on a `TypeState` (original / current / deleted / updated /
 * inserted), keeping `current` consistent and recording the change in the
 * right map/set so a later commit layer could replay them.
 */
import type { JsonValue } from '../schema';
import type { SourceRecord } from '../runtime/row';
import type { TypeState } from '../runtime/context';
import { recordKey } from '../runtime/context';

/** Generate the next id for an inserted record (numeric max+1, else string). */
export function nextId(state: TypeState): JsonValue {
  let max = 0;
  let sawNumeric = false;
  for (const rec of state.current) {
    const id = rec['id'];
    if (typeof id === 'number') {
      sawNumeric = true;
      if (id > max) max = id;
    }
  }
  if (sawNumeric || state.current.length === 0) return max + 1;
  return `gen-${state.current.length + 1}`;
}

/** Insert a record (assigning an id when absent). Returns the stored record. */
export function insertRecord(state: TypeState, fields: SourceRecord): SourceRecord {
  const record: SourceRecord = { ...fields };
  if (record['id'] === undefined) record['id'] = nextId(state);
  const key = recordKey(record);
  state.deleted.delete(key);
  state.current.push(record);
  state.inserted.set(key, { ...record });
  return record;
}

/** Apply `fields` to an existing record in `current`; record the update. */
export function updateRecord(state: TypeState, target: SourceRecord, fields: SourceRecord): void {
  const key = recordKey(target);
  const record = state.current.find((r) => recordKey(r) === key);
  /* v8 ignore next -- updateRecord is only ever called with a target already present in `current` */
  if (!record) return;
  for (const k of Object.keys(fields)) record[k] = fields[k]!;
  if (state.inserted.has(key)) {
    const ins = state.inserted.get(key)!;
    for (const k of Object.keys(fields)) ins[k] = fields[k]!;
  } else {
    const existing = state.updated.get(key) ?? {};
    for (const k of Object.keys(fields)) existing[k] = fields[k]!;
    state.updated.set(key, existing);
  }
}

/** Remove a record from `current`; record the delete. */
export function deleteRecord(state: TypeState, target: SourceRecord): void {
  const key = recordKey(target);
  state.current = state.current.filter((r) => recordKey(r) !== key);
  if (state.inserted.has(key)) {
    state.inserted.delete(key);
  } else {
    state.updated.delete(key);
    state.deleted.add(key);
  }
}
