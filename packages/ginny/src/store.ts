import fs from 'fs';
import path from 'path';
import type { TypeDef, ExprDef } from '@aeye/gin';

const THRESHOLD = parseInt(process.env['GIN_SEARCH_THRESHOLD'] ?? '20', 10);

export interface SearchResult {
  name: string;
  score: number;
  summary: string;
}

export interface Store {
  searchTypes(q: { keywords: string[]; limit?: number }): SearchResult[];
  readType(name: string): TypeDef;
  writeType(def: TypeDef): string;

  searchFns(q: { keywords: string[]; limit?: number }): SearchResult[];
  readFn(name: string): { type: TypeDef; body: ExprDef };
  writeFn(name: string, v: { type: TypeDef; body: ExprDef }): string;

  searchVars(q: { keywords: string[]; limit?: number }): SearchResult[];
  readVar(name: string): { type: TypeDef; value: unknown; docs?: string };
  writeVar(name: string, v: { type: TypeDef; value: unknown; docs?: string }): string;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function scoreText(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((acc, kw) => {
    const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = lower.match(new RegExp(escaped, 'g'));
    return acc + (matches?.length ?? 0);
  }, 0);
}

function readDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5));
}

function readJSON<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function writeJSON(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function searchDir<T>(
  dir: string,
  getSummary: (name: string, data: T) => string,
  getSearchText: (name: string, data: T) => string,
  q: { keywords: string[]; limit?: number },
): SearchResult[] {
  const names = readDir(dir);
  const limit = q.limit ?? 10;

  if (names.length <= THRESHOLD || q.keywords.length === 0) {
    return names.slice(0, limit).map(name => {
      const data = readJSON<T>(path.join(dir, `${name}.json`));
      return { name, score: 0, summary: getSummary(name, data) };
    });
  }

  const results = names.map(name => {
    const data = readJSON<T>(path.join(dir, `${name}.json`));
    const text = getSearchText(name, data);
    return { name, score: scoreText(text, q.keywords), summary: getSummary(name, data) };
  });

  return results
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function createStore(cwd: string): Store {
  const typesDir = path.join(cwd, 'types');
  const fnsDir = path.join(cwd, 'fns');
  const varsDir = path.join(cwd, 'vars');

  return {
    searchTypes(q) {
      type T = TypeDef & { docs?: string; props?: Record<string, unknown> };
      return searchDir<T>(
        typesDir,
        (name, d) => `${name}: extends ${d['extends'] ?? d.name ?? '?'}${d.docs ? ` — ${d.docs}` : ''}`,
        (name, d) => {
          const parts = [name, d.docs ?? '', d['extends'] ?? '', d.name ?? ''];
          if (d.props) parts.push(...Object.keys(d.props));
          return parts.join(' ');
        },
        q,
      );
    },

    readType(name) {
      return readJSON<TypeDef>(path.join(typesDir, `${name}.json`));
    },

    writeType(def) {
      const name = (def as any).name as string;
      const file = path.join(typesDir, `${name}.json`);
      writeJSON(file, def);
      return file;
    },

    searchFns(q) {
      type T = { type?: TypeDef; body?: ExprDef; docs?: string };
      return searchDir<T>(
        fnsDir,
        (name, d) => `${name}${d.docs ? ` — ${d.docs}` : ''}`,
        (name, d) => `${name} ${d.docs ?? ''}`,
        q,
      );
    },

    readFn(name) {
      return readJSON<{ type: TypeDef; body: ExprDef }>(path.join(fnsDir, `${name}.json`));
    },

    writeFn(name, v) {
      const file = path.join(fnsDir, `${name}.json`);
      writeJSON(file, v);
      return file;
    },

    searchVars(q) {
      type T = { type?: TypeDef; value?: unknown; docs?: string };
      return searchDir<T>(
        varsDir,
        (name, d) => `${name}: ${d.docs ?? '(no docs)'}`,
        (name, d) => `${name} ${d.docs ?? ''}`,
        q,
      );
    },

    readVar(name) {
      return readJSON<{ type: TypeDef; value: unknown; docs?: string }>(path.join(varsDir, `${name}.json`));
    },

    writeVar(name, v) {
      const file = path.join(varsDir, `${name}.json`);
      writeJSON(file, v);
      return file;
    },
  };
}
