/**
 * Chat Capability Inference Tests
 *
 * The chat API derives selection criteria from the shape of a request.
 */

import { ChatAPI } from '../apis/chat';
import { AI } from '../ai';
import type { AIBaseTypes, ModelCapability, ModelParameter, Request } from '../types';
import { createMockProvider } from './mocks/provider.mock';

class ProbeChatAPI<T extends AIBaseTypes> extends ChatAPI<T> {
  required(request: Request): ModelCapability[] {
    return this.getRequiredCapabilities([], request, false);
  }
  optional(request: Request): ModelCapability[] {
    return this.getOptionalCapabilities([], request, false);
  }
  optionalParameters(request: Request): ModelParameter[] {
    return this.getOptionalParameters([], request, false);
  }
}

const probe = new ProbeChatAPI(AI.with().providers({ mock: createMockProvider() }).create({}));

describe('ChatAPI capability inference', () => {
  it('requires the capability for each input content type', () => {
    const required = probe.required({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', content: 'Describe these' },
          { type: 'image', content: 'https://example.com/a.png' },
          { type: 'audio', content: 'https://example.com/a.mp3' },
          { type: 'video', content: 'https://example.com/a.mp4' },
        ],
      }],
    });

    expect(required).toEqual(expect.arrayContaining(['chat', 'vision', 'hearing', 'videoInput']));
  });

  it('only prefers file support', () => {
    const request: Request = { messages: [{ role: 'user', content: [{ type: 'file', content: 'https://example.com/a.pdf' }] }] };

    expect(probe.required(request)).not.toContain('files');
    expect(probe.optional(request)).toContain('files');
  });

  it('requires the capability for each output modality', () => {
    const required = probe.required({ messages: [], modalities: ['text', 'image', 'audio'] });

    expect(required).toEqual(expect.arrayContaining(['image', 'audio']));
  });

  it('prefers models that take the newer sampling parameters', () => {
    const params = probe.optionalParameters({ messages: [], seed: 7, verbosity: 'low', serviceTier: 'flex' });

    expect(params).toEqual(expect.arrayContaining(['seed', 'verbosity', 'serviceTier']));
  });
});
