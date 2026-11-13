import { describe, test, expect } from 'vitest';
import { createRegistry, createEngine, RunStoppedError, type ExprDef } from '../index';

const endless = (over: ExprDef): ExprDef => ({ kind: 'loop', over, body: { kind: 'block', lines: [] } });

describe('Engine.run options', () => {
  test('a deadline stops a loop over a huge num, and timers keep firing', async () => {
    const e = createEngine(createRegistry());
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    const run = e.run(endless({ kind: 'new', type: { name: 'num' }, value: 1e12 }), undefined, { signal: AbortSignal.timeout(60) });
    await expect(run).rejects.toThrow();
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });

  test('aborting stops a while-loop with the signal\'s reason', async () => {
    const e = createEngine(createRegistry());
    const controller = new AbortController();
    setTimeout(() => { controller.abort(new Error('cancelled')); }, 20);
    await expect(e.run(endless({ kind: 'new', type: { name: 'bool' }, value: true }), undefined, { signal: controller.signal })).rejects.toThrow('cancelled');
  });

  test('an already-aborted run never starts', async () => {
    const e = createEngine(createRegistry());
    const controller = new AbortController();
    controller.abort('stop');
    await expect(e.run({ kind: 'new', type: { name: 'num' }, value: 1 }, undefined, { signal: controller.signal })).rejects.toBeInstanceOf(RunStoppedError);
  });

  test('a run that finishes is unaffected', async () => {
    const e = createEngine(createRegistry());
    const out = await e.run(endless({ kind: 'new', type: { name: 'num' }, value: 1000 }), undefined, { signal: AbortSignal.timeout(5000) });
    expect(out.raw).toBeUndefined();
  });
});
