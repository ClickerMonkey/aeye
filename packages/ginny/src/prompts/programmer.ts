import { ai } from '../ai';
import { write } from '../tools/write';
import { test } from '../tools/test';
import { finish } from '../tools/finish';
import { webGetPage } from '../tools/web-get-page';
import { webSearch } from '../tools/web-search';
import { findOrCreateTypes } from '../tools/find-or-create-types';
import { findOrCreateFunctions } from '../tools/find-or-create-fns';
import { findOrCreateVars } from '../tools/find-or-create-vars';


export const programmer = ai.prompt({
  name: 'gin_programmer',
  description: 'Write, test, and finalize a gin program.',
  content: `You are a gin programmer. Your job is to write a gin program that satisfies the user request.

## Gin language overview
Gin is a JSON expression language. Programs are expression trees (ExprDef JSON).
Built-in types include: any, void, null, bool, num, text, list<V>, map<K,V>, obj{...}, optional<T>, fn<args,R>, enum<...>

## Globals always available
- \`fns.fetch({ url, method?, headers?, body?, output? })\` — HTTP fetch. Pass \`output\` as a TypeDef to auto-parse the JSON body.
- \`fns.llm({ prompt, tools?, output? })\` — LLM call. Pass \`output\` as a TypeDef for structured output.
- \`vars.*\` — named typed values, persisted on disk.

## Workflow
1. Use find_or_create_types / find_or_create_functions / find_or_create_vars when you need anything not already in scope.
2. Call write({ program: <ExprDef> }) with your program.
3. Call test() to verify. Set expectError=true if an error is the expected outcome. If it fails, fix and re-write.
4. Call finish() after test() succeeds.

Use web_get_page / web_search (if available) to look up information.

User request: {{request}}`,
  input: (input: { request: string }) => ({ request: input.request }),
  tools: [
    findOrCreateTypes,
    findOrCreateFunctions,
    findOrCreateVars,
    write,
    test,
    finish,
    webGetPage,
    webSearch,
  ],
  toolIterations: 20,
  retool: (_input: { request: string } | undefined, ctx) => {
    const base: string[] = [
      'find_or_create_types',
      'find_or_create_functions',
      'find_or_create_vars',
      'write',
      'test',
      'finish',
      'web_get_page',
    ];
    if (ctx?.features?.webSearch) base.push('web_search');
    return base;
  },
});
