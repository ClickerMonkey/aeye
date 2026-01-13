
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import url from 'url';
import { Resource } from './types';


function hasUrl(x: any): x is { url(): string } {
  return x && typeof x.url === 'function';
}
function hasBlob(x: any): x is { blob(): Promise<Blob> | Blob } {
  return x && typeof x.blob === 'function';
}
function hasRead(x: any): x is { read(): Promise<ReadableStream> | ReadableStream } {
  return x && typeof x.read === 'function';
}
function isAsyncIterable(x: any): x is AsyncIterable<Uint8Array> {
  return x && typeof x[Symbol.asyncIterator] === 'function';
}

/**
 * Determines the ideal format of a given resource.
 * 
 * @param resource 
 * @returns 
 */
export function getResourceFormat(resource: Resource): 'url' | 'base64' | 'stream' {
  if (typeof resource === 'string') {
    if (resource.startsWith('data:')) {
      return 'base64';
    } else if (resource.startsWith('http://') || resource.startsWith('https://')) {
      return 'url';
    } else {
      return 'base64';
    }
  }
  if (hasUrl(resource) || resource instanceof URL) {
    return 'url';
  }
  return 'stream';
}

/**
 * Converts the input resource to a URL string.
 * 
 * For input string:
 * - If input is already a URL or string, it is returned as-is.
 * - If input is a data URL (e.g. base64), it is returned as-is.
 * - Otherwise it is base64-encoded and returned as a data URL.
 * 
 * For URL:
 * - It is returned with toString().
 * 
 * For Uint8Array/File/ReadStream/ReadableStream:
 * - It is base64-encoded and returned as a data URL.
 * 
 * @param input - The resource to convert.
 * @param mimeType - Optional MIME type for the data URL if one cannot be determined.
 * @param fallback - Optional fallback string to return if input type is invalid.
 * @returns http(s) URL or data URL string
 */
export async function toURL(
  input: Resource,
  mimeType?: string, 
  fallback?: string
): Promise<string> {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === 'string' && (input.startsWith('data:') || input.startsWith('http://') || input.startsWith('https://'))) {
    return input;
  }
  if (hasUrl(input)) {
    return input.url();
  }

  return toBase64(input, mimeType, fallback);
}

/**
 * Converts the input resource to a Base64 data URL string.
 * This will represent the content of the resouce as a data URL.
 * 
 * @param input - The resource to convert.
 * @param mimeType - Optional MIME type for the data URL if one cannot be determined.
 * @param fallback - Optional fallback string to return if input type is invalid.
 * @returns - A promise that resolves to a Base64 data URL string.
 */
export async function toBase64(
  input: Resource, 
  mimeType?: string, 
  fallback?: string
): Promise<string> {
  if (typeof input === 'string') {
    if (input.startsWith('data:')) {
      return input;
    }[]
    if (input.startsWith('http://') || input.startsWith('https://')) {
      input = new URL(input);
    } else if (input.startsWith('file://')) {
      const filePath = url.fileURLToPath(input);
      input = fs.createReadStream(filePath);
    } else {
      return `data:${mimeType || 'text/plain'};base64,${Buffer.from(input).toString('base64')}`;
    }
  }

  if (hasUrl(input)) {
    input = new URL(input.url());
  }
  if (input instanceof URL) {
    input = await (await fetch(input)).blob();
  }

  if (typeof input !== 'object') {
    if (fallback !== undefined) {
      return fallback;
    }

    throw new Error('Invalid input type');
  }

  if (hasBlob(input)) {
    input = await input.blob();
  }
  if (hasRead(input)) {
    input = await input.read();
  }
  if ('type' in input && typeof input.type === 'string' && input.type.length > 0) {
    mimeType = input.type;
  }
  if ('mimeType' in input && typeof input.mimeType === 'string' && input.mimeType.length > 0) {
    mimeType = input.mimeType;
  }
  if (input instanceof Blob) {
    input = await input.arrayBuffer();
  }
  if (input instanceof DataView) {
    input = Buffer.from(input.buffer);
  }
  if (input instanceof ArrayBuffer) {
    input = Buffer.from(input);
  }
  if (isAsyncIterable(input)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of input) {
      chunks.push(chunk);
    }
    input = Buffer.concat(chunks);
  }
  
  const buffer = Buffer.isBuffer(input)
    ? input 
    : Buffer.from(input)
  const base64 = buffer.toString('base64');
  
  return `data:${mimeType || 'application/octet-stream'};base64,${base64}`;
}

/**
 * Converts the input resource to a text string. It assumes it points to resource
 * that is text or points to a text file.
 * 
 * @param input - The resource to convert.
 * @param fallback - Optional fallback string to return if conversion fails.
 * @returns - A promise that resolves to a text string.
 */
export async function toText(
  input: Resource,
  fallback: string = 'Unable to convert resource to text'
): Promise<string> {
  if (typeof input === 'string') {
    if (input.startsWith('data:')) {
      const commaIndex = input.indexOf(',');
      if (commaIndex >= 0) {
        const base64Part = input.substring(commaIndex + 1);
        const buffer = Buffer.from(base64Part, 'base64');
        return buffer.toString('utf-8');
      }
    }
    return input;
  }
  const stream = await toStream(input);
  if (!stream) {
    return fallback;
  }
  const decoded = new TextDecoder();
  let text = '';
  for await (const chunk of stream) {
    text += decoded.decode(chunk);
  }
  return text;
}

/**
 * Converts the input resource to an AsyncIterable stream of Uint8Array chunks.
 * 
 * @param input - The resource to convert.
 * @returns A promise that resolves to an AsyncIterable of Uint8Array chunks, or null if conversion fails.
 */
export async function toStream(input: Resource, fallback?: Readable): Promise<Readable> {
  if (typeof input === 'string') {
    if (input.startsWith('data:')) {
      const commaIndex = input.indexOf(',');
      if (commaIndex >= 0) {
        const base64Part = input.substring(commaIndex + 1);
        const buffer = Buffer.from(base64Part, 'base64');
        return Readable.from([buffer]);
      }
    }
    
    if (input.startsWith('http://') || input.startsWith('https://')) {
      input = new URL(input);
    } else if (input.startsWith('file://')) {
      const filePath = url.fileURLToPath(input);
      input = fs.createReadStream(filePath);
    } else {
      return Readable.from([Buffer.from(input, 'utf-8')]);
    }
  }  
  if (hasUrl(input)) {
    input = new URL(input.url());
  }
  if (input instanceof URL) {
    const response = await fetch(input);
    if (!response.ok) {
      if (fallback) {
        return fallback;
      }
      throw new Error(`Failed to fetch ${input}: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      if (fallback) {
        return fallback;
      }
      throw new Error(`No response body from ${input}`);
    }
    return Readable.from(response.body);
  }
  if (hasRead(input)) {
    input = await input.read();
  }
  if (hasBlob(input)) {
    input = await input.blob();
  }
  if (input instanceof Blob) {
    input = input.stream();
  }
  if (input instanceof DataView) {
    input = Buffer.from(input.buffer);
  }
  if (input instanceof ArrayBuffer) {
    input = Buffer.from(input);
  }
  return Readable.from(input);
}

/**
 * Converts the input resource to a ReadableStream.
 * 
 * @param input - The resource to convert.
 * @param fallback - Optional fallback ReadableStream to use if conversion fails.
 * @returns A promise that resolves to a ReadableStream.
 */
export async function toReadableStream(input: Resource, fallback?: ReadableStream): Promise<ReadableStream> {
  return ReadableStream.from(await toStream(input, fallback ? Readable.fromWeb(fallback) : undefined));
}

/**
 * Converts the input resource to a File.
 * 
 * @param input - The resource to convert.
 * @returns A promise that resolves to an AsyncIterable of Uint8Array chunks, or null if conversion fails.
 */
export async function toFile(input: Resource, mimeType?: string, filename?: string): Promise<File> {
  if (typeof input === 'string') {
    if (input.startsWith('data:')) {
      const [, type, base64Part] = input.substring(5).split(';base64,', 2);
      mimeType = type || mimeType;
      input = Buffer.from(base64Part, 'base64')
    } else if (input.startsWith('http://') || input.startsWith('https://')) {
      input = new URL(input);
    } else if (input.startsWith('file://')) {
      const filePath = url.fileURLToPath(input);
      input = await fs.openAsBlob(filePath);
      if (!filename) {
        filename = path.basename(filePath);
      }
      if (input.type && !mimeType) {
        mimeType = input.type;
      }
    } else {
      if (!mimeType) {
        mimeType = 'text/plain';
      }
      input = Buffer.from(input, 'utf-8');
    }
  }
  if (input instanceof File) {
    return input;
  }
  if (hasUrl(input)) {
    input = new URL(input.url());
  }
  if (input instanceof URL) {
    if (!filename) {
      filename = path.basename(input.pathname);
    }
    input = await fetch(input);
  }
  if (hasBlob(input)) {
    input = await input.blob();
  }
  if (hasRead(input)) {
    input = await input.read();
  }
  if (input instanceof ArrayBuffer) {
    input = new Blob([input]);
  }
  if (isAsyncIterable(input)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of input) {
      chunks.push(chunk);
    }
    input = new Blob(chunks);
  }
  return new File([input], filename || 'file', {
    type: mimeType || 'application/octet-stream',
  });
}
