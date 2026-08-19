/**
 * Smoke-check the BUILT artifact, through every specifier the `exports` map
 * publishes.
 *
 * The suite runs from `src`, so it cannot see a packaging failure AT ALL — not a
 * bad `exports` map, not a chunk whose module-eval order is wrong, not a second
 * copy of a class. This package's `exports` deliberately points `./conformance`
 * at the same bundle as `.` (see the note on the re-export in `src/index.ts`),
 * and that decision is exactly the kind only the artifact can falsify. So
 * `npm run build` ends here.
 *
 * IT RESOLVES THE `exports` MAP ITSELF rather than importing by package NAME,
 * and that is not paranoia — it is the one way to measure the PACKAGE in this
 * monorepo. The root `tsconfig.base.json` maps the bare specifier
 * `@aeye/query` → `packages/query/src/index.ts`, and that mapping covers the
 * bare name only, so a by-name import of `@aeye/query` and one of
 * `@aeye/query/conformance` load two DIFFERENT files here (src and dist) and
 * every cross-specifier check would fail against a package that is perfectly
 * fine. Reading the map and importing the files it names measures what a
 * consumer installs.
 *
 * RUN UNDER `tsx`, NOT BARE `node`: the workspace-local `@aeye/core` build emits
 * extensionless relative imports (`./types`), which node's ESM resolver refuses,
 * so a bare `node` run dies in a SIBLING package before reaching anything here.
 * Nothing in this file depends on TypeScript.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const failures = [];
const check = (what, fn) => {
  try {
    const detail = fn();
    if (detail !== true) failures.push(`${what}: ${detail}`);
  } catch (err) {
    failures.push(`${what} THREW: ${err instanceof Error ? err.message : String(err)}`);
  }
};

/** The file the `import` condition of `exports[specifier]` names. */
function target(specifier) {
  const entry = pkg.exports[specifier];
  const file = entry?.import?.default ?? entry?.default;
  if (typeof file !== 'string') throw new Error(`exports["${specifier}"] names no import target`);
  return pathToFileURL(resolve(root, file)).href;
}

const specifiers = Object.keys(pkg.exports);
const loaded = new Map();
for (const specifier of specifiers) {
  // eslint-disable-next-line no-await-in-loop -- a handful of specifiers, in order
  loaded.set(specifier, await import(target(specifier)));
}

const barrel = loaded.get('.');
const subpath = loaded.get('./conformance');

// The failure a second SELF-CONTAINED bundle produces: two copies of every
// class, so `instanceof` is false across the specifiers and the harness reports
// spurious violations for correct types.
check('every specifier resolves to ONE module', () =>
  specifiers.every((s) => loaded.get(s).checkFieldType === barrel.checkFieldType)
  || 'two specifiers hold DIFFERENT bindings');

check('the conformance surface is reachable from the subpath', () =>
  (typeof subpath.checkFieldType === 'function' && typeof subpath.checkLatticeLaws === 'function')
  || 'the subpath does not expose the harness');

// The failure a bad chunk order produces: a builtin array that is empty at the
// moment `createRegistry` reads it.
check('createRegistry() over the built bundle', () => {
  const registry = barrel.createRegistry();
  registry.registerFieldType({
    name: 'Geometry', base: 'json', instructions: 'A geometry, for the dist smoke check.',
    ownOptions: { srid: { type: { kind: 'number', whole: true }, default: 4326 } },
    sql: { postgres: 'geometry({srid})' },
    compare: { ordering: false },
  });
  const ft = registry.parseFieldType({ kind: 'json', as: 'Geometry', with: { srid: 3857 } });
  const sql = registry.dialect('postgres').sqlTypeFor(ft);
  return sql === 'geometry(3857)' || `sqlTypeFor gave ${sql}`;
});

check('the harness runs, and agrees with the barrel about classes', () => {
  const report = subpath.checkFieldType({ name: 'uuid', base: 'text', instructions: 'A UUID.' });
  if (!report.ok) return `checkFieldType reported ${report.problems.map((p) => p.code).join(', ')}`;
  // A composite type built off the BARREL, met against a top the HARNESS built.
  // `ArrayFieldType.meetWith` is an `instanceof` check, so with two copies of the
  // classes this answers with a spurious `top-identity` violation.
  const mine = barrel.createRegistry().parseFieldType({ kind: 'array', item: { kind: 'text' } });
  const laws = subpath.checkLatticeLaws({ mine });
  return laws.ok || `cross-specifier laws failed: ${laws.failed.map((l) => l.law).join(', ')}`;
});

if (failures.length > 0) {
  console.error('check-dist: the BUILT package is broken\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log(`check-dist: ok — ${specifiers.length} specifiers, one module, and the built bundle runs`);
