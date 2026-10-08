// Shared config + helpers for the conformance harness.

import { randomInt, randomUUID } from 'crypto';

export const API_URL = process.env.SEAMLESS_API_URL ?? 'http://localhost:5312';
export const ADAPTER_URL = process.env.SEAMLESS_ADAPTER_URL ?? 'http://localhost:3000';
// The Fastify twin of the adapter, on its own port. The adapter specs run against
// both, so a regression in one framework is visible on its own row of the matrix.
export const FASTIFY_ADAPTER_URL =
  process.env.SEAMLESS_FASTIFY_ADAPTER_URL ?? 'http://localhost:3001';
// A reference app outside this repository (`seamless verify --adapter-url`), run
// against the same adapter specs as the in-repo Express and Fastify apps.
export const CONFORMANCE_ADAPTER_URL =
  process.env.SEAMLESS_CONFORMANCE_ADAPTER_URL ?? ADAPTER_URL;
export const REACT_URL = process.env.SEAMLESS_REACT_URL ?? 'http://localhost:5173';
export const MOCK_OIDC_PORT = Number(process.env.SEAMLESS_MOCK_OIDC_PORT ?? 9000);

// Must match the API's API_SERVICE_TOKEN so the harness can mint M2M tokens.
export const API_SERVICE_TOKEN =
  process.env.SEAMLESS_API_SERVICE_TOKEN ?? 'verify-dev-service-token';

// Must match the API's OWNER_EMAIL so the harness can assert that registering
// the tenant owner grants the admin role at signup.
export const OWNER_EMAIL = process.env.SEAMLESS_OWNER_EMAIL ?? 'owner@verify.local';

// Non-production seam: makes the API return OTP / magic-link tokens in the
// response `delivery` object instead of sending real email/SMS.
export const EXTERNAL_DELIVERY = {
  'x-seamless-auth-delivery-mode': 'external',
} as const;

const runId = process.env.SEAMLESS_RUN_ID ?? String(Date.now());

// A random suffix (not just a module-level counter) keeps emails unique even
// though Playwright re-evaluates this module per spec file, which resets the
// counter — duplicate emails otherwise collide on the API's per-email OTP limit.
export function uniqueEmail(prefix = 'verify'): string {
  return `${prefix}.${runId}.${randomUUID().slice(0, 8)}@example.test`;
}

// Distinct client IP per actor so the API's per-IP rate limiters see separate
// buckets (honored only alongside a valid service token — see client.ts).
// Random (not a module-level counter) to survive per-file module re-evaluation.
export function uniqueClientIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

// Valid-format US numbers (415 area, 7-digit subscriber). Random so they stay
// unique across runs and across per-file module resets without a shared counter.
export function uniquePhone(): string {
  return `+1415${2_000_000 + randomInt(7_000_000)}`;
}
