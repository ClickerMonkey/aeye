/**
 * obj / record cases — the CUSTOM-TYPE + NESTED-SHAPE surface. Each case is a
 * natural-language `request` to generate a gin function `(args) => output`,
 * proven by `a.produces(oracle)` over several `inputs` (see `types.ts` for the
 * contract, `assert.ts` for the `a` builder, and `domain.ts` for the closest
 * model — `Customer` → `Address` nesting registered via `setup`).
 *
 * The category leans on genuinely complex obj shapes: nested objs (obj-in-obj),
 * a `list<CustomObj>`, and an obj with an `enum` field. Most cases register
 * per-case custom types via `setup(registry)` (returned so they surface in the
 * prompt's type docs) and the generated program traverses them through the
 * `args` path — e.g. `args.store.address.geo.lat`.
 *
 * Coverage (one trap each): read a field, read a NESTED field, CONSTRUCT a new
 * obj, MERGE two objs, PICK a subset, TRANSFORM one field, COMPUTE across an
 * obj's fields (over a list of objs), and a fns-with-DISTRACTORS selection.
 *
 * ORACLES read the raw `args` record (`Record<string, unknown>`). Each narrows
 * the one relevant slot to the concrete input interface it was authored with
 * (declared below) — a single localized, documented narrow per oracle, mirroring
 * `domain.ts`. No `any`, no value fabrication.
 */
import { a } from './assert';
import type { EvalCase, FnSpec } from './types';

// ════════════════════════════════════════════════════════════════════════════
// Input shape interfaces — the plain-JS shapes the `inputs` are authored with,
// used to narrow the relevant `args` slot inside each oracle without `any`.
// ════════════════════════════════════════════════════════════════════════════

/** A user record (obj-read-email). */
interface User {
  id: number;
  name: string;
  email: string;
}

/** A store nested two levels deep: Store → Address → GeoPoint (obj-nested-lat). */
interface Store {
  name: string;
  address: { city: string; geo: { lat: number; lng: number } };
}

/** The two disjoint source records merged into a Profile (obj-merge-profile). */
interface Personal {
  name: string;
  age: number;
}
interface Account {
  username: string;
  active: boolean;
}

/** The full employee record whose public subset is picked (obj-pick-public). */
interface Employee {
  id: number;
  name: string;
  salary: number;
  ssn: string;
  department: string;
}

/** A product whose price is transformed (obj-discount-product). */
interface Product {
  name: string;
  price: number;
  inStock: boolean;
}

/** An order line item, summed over in obj-order-total. */
interface LineItem {
  sku: string;
  price: number;
  qty: number;
}

/** A pay stub whose net take-home the payroll fn computes (obj-net-pay). */
interface PayStub {
  base: number;
  bonus: number;
  deductions: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Hidden constants — values the model cannot guess, encapsulated in a fn / trap.
// ════════════════════════════════════════════════════════════════════════════

/** Discount applied by obj-discount-product (stated in the request as "10% off"). */
const DISCOUNT = 0.1;

/**
 * The payroll withholding rate the intended `netPay` fn hides from the model in
 * obj-net-pay. Take-home = (base + bonus − deductions) × (1 − WITHHOLDING); it is
 * NOT stated in the request, so the fn is genuinely load-bearing.
 */
const WITHHOLDING = 0.22;

/** The three payroll fns: one solver (`netPay`) + two distractors. */
const payrollFns: FnSpec[] = [
  {
    name: 'netPay',
    args: { name: 'PayStub' },
    returns: { name: 'num' },
    impl: (args) =>
      (Number(args['base']) + Number(args['bonus']) - Number(args['deductions'])) * (1 - WITHHOLDING),
    docs: 'Net take-home pay for a stub, after payroll withholding (applies the withholding rate)',
    probe: { base: 1000, bonus: 200, deductions: 150 },
  },
  {
    name: 'grossPay',
    args: { name: 'PayStub' },
    returns: { name: 'num' },
    impl: (args) => Number(args['base']) + Number(args['bonus']),
    docs: 'Gross pay before any deductions or withholding (base + bonus)',
    distractor: true,
    probe: { base: 1000, bonus: 200, deductions: 150 },
  },
  {
    name: 'deductionTotal',
    args: { name: 'PayStub' },
    returns: { name: 'num' },
    impl: (args) => Number(args['deductions']),
    docs: 'The total deductions withheld from a stub',
    distractor: true,
    probe: { base: 1000, bonus: 200, deductions: 150 },
  },
];

export const objCases: EvalCase[] = [
  // ── read a field ──────────────────────────────────────────────────────────
  {
    id: 'obj-read-email',
    category: 'obj',
    request: "Return the user's email address.",
    note: 'Simplest field read on a custom type. Returning the name (also text) picks the wrong field; the varied inputs catch it.',
    setup: (registry) => {
      const UserType = registry.extend(
        registry.obj({
          id: { type: registry.num() },
          name: { type: registry.text() },
          email: { type: registry.text() },
        }),
        { name: 'User', docs: 'An application user account.' },
      );
      registry.register(UserType);
      return [UserType];
    },
    argsType: { name: 'obj', props: { user: { type: { name: 'User' } } } },
    returnType: { name: 'text' },
    inputs: [
      { user: { id: 1, name: 'Ada', email: 'ada@example.com' } },
      { user: { id: 2, name: 'Grace', email: 'grace@navy.mil' } },
      { user: { id: 3, name: 'Alan', email: 'alan@bletchley.uk' } },
    ],
    assert: [
      a.produces((args) => (args['user'] as User).email),
      a.returnsType('text'),
    ],
  },

  // ── read a NESTED field (obj-in-obj, two levels deep) ─────────────────────
  {
    id: 'obj-nested-lat',
    category: 'obj',
    request: "Return the latitude of the store's location.",
    note: 'Two-level nesting: Store → Address → GeoPoint. The model must traverse `store.address.geo.lat`. Returning `lng`, or a shallower field, fails on the varied coordinates.',
    setup: (registry) => {
      const GeoPoint = registry.extend(
        registry.obj({ lat: { type: registry.num() }, lng: { type: registry.num() } }),
        { name: 'GeoPoint', docs: 'A latitude/longitude coordinate.' },
      );
      registry.register(GeoPoint);
      const Address = registry.extend(
        registry.obj({ city: { type: registry.text() }, geo: { type: GeoPoint } }),
        { name: 'Address', docs: 'A postal address with a geocoded point.' },
      );
      registry.register(Address);
      const StoreType = registry.extend(
        registry.obj({ name: { type: registry.text() }, address: { type: Address } }),
        { name: 'Store', docs: 'A retail store located at an address.' },
      );
      registry.register(StoreType);
      return [GeoPoint, Address, StoreType];
    },
    argsType: { name: 'obj', props: { store: { type: { name: 'Store' } } } },
    returnType: { name: 'num' },
    inputs: [
      { store: { name: 'Downtown', address: { city: 'Denver', geo: { lat: 39.7392, lng: -104.9903 } } } },
      { store: { name: 'Harbor', address: { city: 'Boston', geo: { lat: 42.3601, lng: -71.0589 } } } },
      { store: { name: 'Bayview', address: { city: 'Austin', geo: { lat: 30.2672, lng: -97.7431 } } } },
    ],
    assert: [
      a.produces((args) => (args['store'] as Store).address.geo.lat),
      a.returnsType('num'),
    ],
  },

  // ── CONSTRUCT a new obj from inputs (with a derived field) ────────────────
  {
    id: 'obj-build-person',
    category: 'obj',
    request:
      "Given a first and last name, build a Person record whose `full` field is the first and last name joined by a single space.",
    note: 'Constructs a NEW custom obj from two scalar inputs and derives the `full` field. Copying a name into the wrong slot, or omitting the space in `full`, fails the deep-equal oracle.',
    setup: (registry) => {
      const Person = registry.extend(
        registry.obj({
          first: { type: registry.text() },
          last: { type: registry.text() },
          full: { type: registry.text() },
        }),
        { name: 'Person', docs: 'A person with first, last, and a derived full name.' },
      );
      registry.register(Person);
      return [Person];
    },
    argsType: { name: 'obj', props: { first: { type: { name: 'text' } }, last: { type: { name: 'text' } } } },
    returnType: { name: 'Person' },
    inputs: [
      { first: 'Ada', last: 'Lovelace' },
      { first: 'Grace', last: 'Hopper' },
      { first: 'Alan', last: 'Turing' },
    ],
    assert: [
      a.produces((args) => {
        const first = String(args['first']);
        const last = String(args['last']);
        return { first, last, full: `${first} ${last}` };
      }),
      a.usesKind('new'),
    ],
  },

  // ── MERGE two objs (disjoint fields → one combined record) ────────────────
  {
    id: 'obj-merge-profile',
    category: 'obj',
    request:
      'Combine the personal record and the account record into a single Profile that carries every field from both.',
    note: 'Merges two DISJOINT source objs into one. Dropping either source, or nesting one inside the result instead of flattening it, fails the deep-equal oracle.',
    setup: (registry) => {
      const PersonalType = registry.extend(
        registry.obj({ name: { type: registry.text() }, age: { type: registry.num() } }),
        { name: 'Personal', docs: 'Personal details.' },
      );
      registry.register(PersonalType);
      const AccountType = registry.extend(
        registry.obj({ username: { type: registry.text() }, active: { type: registry.bool() } }),
        { name: 'Account', docs: 'Login account details.' },
      );
      registry.register(AccountType);
      const Profile = registry.extend(
        registry.obj({
          name: { type: registry.text() },
          age: { type: registry.num() },
          username: { type: registry.text() },
          active: { type: registry.bool() },
        }),
        { name: 'Profile', docs: 'A profile combining personal and account details.' },
      );
      registry.register(Profile);
      return [PersonalType, AccountType, Profile];
    },
    argsType: {
      name: 'obj',
      props: { personal: { type: { name: 'Personal' } }, account: { type: { name: 'Account' } } },
    },
    returnType: { name: 'Profile' },
    inputs: [
      { personal: { name: 'Ada', age: 36 }, account: { username: 'ada', active: true } },
      { personal: { name: 'Grace', age: 85 }, account: { username: 'grace', active: false } },
      { personal: { name: 'Alan', age: 41 }, account: { username: 'alan', active: true } },
    ],
    assert: [
      a.produces((args) => {
        const p = args['personal'] as Personal;
        const acct = args['account'] as Account;
        return { name: p.name, age: p.age, username: acct.username, active: acct.active };
      }),
    ],
  },

  // ── PICK a subset (drop sensitive fields) ─────────────────────────────────
  {
    id: 'obj-pick-public',
    category: 'obj',
    request:
      "Return a public view of the employee containing only their name and department — nothing else.",
    note: 'Selects a SUBSET of fields. Leaking `salary`/`ssn`/`id`, or returning the whole record, fails the exact-shape oracle (the deep-equal compares the union of keys).',
    setup: (registry) => {
      const EmployeeType = registry.extend(
        registry.obj({
          id: { type: registry.num() },
          name: { type: registry.text() },
          salary: { type: registry.num() },
          ssn: { type: registry.text() },
          department: { type: registry.text() },
        }),
        { name: 'Employee', docs: 'A full employee record (includes sensitive fields).' },
      );
      registry.register(EmployeeType);
      const PublicEmployee = registry.extend(
        registry.obj({ name: { type: registry.text() }, department: { type: registry.text() } }),
        { name: 'PublicEmployee', docs: 'The non-sensitive public view of an employee.' },
      );
      registry.register(PublicEmployee);
      return [EmployeeType, PublicEmployee];
    },
    argsType: { name: 'obj', props: { employee: { type: { name: 'Employee' } } } },
    returnType: { name: 'PublicEmployee' },
    inputs: [
      { employee: { id: 1, name: 'Ada', salary: 120000, ssn: '111-11-1111', department: 'R&D' } },
      { employee: { id: 2, name: 'Grace', salary: 130000, ssn: '222-22-2222', department: 'Navy' } },
      { employee: { id: 3, name: 'Alan', salary: 110000, ssn: '333-33-3333', department: 'Crypto' } },
    ],
    assert: [
      a.produces((args) => {
        const e = args['employee'] as Employee;
        return { name: e.name, department: e.department };
      }),
    ],
  },

  // ── TRANSFORM one field (copy obj, change price) ──────────────────────────
  {
    id: 'obj-discount-product',
    category: 'obj',
    request:
      "Apply a 10% discount to the product's price and return the product with every other field unchanged.",
    note: 'Transforms ONE field while preserving the rest. Returning just the new price (a num), or mutating the wrong field, fails; the oracle keeps `name`/`inStock` and only scales `price`.',
    setup: (registry) => {
      const ProductType = registry.extend(
        registry.obj({
          name: { type: registry.text() },
          price: { type: registry.num() },
          inStock: { type: registry.bool() },
        }),
        { name: 'Product', docs: 'A catalog product.' },
      );
      registry.register(ProductType);
      return [ProductType];
    },
    argsType: { name: 'obj', props: { product: { type: { name: 'Product' } } } },
    returnType: { name: 'Product' },
    inputs: [
      { product: { name: 'Widget', price: 100, inStock: true } },
      { product: { name: 'Gadget', price: 49.9, inStock: false } },
      { product: { name: 'Gizmo', price: 0, inStock: true } },
    ],
    assert: [
      a.produces((args) => {
        const p = args['product'] as Product;
        return { name: p.name, price: p.price * (1 - DISCOUNT), inStock: p.inStock };
      }),
    ],
  },

  // ── COMPUTE across fields, over a list<CustomObj> with 2-level nesting ─────
  {
    id: 'obj-order-total',
    category: 'obj',
    request:
      'Return the order total: the sum over every line item of its price multiplied by its quantity.',
    note: 'Compute across an obj whose `items` is a list<LineItem> and whose `customer` carries an enum `tier` (a two-level nested, list-bearing shape). Summing only price (ignoring qty), or counting items, fails on the varied quantities.',
    setup: (registry) => {
      const LineItemType = registry.extend(
        registry.obj({
          sku: { type: registry.text() },
          price: { type: registry.num() },
          qty: { type: registry.num() },
        }),
        { name: 'LineItem', docs: 'One line of an order.' },
      );
      registry.register(LineItemType);
      const Customer = registry.extend(
        registry.obj({
          name: { type: registry.text() },
          tier: { type: registry.enum({ BRONZE: 'bronze', SILVER: 'silver', GOLD: 'gold' }, registry.text()) },
        }),
        { name: 'Customer', docs: 'The ordering customer, with a loyalty tier.' },
      );
      registry.register(Customer);
      const Order = registry.extend(
        registry.obj({
          id: { type: registry.text() },
          customer: { type: Customer },
          items: { type: registry.list(LineItemType) },
        }),
        { name: 'Order', docs: 'A customer order with a list of line items.' },
      );
      registry.register(Order);
      return [LineItemType, Customer, Order];
    },
    argsType: { name: 'obj', props: { order: { type: { name: 'Order' } } } },
    returnType: { name: 'num' },
    inputs: [
      {
        order: {
          id: 'A1',
          customer: { name: 'Ada', tier: 'gold' },
          items: [
            { sku: 'x', price: 10, qty: 2 },
            { sku: 'y', price: 5, qty: 3 },
          ],
        },
      },
      {
        order: {
          id: 'B2',
          customer: { name: 'Grace', tier: 'silver' },
          items: [{ sku: 'z', price: 100, qty: 1 }],
        },
      },
      {
        order: {
          id: 'C3',
          customer: { name: 'Alan', tier: 'bronze' },
          items: [],
        },
      },
    ],
    assert: [
      a.produces((args) => {
        const items = (args['order'] as { items: readonly LineItem[] }).items;
        return items.reduce((sum, it) => sum + it.price * it.qty, 0);
      }),
      a.returnsType('num'),
    ],
  },

  // ── fns-with-DISTRACTORS (derive a field via the right tool) ───────────────
  {
    id: 'obj-net-pay',
    category: 'obj',
    request:
      "Given a pay stub, return the employee's net take-home pay after withholding. Use the provided payroll function — the withholding rate is not something you should assume.",
    note: 'Distractor gauntlet over an obj: only `netPay` knows the withholding rate. Calling `grossPay` (ignores withholding + deductions) or `deductionTotal` yields the wrong number, and inlining a guessed rate cannot match. `usesFn(netPay)` is a required gate.',
    fns: payrollFns,
    argsType: { name: 'obj', props: { emp: { type: { name: 'PayStub' } } } },
    returnType: { name: 'num' },
    setup: (registry) => {
      const PayStubType = registry.extend(
        registry.obj({
          base: { type: registry.num() },
          bonus: { type: registry.num() },
          deductions: { type: registry.num() },
        }),
        { name: 'PayStub', docs: 'An employee pay stub.' },
      );
      registry.register(PayStubType);
      return [PayStubType];
    },
    inputs: [
      { emp: { base: 1000, bonus: 200, deductions: 150 } },
      { emp: { base: 5000, bonus: 0, deductions: 800 } },
      { emp: { base: 2500, bonus: 500, deductions: 0 } },
    ],
    assert: [
      // The rate is hidden in the fn, so calling it is genuinely mandatory.
      a.require(a.usesFn('netPay')),
      a.produces((args) => {
        const e = args['emp'] as PayStub;
        return (e.base + e.bonus - e.deductions) * (1 - WITHHOLDING);
      }),
    ],
  },
];
