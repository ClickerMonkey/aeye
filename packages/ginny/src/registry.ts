import { createRegistry as ginCreateRegistry, createEngine, registerBuiltinNatives } from '@aeye/gin';
import type { Registry, Engine } from '@aeye/gin';

export function bootstrap(): { registry: Registry; engine: Engine } {
  const registry = ginCreateRegistry();
  registerBuiltinNatives(registry);
  const engine = createEngine(registry);
  return { registry, engine };
}
