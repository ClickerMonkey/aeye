/**
 * Resource Conversion Tests
 */

import { toFile } from '../to';

describe('toFile', () => {
  it('decodes a data URL with its mime type', async () => {
    const file = await toFile('data:audio/wav;base64,UklGRg==');

    expect(file.type).toBe('audio/wav');
    expect(Buffer.from(await file.arrayBuffer()).toString('latin1')).toBe('RIFF');
  });
});
