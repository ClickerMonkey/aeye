/**
 * Pretty forms of data files: json indented two spaces, and yaml written out evenly (through js-yaml, an optional
 * peer). A converter declines when the pretty form would be the raw text again, or when the text does not parse, so
 * the raw text stands as the LLM-ready form.
 */
import { Buffer } from "node:buffer";
import { optionalModule } from "../optional.js";
import type { ResourceConverter, ResourceSource } from "../types.js";
import { assertNotAborted, collectInput } from "../utils.js";
import type { ResourceVersionOf } from "../versions.js";

/** Loads js-yaml (an optional peer dependency) for yaml. */
const loadYaml = optionalModule(async () => (await import("js-yaml")).default);

/** The text of a source, without a byte order mark. */
async function sourceText(source: ResourceSource): Promise<string> {
  const text = Buffer.from(await collectInput(source.input)).toString("utf8");
  return text.startsWith("﻿") ? text.slice(1) : text;
}

/** A code version, or undefined when it says nothing the raw text doesn't (the same text, line endings aside). */
function codeVersion(converter: string, from: string, language: string, raw: string, pretty: string): ResourceVersionOf<"code"> | undefined {
  if (pretty.trim() === raw.replace(/\r\n/g, "\n").trim()) return undefined;
  return { kind: "code", converter, from, language, text: pretty };
}

/** Parses json, or undefined when the text is not json. */
function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/**
 * Json indented two spaces. Json lines (one value per line, `.jsonl`) have each line pretty printed, separated by a
 * blank line. Text that is neither is declined.
 */
export const jsonConverter: ResourceConverter = {
  id: "json-pretty",
  supportedTypes: ["json"],
  async convert(source, context) {
    assertNotAborted(context.options.signal);
    const raw = await sourceText(source);
    const whole = parseJson(raw);
    if (whole) return codeVersion("json-pretty", "json", "json", raw, JSON.stringify(whole.value, null, 2));
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "").map(parseJson);
    if (lines.length === 0 || lines.some((line) => line === undefined)) return undefined;
    const pretty = lines.map((line) => JSON.stringify(line?.value, null, 2)).join("\n\n");
    return codeVersion("json-pretty", "json", "json", raw, pretty);
  },
};

/** Yaml written out evenly: two-space indents, block style, documents separated by `---`. */
export const yamlConverter: ResourceConverter = {
  id: "yaml-pretty",
  supportedTypes: ["yaml"],
  async isSupported() {
    return (await loadYaml()) !== undefined;
  },
  async convert(source, context) {
    assertNotAborted(context.options.signal);
    const yaml = await loadYaml();
    if (!yaml) return undefined;
    const raw = await sourceText(source);
    // Writing yaml out again loses its comments, which are often the most useful part; such a file is left as it is.
    if (/(?:^|\s)#/m.test(raw)) return undefined;
    let documents: unknown[];
    try {
      documents = yaml.loadAll(raw, undefined, { schema: yaml.CORE_SCHEMA });
    } catch {
      return undefined;
    }
    const pretty = documents.map((document) => yaml.dump(document, { schema: yaml.CORE_SCHEMA, indent: 2, lineWidth: 120, noRefs: true }).trimEnd()).join("\n---\n");
    return codeVersion("yaml-pretty", "yaml", "yaml", raw, pretty);
  },
};
