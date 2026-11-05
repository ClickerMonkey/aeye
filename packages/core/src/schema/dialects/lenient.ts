import type { FormatDescriptor } from '../descriptor';

/** Lenient descriptor — no rewrites, no closure, formats pass through. Default for unsupported models. */
export const LENIENT: FormatDescriptor = Object.freeze({
  id: 'lenient',
  family: 'lenient',
  strict: false,
  objectAllFieldsRequired: false,
  objectClosedByDefault: false,
  recordEncoding: 'open-record',
  tupleEncoding: 'prefix-items',
  allowAllOf: true,
  allowAnyOf: true,
  allowOneOf: true,
  allowRootRef: true,
  allowDefsRef: true,
  emitPropertyOrdering: false,
  supportedStringFormats: 'all',
  allowPattern: true,
  allowMultiplePatterns: true,
  allowMinMaxLength: true,
  allowMinMaxItems: true,
  allowMinimumMaximum: true,
  optionalAsNullable: false,
  anyEncoding: 'recursive-open',
  supportsRecursion: true,
});
