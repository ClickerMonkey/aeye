/**
 * Helpers shared by the scrapers that read provider docs pages as Markdown.
 */

import { REASONING_EFFORTS, type ReasoningEffort } from '@aeye/core';

/**
 * Fetch a docs page as Markdown, or undefined when it doesn't exist.
 */
export async function fetchMarkdown(url: string): Promise<string | undefined> {
  const response = await fetch(url);
  return response.ok ? response.text() : undefined;
}

/**
 * The body of a `##` or `###` section, up to the next heading of the same or
 * a higher level.
 */
export function section(markdown: string, heading: string): string {
  const match = new RegExp(`^(#{2,3}) ${heading}\\s*$`, 'm').exec(markdown);
  if (!match) {
    return '';
  }
  const rest = markdown.slice(match.index + match[0].length);
  const end = new RegExp(`^#{2,${match[1].length}} `, 'm').exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

/**
 * Every `### heading` in a section, with its body.
 */
export function subsections(markdown: string): Map<string, string> {
  const parts = markdown.split(/^### /m).slice(1);
  return new Map(parts.map(part => {
    const newline = part.indexOf('\n');
    return [part.slice(0, newline).trim(), part.slice(newline)];
  }));
}

/**
 * The text of each `- ` (or `+ `) bullet.
 */
export function bullets(markdown: string): string[] {
  return markdown.split('\n').flatMap(line => /^[-+] /.test(line) ? [line.slice(2).trim()] : []);
}

/**
 * The cells of a table line.
 */
function cells(line: string): string[] {
  return line.trim().slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());
}

/**
 * The cells of each table body row.
 */
export function tableRows(markdown: string): string[][] {
  return markdown.split('\n')
    .filter(line => line.startsWith('|') && !/^\|\s*-/.test(line))
    .slice(1)
    .map(cells);
}

/**
 * The body rows of the first table whose header line matches `header`, each
 * keyed by column name.
 */
export function tableRecords(markdown: string, header: RegExp): Map<string, string>[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => line.startsWith('|') && header.test(line));
  if (start < 0) {
    return [];
  }
  const end = lines.findIndex((line, i) => i > start && !line.startsWith('|'));
  const columns = cells(lines[start]);
  return tableRows(lines.slice(start, end < 0 ? undefined : end).join('\n'))
    .map(row => new Map(row.map((cell, i) => [columns[i], cell])));
}

/**
 * A `$1.25` price, or a `1,050,000` count, as a number.
 */
export function amount(text: string): number | undefined {
  const parsed = Number(text.replace(/[$,]/g, ''));
  return text && Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A date such as `April 8, 2027` as YYYY-MM-DD, or undefined when it isn't one.
 */
export function isoDate(text: string): string | undefined {
  const parsed = new Date(`${text} UTC`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

/**
 * The reasoning efforts a list such as `low, medium, high` names, in order.
 */
export function reasoningEfforts(text: string): ReasoningEffort[] {
  return REASONING_EFFORTS.filter((effort: ReasoningEffort) => new RegExp(`\\b${effort}\\b`).test(text));
}
