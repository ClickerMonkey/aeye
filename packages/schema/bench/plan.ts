/**
 * Planning speed: how long `profile.request([...])` takes to FIT a schema to a
 * model (the fitting ladder in src/request.ts), and how much rendering work
 * it does.
 *
 * Per (case, profile), each in its own child process so the first plan is
 * truly cold (no shared nodes from earlier cases):
 * - cold:    the first plan in the process (fresh bind, empty node caches);
 * - fresh:   a new bind of the same schema (new catalog / registry version):
 *            the static grammar's shared nodes are warm, the bind is not;
 * - repeat:  the same bind planned again (every render memoized).
 * `renders` counts the renderings the plan made (`Bound.render` misses, LENIENT
 * included), `compiles` the schemas compiled into nodes.
 *
 *   npm run bench:plan                 # every case, writes bench/.results/plan.json
 *   npm run bench:plan -- --only=dba   # cases whose id contains "dba"
 *   npm run bench:plan -- --tag=after  # label stored with the results
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANTHROPIC_STRICT, Bound, Compiler, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, staticBundle,
  type Profile, type RequestItem,
} from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));

export const PROFILES: Readonly<Record<string, Profile>> = {
  'openai-strict': OPENAI_STRICT, 'anthropic-strict': ANTHROPIC_STRICT, gemini: GOOGLE_STRICT, lenient: LENIENT,
};

interface PlanCase {
  readonly id: string;
  /** The request's items for a bind; `fresh` = a new bind (a new catalog / registry version). */
  readonly items: (fresh: boolean) => Promise<RequestItem[]>;
}

let version = 2_000_000;

const CASES: readonly PlanCase[] = [
  {
    id: 'cletus-dba',
    items: async () => {
      const { QueryToolArgs } = await import('../src/__tests__/corpus/cletus-dba');
      const { TYPES } = await import('../src/__tests__/corpus/cletus-dba-fixtures');
      // Keyed by the config data object: a new object is a new bind.
      const data = { types: [...TYPES], user: { maxQuerySchemaTypes: 10 } };
      return [{ kind: 'tool', name: 'query', schema: QueryToolArgs.bind({ config: { getData: () => data } } as never) }];
    },
  },
  {
    id: 'gin-grammar',
    items: async (fresh) => {
      const { WriteArgs } = await import('../src/__tests__/corpus/gin-grammar');
      const { asGrammarRegistry, fixtureRegistry } = await import('../src/__tests__/corpus/gin-fixtures');
      const reg = asGrammarRegistry(fixtureRegistry());
      if (fresh) (WriteArgs as unknown as { cache: Map<unknown, unknown> }).cache.clear();
      return [{ kind: 'tool', name: 'write', schema: WriteArgs.bind(reg) }];
    },
  },
  ...([
    ['query-open', {}],
    ['query-names', { depth: { functions: 'names' } }],
    ['query-typed', { depth: { functions: 'typed' } }],
    ['query-paired', { strict: true }],
  ] as const).map(([id, o]): PlanCase => ({
    id,
    items: async () => {
      const { QueryToolArgs } = await import('../src/__tests__/corpus/query');
      const { catalogOf, fixtureRegistry } = await import('../src/__tests__/corpus/query-fixtures');
      const cat = { ...catalogOf(fixtureRegistry()), version: ++version };
      return [{ kind: 'tool', name: 'query', schema: QueryToolArgs.bind(cat, o as never) }];
    },
  })),
  {
    id: 'product-query-set',
    items: async () => {
      const { QuerySetArgs } = await import('../src/__tests__/corpus/product');
      const { ctx } = await import('../src/__tests__/corpus/product-fixtures');
      const base = ctx();
      return [{ kind: 'tool', name: 'query_set', strict: true, schema: QuerySetArgs.bind(ctx({ catalog: { ...base.catalog, version: ++version } })) }];
    },
  },
  {
    id: 'request-129',
    items: async () => {
      const { CategoryComparisonChart, ImageFindArgs, TypeImportArgs } = await import('../src/__tests__/corpus/cletus-tools');
      const { McpServerConfig } = await import('../src/__tests__/corpus/harness-fns');
      const { Task } = await import('../src/__tests__/corpus/gin-values');
      const kinds = [TypeImportArgs, ImageFindArgs, McpServerConfig, CategoryComparisonChart, Task] as any[];
      return Array.from({ length: 129 }, (_, i) => ({
        kind: 'tool', name: `tool_${i}`, description: `Tool number ${i}.`,
        schema: staticBundle(kinds[i % kinds.length].describe(`Tool number ${i}.`)),
      }) as RequestItem);
    },
  },
];

// ---- counting -------------------------------------------------------------

const counts = { renders: 0, compiles: 0 };
function instrument(): void {
  const render = Bound.prototype.render;
  Bound.prototype.render = function (this: Bound<unknown>, profile: Profile) {
    if (!(this as unknown as { rendered: Map<string, unknown> }).rendered.has(profile.id)) counts.renders++;
    return render.call(this, profile) as never;
  };
  const compile = Compiler.prototype.compile;
  Compiler.prototype.compile = function (this: Compiler, ...args: Parameters<Compiler['compile']>) {
    counts.compiles++;
    return compile.apply(this, args);
  };
}

interface Row {
  case: string;
  profile: string;
  coldMs: number; coldRenders: number; coldCompiles: number;
  freshMs: number; freshRenders: number;
  repeatMs: number;
  outcome: string;
}

async function child(caseId: string, profileId: string): Promise<Row> {
  instrument();
  const c = CASES.find((x) => x.id === caseId)!;
  const target = ModelProfile.of(PROFILES[profileId]!);
  const time = async (fresh: boolean, itemsIn?: RequestItem[]) => {
    const items = itemsIn ?? await c.items(fresh);
    const r0 = counts.renders, c0 = counts.compiles;
    const t0 = performance.now();
    const req = target.request(items);
    const ms = performance.now() - t0;
    return { ms, renders: counts.renders - r0, compiles: counts.compiles - c0, req, items };
  };
  const cold = await time(false);
  const fresh = await time(true);
  const repeat = await time(false, fresh.items);
  const e = cold.req.entries.find((x) => x.delivery !== 'dispatched')!;
  const outcome = cold.req.entries.length > 1
    ? `${cold.req.entries.filter((x) => x.delivery === 'dispatched').length} dispatched`
    : `${e.strict ? 'strict' : 'loose'}${e.adjustments.length ? ' ' + e.adjustments.map((a) => a.kind + ('maxDepth' in a ? `=${a.maxDepth}` : 'maxEnumValues' in a ? `=${a.maxEnumValues}` : '')).join(',') : ''}`;
  return {
    case: caseId, profile: profileId,
    coldMs: cold.ms, coldRenders: cold.renders, coldCompiles: cold.compiles,
    freshMs: fresh.ms, freshRenders: fresh.renders,
    repeatMs: repeat.ms, outcome,
  };
}

const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms >= 1 ? ms.toFixed(1) : ms.toFixed(3));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const childArg = argv.find((a) => a.startsWith('--child='));
  if (childArg) {
    const [caseId, profileId] = childArg.slice(8).split(':') as [string, string];
    process.stdout.write('ROW ' + JSON.stringify(await child(caseId, profileId)) + '\n');
    return;
  }
  const only = argv.find((a) => a.startsWith('--only='))?.slice(7);
  const tag = argv.find((a) => a.startsWith('--tag='))?.slice(6) ?? 'run';
  const rows: Row[] = [];
  for (const c of CASES) {
    if (only && !c.id.includes(only)) continue;
    for (const p of Object.keys(PROFILES)) {
      const res = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), `--child=${c.id}:${p}`], {
        encoding: 'utf8', maxBuffer: 1 << 26, cwd: join(here, '..'),
      });
      const line = res.stdout.split('\n').find((l) => l.startsWith('ROW '));
      if (!line) { console.error(`${c.id} ${p} failed:\n${res.stderr}`); continue; }
      const row = JSON.parse(line.slice(4)) as Row;
      rows.push(row);
      console.log(`${row.case.padEnd(18)} ${row.profile.padEnd(17)} cold ${fmt(row.coldMs).padStart(7)} ms (${row.coldRenders} renders, ${row.coldCompiles} compiles)  fresh ${fmt(row.freshMs).padStart(7)} ms (${row.freshRenders})  repeat ${fmt(row.repeatMs)} ms  → ${row.outcome}`);
    }
  }
  const dir = join(here, '.results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'plan.json');
  const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, Row[]> : {};
  const prev = all[tag] ?? [];
  all[tag] = [...prev.filter((r) => !rows.some((x) => x.case === r.case && x.profile === r.profile)), ...rows];
  writeFileSync(file, JSON.stringify(all, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
