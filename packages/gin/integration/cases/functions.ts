/**
 * FUNCTION-SELECTION cases — the case exposes several callable `fns`, only ONE of
 * which solves the request; the rest are DISTRACTORS. The intended function
 * encapsulates a value the model CANNOT guess (e.g. a specific tax rate), so it
 * is genuinely load-bearing: `a.usesFn` gates on picking the right tool, and
 * `a.produces` confirms the numbers only line up when it was called.
 */
import { a } from './assert';
import type { EvalCase, FnSpec } from './types';

/** The sales-tax rate the intended `applyTax` function hides from the model. */
const TAX_RATE = 0.0825;

/** amount → the single argument every fn in this case takes. */
const AMOUNT_ARG = { name: 'obj', props: { amount: { type: { name: 'num' } } } } as const;

/** The four functions: one solver (`applyTax`) + three distractors. */
const taxFns: FnSpec[] = [
  {
    name: 'applyTax',
    args: AMOUNT_ARG,
    returns: { name: 'num' },
    impl: (args) => Number(args['amount']) * TAX_RATE,
    docs: 'Return the sales tax owed on an amount (applies the jurisdiction tax rate)',
    probe: { amount: 100 },
  },
  {
    name: 'applyDiscount',
    args: AMOUNT_ARG,
    returns: { name: 'num' },
    impl: (args) => Number(args['amount']) * 0.9,
    docs: 'Apply a 10% discount to an amount',
    distractor: true,
    probe: { amount: 100 },
  },
  {
    name: 'roundCents',
    args: AMOUNT_ARG,
    returns: { name: 'num' },
    impl: (args) => Math.round(Number(args['amount']) * 100) / 100,
    docs: 'Round an amount to whole cents',
    distractor: true,
    probe: { amount: 1.239 },
  },
  {
    name: 'addShipping',
    args: AMOUNT_ARG,
    returns: { name: 'num' },
    impl: (args) => Number(args['amount']) + 5,
    docs: 'Add a flat $5 shipping fee to an amount',
    distractor: true,
    probe: { amount: 20 },
  },
];

export const functionCases: EvalCase[] = [
  {
    id: 'fn-sales-tax',
    category: 'functions',
    request:
      'Given an order subtotal, return the sales tax owed on it. Use the provided tax function — the rate is not something you should assume.',
    note: 'Distractor gauntlet: only `applyTax` knows the rate. Inlining a guessed rate, or calling applyDiscount / roundCents / addShipping, produces the wrong number. `usesFn(applyTax)` is a required gate because the rate is unknowable otherwise.',
    fns: taxFns,
    argsType: { name: 'obj', props: { subtotal: { type: { name: 'num' } } } },
    returnType: { name: 'num' },
    inputs: [{ subtotal: 100 }, { subtotal: 250.5 }, { subtotal: 0 }],
    assert: [
      // The rate is hidden in the fn, so calling it is genuinely mandatory.
      a.require(a.usesFn('applyTax')),
      a.produces((args) => Number(args['subtotal']) * TAX_RATE),
    ],
  },
];
