import { test as base } from '@playwright/test';

import { Actor, AdapterActor, newAdapterActor, newApiActor } from './client';
import { ADAPTER_URL } from './env';

// `adapterUrl` is a project option rather than something a spec sets: the adapter
// suite is written once and each project points it at a different adopter backend
// (Express, Fastify). A spec cannot tell which one answered, which is the point.
export interface AdapterOptions {
  adapterUrl: string;
}

// `actor` drives the API directly (Bearer + service token); `adapterActor` drives
// the adopter backend over cookies. Both are auto-created and disposed per test.
export const test = base.extend<AdapterOptions & { actor: Actor; adapterActor: AdapterActor }>({
  adapterUrl: [ADAPTER_URL, { option: true }],
  actor: async ({}, use) => {
    const actor = await newApiActor();
    await use(actor);
    await actor.dispose();
  },
  adapterActor: async ({ adapterUrl }, use) => {
    const actor = await newAdapterActor(adapterUrl);
    await use(actor);
    await actor.dispose();
  },
});

export { expect } from '@playwright/test';
