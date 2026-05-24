import type { Registry, NativeImpl } from '../registry';
import { Effects } from '../effects';
import { anyNatives, nullNatives, voidNatives } from './any';
import { boolNatives } from './bool';
import { numNatives } from './num';
import { textNatives } from './text';
import { listNatives, listNativesEffects } from './list';
import { mapNatives, mapNativesEffects } from './map';
import { tupleNatives, tupleNativesEffects } from './tuple';
import { objNatives, objNativesEffects } from './obj';
import { optionalNatives, nullableNatives, notNatives, enumNatives } from './wrappers';
import { dateNatives, timestampNatives, durationNatives } from './temporal';
import { colorNatives } from './color';

/**
 * Register every built-in native implementation into a Registry.
 * User overrides via registry.setNative(id, impl) take precedence at
 * eval time (they're checked via getNative on every native invocation).
 *
 * Each batch is paired with an OPTIONAL effects-overrides map: entries
 * NOT listed in the overrides default to `Effects.NONE` (the vast
 * majority — arithmetic, comparisons, accessors, conversions,
 * predicate checks). The few mutating natives (`list.push`,
 * `map.delete`, `object.indexSet`, `tuple.setAt`, ...) declare
 * `Effects.STATE` in their module's `<name>NativesEffects` sibling map.
 *
 * Side-effecting natives — `fns.fetch`, `fns.llm`, `fns.log`,
 * `fns.ask` — live in ginny and aren't registered here. They're a
 * fn-typed obj global; their effects propagate via the called fn
 * type's effects metadata (future work) rather than the registry.
 */
export function registerBuiltinNatives(registry: Registry): Registry {
  const batches: Array<{ impls: Record<string, NativeImpl>; effects?: Record<string, Effects> }> = [
    { impls: anyNatives },
    { impls: voidNatives },
    { impls: nullNatives },
    { impls: boolNatives },
    { impls: numNatives },
    { impls: textNatives },
    { impls: listNatives,   effects: listNativesEffects },
    { impls: mapNatives,    effects: mapNativesEffects },
    { impls: tupleNatives,  effects: tupleNativesEffects },
    { impls: objNatives,    effects: objNativesEffects },
    { impls: optionalNatives },
    { impls: nullableNatives },
    { impls: notNatives },
    { impls: enumNatives },
    { impls: dateNatives },
    { impls: timestampNatives },
    { impls: durationNatives },
    { impls: colorNatives },
  ];
  for (const batch of batches) {
    for (const [id, impl] of Object.entries(batch.impls)) {
      const effects = batch.effects?.[id] ?? Effects.NONE;
      registry.setNative(id, impl, effects);
    }
  }
  return registry;
}
