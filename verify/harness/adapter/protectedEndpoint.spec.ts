import { request as playwrightRequest } from '@playwright/test';

import { cookieSignup, currentUserId } from '../lib/conformanceFlows';
import { expect, test } from '../lib/fixtures';

// GET /api/me is the reference app's own route behind the adapter's guard, so these
// check the guard an adopter puts on their API, not the /auth routes.
test.describe('protected app endpoint (adapter, cookies)', () => {
  test('refuses a request with no session', async ({ adapterActor }) => {
    expect((await adapterActor.ctx.get('/api/me')).status()).toBe(401);
  });

  test('accepts the session cookie and sees the signed-in user', async ({ adapterActor }) => {
    await cookieSignup(adapterActor.ctx, adapterActor.email);
    const userId = await currentUserId(adapterActor.ctx);

    const res = await adapterActor.ctx.get('/api/me');
    expect(res.status()).toBe(200);
    expect((await res.json()).id).toBe(userId);
  });

  test('refuses an access cookie that has been altered', async ({ adapterActor, adapterUrl }) => {
    await cookieSignup(adapterActor.ctx, adapterActor.email);
    const { cookies } = await adapterActor.ctx.storageState();
    const access = cookies.find((c) => c.name === 'seamless-access');
    expect(access, 'an access cookie').toBeDefined();

    const value = access!.value;
    const tampered = value.slice(0, -2) + (value.endsWith('AA') ? 'BB' : 'AA');
    const browser = await playwrightRequest.newContext({
      baseURL: adapterUrl,
      storageState: { cookies: [{ ...access!, value: tampered }], origins: [] },
    });

    try {
      expect((await browser.get('/api/me')).status()).toBe(401);
    } finally {
      await browser.dispose();
    }
  });
});
