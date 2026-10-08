import { defineConfig, devices } from '@playwright/test';

import { CONFORMANCE_ADAPTER_URL, FASTIFY_ADAPTER_URL, REACT_URL } from './lib/env';
import type { AdapterOptions } from './lib/fixtures';

// Every service is published by Docker on IPv4. A host process listening on
// [::1] at the same port (a developer's own `vite` on 5173, say) would otherwise
// win the browser's lookup for `localhost`, and the suite would drive the wrong
// app. The page origin has to stay `localhost` (it is the passkey RP ID and the
// allowed origin), so the browser resolves the name to 127.0.0.1 instead.
const browser = {
  ...devices['Desktop Chrome'],
  launchOptions: { args: ['--host-resolver-rules=MAP localhost 127.0.0.1'] },
};

// One runner, multiple projects. `api` and `adapter` hit HTTP directly (no
// browser); `react` drives chromium against the starter SPA. global-setup
// health-gates the stack before any project runs.
export default defineConfig<AdapterOptions>({
  testDir: '.',
  globalSetup: './global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ['list'],
    ['./lib/matrixReporter.ts'],
    ['junit', { outputFile: 'results/junit.xml' }],
    ['html', { outputFolder: 'results/html', open: 'never' }],
  ],
  // Each project scopes itself with testDir, not testMatch. A testMatch regex is
  // applied to the absolute path, so `/api\/.*\.spec\.ts$/` also matched every
  // adapter and react spec whenever the checkout lived under a directory
  // containing "api/" (the seamless-auth-api conformance run does exactly that),
  // pulling browser specs into a project with no baseURL.
  projects: [
    { name: 'api', testDir: './api' },
    // Both adapter projects run the same specs from the same directory; only the
    // adopter backend they point at differs. Adding a framework is a project
    // entry plus a compose service, not a copy of the suite.
    { name: 'adapter', testDir: './adapter' },
    {
      name: 'adapter-fastify',
      testDir: './adapter',
      use: { adapterUrl: FASTIFY_ADAPTER_URL },
    },
    // Any adapter's reference app, by URL. See verify/CONFORMANCE.md.
    {
      name: 'conformance',
      testDir: './adapter',
      use: { adapterUrl: CONFORMANCE_ADAPTER_URL },
    },
    { name: 'react', testDir: './react', use: { ...browser, baseURL: REACT_URL } },
    // The same specs against the template's development server, where React
    // Strict Mode runs every effect twice. Same URL: `seamless verify --dev`
    // serves the dev build on the port the production build just left.
    { name: 'react-dev', testDir: './react', use: { ...browser, baseURL: REACT_URL } },
    // The Next.js full-stack starter renders its own screens, so it has its own
    // specs; its dev pass runs them on `next dev`.
    { name: 'nextjs', testDir: './nextjs', use: { ...browser, baseURL: REACT_URL } },
    { name: 'nextjs-dev', testDir: './nextjs', use: { ...browser, baseURL: REACT_URL } },
  ],
});
