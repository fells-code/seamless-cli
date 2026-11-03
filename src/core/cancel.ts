import { isCancel } from "@clack/prompts";

// Raised when a developer interrupts a prompt (Ctrl-C) or declines a
// confirmation. Callers let it propagate: init unwinds anything it created and
// the top level reports it as a cancellation rather than a failure.
export class CancelledError extends Error {
  constructor(message = "Cancelled.") {
    super(message);
    this.name = "CancelledError";
  }
}

// Matches on the name as well as the prototype. A CLI that is bundled, linked,
// or loaded through more than one module instance can raise an error that is
// structurally this class without sharing its identity, and a missed match here
// would report a plain Ctrl-C as a crash.
export function isCancelled(err: unknown): boolean {
  if (err instanceof CancelledError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "CancelledError"
  );
}

// Clack answers an interrupted prompt with a symbol rather than rejecting.
// Casting that result to its value type (the pattern this replaces) turned the
// symbol into a TypeError somewhere further down, which surfaced as a crash
// mid-scaffold instead of a clean exit. Every prompt result goes through here.
// Clack 1.8 types the cancel value as a `unique symbol`, which TypeScript infers
// into `T` itself, so the symbol is excluded from the result type explicitly.
export function orCancel<T>(value: T | symbol): Exclude<T, symbol> {
  if (isCancel(value)) {
    throw new CancelledError();
  }
  return value as Exclude<T, symbol>;
}
