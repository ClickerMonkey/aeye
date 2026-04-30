import type { Registry, Value } from '@aeye/gin';
import { val } from '@aeye/gin';

/**
 * `fns.log({ message: any }): void` — print a runtime message to the
 * user. Distinct from the program's return value, which is the
 * computed result; `log` is the side-channel a program uses to narrate
 * progress or surface intermediate findings.
 *
 * Output goes to stderr with a `[log]` prefix so it doesn't blur with
 * the diagnostic stream `write`/`test` use. The body is rendered:
 *   - text                       → as-is
 *   - num / bool / null          → String(...)
 *   - timestamp / date / duration / color → Value.toString-equivalent
 *   - everything else            → JSON of the JSONValue envelope
 */
export function createLogImpl(registry: Registry) {
  return async (argsValue: Value): Promise<Value> => {
    const args = argsValue.raw as Record<string, Value>;
    const message = args['message'];
    process.stderr.write(`[log] ${formatMessage(message)}\n`);
    return val(registry.void(), undefined);
  };
}

export function registerLogType(registry: Registry) {
  return registry.fn(
    registry.obj({
      message: {
        type: registry.any(),
        docs: 'Anything to surface to the user — a status update, intermediate value, debug breadcrumb. Renders as text on stderr; complex values JSON-encode.',
      },
    }),
    registry.void(),
  );
}

function formatMessage(v: Value | undefined): string {
  if (!v) return '';
  const raw = v.raw;
  if (raw === null || raw === undefined) return String(raw);
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') {
    return String(raw);
  }
  // Composite or unknown — try a JSON envelope. Fall back to String() if
  // anything throws (e.g. circular refs, BigInt without serializer).
  try {
    return JSON.stringify(v.toJSON(), null, 2);
  } catch {
    return String(raw);
  }
}
