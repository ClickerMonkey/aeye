/**
 * Content detection for fetched bytes: the content type a server declares (mime type and charset), magic numbers for
 * binary formats, a look at text for html, xml and json, and decoding text in its declared or detected charset.
 */
import { Buffer } from "node:buffer";

/** A parsed `Content-Type` header. */
export interface ContentType {
  /** The mime type, lower-cased, without parameters. */
  mimeType: string;
  /** The `charset` parameter, lower-cased, when there is one. */
  charset?: string;
}

/** Parses a `Content-Type` header value (`text/html; charset=UTF-8`). */
export function parseContentType(value: string | null | undefined): ContentType | undefined {
  if (!value) return undefined;
  const [type = "", ...params] = value.split(";");
  const mimeType = type.trim().toLowerCase();
  if (mimeType === "") return undefined;
  const result: ContentType = { mimeType };
  for (const param of params) {
    const match = /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(param);
    if (match?.[1]) result.charset = match[1].toLowerCase();
  }
  return result;
}

/** Mime types that say nothing about the content, so detection looks past them. */
const GENERIC_MIME_TYPES = new Set([
  "application/octet-stream", "binary/octet-stream", "application/binary", "application/unknown", "application/x-unknown",
  "application/force-download", "application/download", "text/plain",
]);

/** True for a mime type that says nothing about the content (`application/octet-stream`, `text/plain`). */
export function isGenericMimeType(mimeType: string): boolean {
  return GENERIC_MIME_TYPES.has(mimeType);
}

/** A format told by its first bytes. */
export interface Magic {
  readonly type: string;
  readonly mimeType: string;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

/**
 * The format binary bytes are in, from their magic number: pdf, png, jpeg, gif, webp, bmp, ico, and zip (told apart
 * as a word document or a workbook by the entry names near its start). Undefined for anything else.
 */
export function sniffMagic(bytes: Uint8Array): Magic | undefined {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { type: "pdf", mimeType: "application/pdf" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: "image", mimeType: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { type: "image", mimeType: "image/jpeg" };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { type: "image", mimeType: "image/gif" };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { type: "image", mimeType: "image/webp" };
  if (startsWith(bytes, [0x42, 0x4d]) && bytes.length > 14 && bytes[6] === 0 && bytes[7] === 0) return { type: "image", mimeType: "image/bmp" };
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return { type: "image", mimeType: "image/x-icon" };
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // Entry names are stored as plain text in each local file header, and office files name their parts early.
    const head = Buffer.from(bytes.subarray(0, 64 * 1024)).toString("latin1");
    if (head.includes("word/")) return { type: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    if (head.includes("xl/")) return { type: "excel", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    return { type: "zip", mimeType: "application/zip" };
  }
  return undefined;
}

/** True when bytes look binary: a NUL byte, or many control characters, in the first 1024 bytes. */
export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 1024);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control++;
  }
  return sample.length > 0 && control / sample.length > 0.1;
}

/** The type text looks like from how it starts: html, svg, xml or json. Undefined when it could be anything. */
export function sniffText(text: string): Magic | undefined {
  const head = text.slice(0, 1024).replace(/^﻿/, "").trimStart().toLowerCase();
  if (/^<!doctype html|^<html[\s>]|^<head[\s>]|^<body[\s>]/.test(head)) return { type: "html", mimeType: "text/html" };
  if (/^<svg[\s>]/.test(head) || (head.startsWith("<?xml") && head.includes("<svg"))) return { type: "svg", mimeType: "image/svg+xml" };
  if (head.startsWith("<?xml")) return { type: "xml", mimeType: "application/xml" };
  if (/^[{[]/.test(head)) {
    try {
      JSON.parse(text);
      return { type: "json", mimeType: "application/json" };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The charset a byte order mark names, if the bytes start with one. */
function bomCharset(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return "utf-8";
  if (startsWith(bytes, [0xff, 0xfe])) return "utf-16le";
  if (startsWith(bytes, [0xfe, 0xff])) return "utf-16be";
  return undefined;
}

/** The charset an html page declares in a `<meta>` near its start. */
function metaCharset(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
  const match = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  return match?.[1]?.toLowerCase();
}

/** Charsets that are utf-8 already (us-ascii is a subset). */
const UTF8_CHARSETS = new Set(["utf-8", "utf8", "us-ascii", "ascii"]);

/** Text decoded from bytes, and the charset it was decoded from. */
export interface DecodedText {
  text: string;
  charset: string;
}

/**
 * Decodes text bytes: by their byte order mark, else the declared charset, else (for html) the page's `<meta
 * charset>`, else utf-8. An unknown charset is read as utf-8.
 */
export function decodeText(bytes: Uint8Array, declared?: string, html = false): DecodedText {
  const charset = bomCharset(bytes) ?? declared ?? (html ? metaCharset(bytes) : undefined) ?? "utf-8";
  try {
    return { text: new TextDecoder(charset).decode(bytes), charset };
  } catch {
    return { text: new TextDecoder("utf-8").decode(bytes), charset: "utf-8" };
  }
}

/** True when a charset is utf-8 (or ascii, a subset), so bytes in it need no transcoding. */
export function isUtf8Charset(charset: string): boolean {
  return UTF8_CHARSETS.has(charset.toLowerCase());
}
