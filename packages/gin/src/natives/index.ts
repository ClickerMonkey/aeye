import type { Registry, NativeImpl } from '../registry';
import { anyNatives, nullNatives, voidNatives } from './any';
import { boolNatives } from './bool';
import { numNatives } from './num';
import { textNatives } from './text';
import { listNatives } from './list';
import { mapNatives } from './map';
import { tupleNatives } from './tuple';
import { objNatives } from './obj';
import { optionalNatives, nullableNatives, notNatives, enumNatives } from './wrappers';
import { dateNatives, timestampNatives, durationNatives } from './temporal';
import { colorNatives } from './color';

/**
 * Register every built-in native implementation into a Registry.
 * User overrides via registry.setNative(id, impl) take precedence at
 * eval time (they're checked via getNative on every native invocation).
 */
export function registerBuiltinNatives(registry: Registry): Registry {
  const all: Record<string, NativeImpl>[] = [
    anyNatives,
    voidNatives,
    nullNatives,
    boolNatives,
    numNatives,
    textNatives,
    listNatives,
    mapNatives,
    tupleNatives,
    objNatives,
    optionalNatives,
    nullableNatives,
    notNatives,
    enumNatives,
    dateNatives,
    timestampNatives,
    durationNatives,
    colorNatives,
  ];
  for (const batch of all) {
    for (const [id, impl] of Object.entries(batch)) {
      registry.setNative(id, impl);
    }
  }
  return registry;
}
