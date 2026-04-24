/**
 * Per-prompt model resolution.
 *
 * Each sub-agent can run on a different model — the heavyweight programmer
 * might want gpt-4o while the catalog designers can run on something
 * cheaper. Users configure via `GIN_<KEY>_MODEL` env vars with a common
 * `GIN_MODEL` fallback:
 *
 *   GIN_PROGRAMMER_MODEL=gpt-4o
 *   GIN_RESEARCHER_MODEL=gpt-4o-mini
 *   GIN_ARCHITECT_MODEL=gpt-4o-mini       # designs / picks gin types
 *   GIN_ENGINEER_MODEL=gpt-4o             # designs reusable gin functions
 *   GIN_DBA_MODEL=gpt-4o-mini             # curates named typed vars (vars.*)
 *   GIN_LLM_MODEL=gpt-4o-mini             # used by the fns.llm native inside programs
 *   GIN_MODEL=gpt-4o-mini                 # fallback for any key above
 */
export const MODEL_KEYS = [
  'programmer',
  'researcher',
  'architect',
  'engineer',
  'dba',
  'llm',
] as const;

export type ModelKey = (typeof MODEL_KEYS)[number];

/**
 * Returns a metadata fragment with `model.id` set, or undefined if neither
 * a key-specific override nor `GIN_MODEL` is configured (let the AI's
 * selector pick). Prompt-level metadata overrides the AI instance's
 * `defaultMetadata.model`, so per-prompt tuning works without touching the
 * global default.
 */
export function modelFor(key: ModelKey): { model: { id: string } } | undefined {
  const envKey = `GIN_${key.toUpperCase()}_MODEL`;
  const specific = process.env[envKey];
  const fallback = process.env['GIN_MODEL'];
  const id = (specific && specific.trim()) || (fallback && fallback.trim());
  return id ? { model: { id } } : undefined;
}
