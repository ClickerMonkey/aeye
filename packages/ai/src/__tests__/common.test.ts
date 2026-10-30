/**
 * AI Common Helper Tests
 */

import { clampReasoningEffort } from '../common';

describe('clampReasoningEffort', () => {
  it('keeps an accepted effort', () => {
    expect(clampReasoningEffort('high', ['low', 'medium', 'high'])).toBe('high');
  });

  it('keeps any effort when acceptance is unknown', () => {
    expect(clampReasoningEffort('max')).toBe('max');
    expect(clampReasoningEffort('max', [])).toBe('max');
  });

  it('moves to the nearest accepted effort', () => {
    expect(clampReasoningEffort('max', ['low', 'medium', 'high'])).toBe('high');
    expect(clampReasoningEffort('none', ['low', 'medium', 'high'])).toBe('low');
  });

  it('prefers the lower effort on a tie', () => {
    expect(clampReasoningEffort('medium', ['low', 'high'])).toBe('low');
  });
});
