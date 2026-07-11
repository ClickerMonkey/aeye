/**
 * DOMAIN cases — a per-case CUSTOM type in the args (registered via `setup`), and
 * a REFUSAL case (an impossible request the model should decline).
 *
 * The custom-type case nests one registered obj type inside another
 * (`Customer` has an `Address`), exercising the "complex custom types" surface:
 * the generated program must traverse `args.customer.address.city`.
 */
import { a } from './assert';
import type { EvalCase } from './types';

export const domainCases: EvalCase[] = [
  {
    id: 'domain-vip-city',
    category: 'domain',
    request:
      "Return the customer's city, but only when the customer is a VIP. For a non-VIP, return the string 'N/A'.",
    note: 'Nested custom types (Customer → Address) plus a conditional. Returning the city unconditionally leaks a non-VIP city; returning the name or street picks the wrong field.',
    setup: (registry) => {
      // Build custom obj types by extending a STRUCTURAL `obj({...})` base (which
      // carries the fields), NOT `extend('obj', {props})` — the latter delegates
      // `parse` to the empty base and silently DROPS every field at runtime.
      const Address = registry.extend(
        registry.obj({ street: { type: registry.text() }, city: { type: registry.text() } }),
        { name: 'Address', docs: 'A postal address.' },
      );
      registry.register(Address);
      const Customer = registry.extend(
        registry.obj({
          name: { type: registry.text() },
          vip: { type: registry.bool() },
          address: { type: Address },
        }),
        { name: 'Customer', docs: 'A customer account with an address.' },
      );
      registry.register(Customer);
      return [Address, Customer];
    },
    argsType: { name: 'obj', props: { customer: { type: { name: 'Customer' } } } },
    returnType: { name: 'text' },
    inputs: [
      { customer: { name: 'Acme', vip: true, address: { street: '1 Main', city: 'Denver' } } },
      { customer: { name: 'Globex', vip: false, address: { street: '2 Oak', city: 'Austin' } } },
      { customer: { name: 'Initech', vip: true, address: { street: '3 Elm', city: 'Boston' } } },
    ],
    assert: [
      a.produces((args) => {
        const c = (args['customer'] ?? {}) as { vip: boolean; address: { city: string } };
        return c.vip ? c.address.city : 'N/A';
      }),
      a.returnsType('text'),
    ],
  },
  {
    id: 'domain-refuse-missing-data',
    category: 'domain',
    request: "Return the customer's current account balance in dollars.",
    note: 'Impossible: the only parameter is a numeric `subtotal` — there is no customer or balance anywhere in scope, and no fn provides one. The correct behavior is to decline rather than fabricate a value.',
    argsType: { name: 'obj', props: { subtotal: { type: { name: 'num' } } } },
    returnType: { name: 'num' },
    inputs: [{ subtotal: 10 }, { subtotal: 20 }],
    assert: [
      // The illegal sample reads a `customer` variable that does not exist in
      // scope — `engine.validate` must reject it (proven by the `--check` gate).
      a.refused(() => ({ kind: 'get', path: [{ prop: 'customer' }, { prop: 'balance' }] })),
    ],
  },
];
