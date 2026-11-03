import { test } from '@playwright/test';

// Contracts the specs already describe but not every adapter has released. Their
// cases are skipped unless the run opts in, so an adapter that tracks this harness
// at its default branch is not failed by a case it has not shipped yet. An adapter
// opts in once it ships the contract, by setting SEAMLESS_VERIFY_CONTRACTS (a comma
// list of names, or `all`). Move a contract out of this list once every adapter has
// released it, which makes its cases run for everyone.
export const PENDING_CONTRACTS = {
  // A body-less unsafe auth request needs a JSON content type or the transport
  // header, or it is refused with 415.
  'content-type-gate': 'fells-code/seamless-auth-api#558',
} as const;

export type PendingContract = keyof typeof PENDING_CONTRACTS;

function optedIn(): Set<string> {
  return new Set(
    (process.env.SEAMLESS_VERIFY_CONTRACTS ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

/** Skips the calling test unless the run opted into `contract`. */
export function requireContract(contract: PendingContract): void {
  const names = optedIn();
  test.skip(
    !names.has('all') && !names.has(contract),
    `${contract} is pending (${PENDING_CONTRACTS[contract]}); set SEAMLESS_VERIFY_CONTRACTS=${contract} to hold this adapter to it`,
  );
}
