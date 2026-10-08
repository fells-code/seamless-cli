import { request as playwrightRequest } from '@playwright/test';

import {
  ADAPTER_URL,
  API_URL,
  CONFORMANCE_ADAPTER_URL,
  FASTIFY_ADAPTER_URL,
  MOCK_OIDC_PORT,
  REACT_URL,
} from './lib/env';
import { startMockOidc } from './mock-oidc';

async function waitForHealth(url: string, name: string, timeoutMs = 120_000): Promise<void> {
  const ctx = await playwrightRequest.newContext();
  const start = Date.now();
  let lastError = '';
  try {
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await ctx.get(url);
        if (res.ok()) {
          // eslint-disable-next-line no-console
          console.log(`✔ ${name} healthy (${url})`);
          return;
        }
        lastError = `status ${res.status()}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    await ctx.dispose();
  }
  throw new Error(`✖ ${name} not healthy at ${url} within ${timeoutMs}ms (last: ${lastError})`);
}

export default async function globalSetup(): Promise<void> {
  // In-process mock OIDC provider for the OAuth flow (the API reaches it via
  // host.docker.internal; the harness drives /authorize via localhost).
  startMockOidc(MOCK_OIDC_PORT);
  // eslint-disable-next-line no-console
  console.log(`✔ mock OIDC listening (:${MOCK_OIDC_PORT})`);

  await waitForHealth(`${API_URL}/health/status`, 'auth-api');
  if (process.env.SEAMLESS_VERIFY_ADAPTER === '1') {
    await waitForHealth(`${ADAPTER_URL}/`, 'adapter');
  }
  if (process.env.SEAMLESS_VERIFY_ADAPTER_FASTIFY === '1') {
    await waitForHealth(`${FASTIFY_ADAPTER_URL}/`, 'adapter-fastify');
  }
  if (process.env.SEAMLESS_VERIFY_CONFORMANCE === '1') {
    await waitForHealth(`${CONFORMANCE_ADAPTER_URL}/`, 'reference app');
  }
  if (process.env.SEAMLESS_VERIFY_REACT === '1') {
    await waitForHealth(`${REACT_URL}/health`, 'react');
  }
}
