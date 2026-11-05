/**
 * Model selection follows the output's schema delivery: structured output
 * needs `structured`, JSON mode needs `json`, and a schema in the prompt
 * needs neither.
 */

import { z } from 'zod';
import type { Request, SchemaDelivery } from '@aeye/core';
import { AI } from '../ai';
import { ChatAPI } from '../apis/chat';
import type { AIBaseTypes, ModelCapability } from '../types';

class Capabilities<T extends AIBaseTypes> extends ChatAPI<T> {
  of(request: Request) {
    return this.getRequiredCapabilities([], request, false);
  }
}

const capabilities = new Capabilities(AI.with().providers({}).create({}));

function request(schemaDelivery: SchemaDelivery): Request {
  return { messages: [], responseFormat: { type: z.object({ value: z.number() }), strict: 1, schemaDelivery } };
}

describe('chat output capabilities', () => {
  it.each<[SchemaDelivery, ModelCapability]>([
    ['structured', 'structured'],
    ['auto', 'structured'],
    ['json', 'json'],
  ])("a '%s' schema needs %s", (delivery, capability) => {
    expect(capabilities.of(request(delivery))).toContain(capability);
  });

  it('a schema in the prompt needs neither', () => {
    const needed = capabilities.of(request('prompt'));
    expect(needed).not.toContain('structured');
    expect(needed).not.toContain('json');
  });
});
