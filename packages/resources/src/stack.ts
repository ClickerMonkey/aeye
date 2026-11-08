/**
 * Ordered stacks of handlers per resource type, shared by parsers and converters: each type keeps its handlers from
 * highest priority to lowest (ties to the most recently registered), and a run tries them in that order until one
 * gives a result, falling back past those that decline or throw.
 */
import type { ResourceType } from "./types.js";
import { assertNotAborted, isAbortError } from "./utils.js";

/** Something that can sit in a {@link TypeStack}. */
export interface StackMember {
  readonly id: string;
  readonly supportedTypes: readonly ResourceType[];
  readonly priority?: number;
}

interface StackEntry {
  readonly id: string;
  readonly priority: number;
  readonly order: number;
}

/** Handlers by id, and each type's handlers in the order they are tried. */
export class TypeStack<T extends StackMember> {
  private readonly members = new Map<string, T>();
  private readonly types = new Map<ResourceType, StackEntry[]>();
  private order = 0;

  /** Adds a handler (replacing one with its id) at the given priority, else its own, else 0. Returns the types it joined. */
  register(member: T, priority: number = member.priority ?? 0): readonly ResourceType[] {
    this.members.set(member.id, member);
    for (const type of member.supportedTypes) {
      const entries = (this.types.get(type) ?? []).filter((entry) => entry.id !== member.id);
      entries.push({ id: member.id, priority, order: this.order++ });
      entries.sort((a, b) => b.priority - a.priority || b.order - a.order);
      this.types.set(type, entries);
    }
    return member.supportedTypes;
  }

  /** A type's handlers, first tried first. */
  get(type: ResourceType): T[] {
    return (this.types.get(type) ?? []).flatMap((entry) => {
      const member = this.members.get(entry.id);
      return member ? [member] : [];
    });
  }

  /** True when a type has at least one handler. */
  has(type: ResourceType): boolean {
    return (this.types.get(type)?.length ?? 0) > 0;
  }
}

/** How a stack run ended. */
export type StackOutcome<R> =
  | { readonly status: "done"; readonly result: R }
  | { readonly status: "declined" }
  | { readonly status: "failed"; readonly error: unknown };

/**
 * Tries handlers in order until one gives a result. A handler that returns undefined declines and one that throws
 * falls back to the next; an abort is never swallowed. When none gives a result it is `failed` if any threw (with that
 * error, or an AggregateError of all of them), else `declined`.
 */
export async function runStack<T, R>(
  members: readonly T[],
  attempt: (member: T) => Promise<R | undefined>,
  signal: AbortSignal | undefined,
  what: string,
): Promise<StackOutcome<R>> {
  const errors: unknown[] = [];
  for (const member of members) {
    assertNotAborted(signal);
    try {
      const result = await attempt(member);
      if (result !== undefined) return { status: "done", result };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      errors.push(error);
    }
  }
  if (errors.length === 1) return { status: "failed", error: errors[0] };
  if (errors.length > 1) return { status: "failed", error: new AggregateError(errors, `All ${errors.length} ${what} failed`) };
  return { status: "declined" };
}
