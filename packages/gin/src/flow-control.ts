import type { Value } from './value';

/**
 * Non-local control flow signals — thrown by Flow expressions, caught by
 * the nearest matching frame (loops, lambdas, the engine root).
 */
export class FlowSignal {
  constructor(readonly action: 'break' | 'continue' | 'return' | 'exit' | 'throw') {}
}

export class BreakSignal extends FlowSignal {
  constructor() { super('break'); }
}

export class ContinueSignal extends FlowSignal {
  constructor() { super('continue'); }
}

export class ReturnSignal extends FlowSignal {
  constructor(readonly value?: Value) { super('return'); }
}

export class ExitSignal extends FlowSignal {
  constructor(readonly value?: Value) { super('exit'); }
}

export class ThrowSignal extends FlowSignal {
  constructor(readonly error: Value) { super('throw'); }
}
