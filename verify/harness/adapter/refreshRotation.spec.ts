import { request as playwrightRequest } from '@playwright/test';

import { AdapterActor } from '../lib/client';
import { cookieNamed } from '../lib/cookies';
import { cookieSignup, waitOutReuseWindow } from '../lib/conformanceFlows';
import { expect, test } from '../lib/fixtures';

// A browser that holds only some of an actor's cookies, through the same hop.
async function browserHolding(actor: AdapterActor, adapterUrl: string, names: string[]) {
  const { cookies } = await actor.ctx.storageState();

  return playwrightRequest.newContext({
    baseURL: adapterUrl,
    userAgent: actor.userAgent,
    extraHTTPHeaders: { 'x-forwarded-for': actor.clientIp },
    storageState: { cookies: cookies.filter((c) => names.includes(c.name)), origins: [] },
  });
}

test.describe('refresh rotation (adapter, cookies)', () => {
  test('a missing access cookie is restored from the refresh cookie, which rotates', async ({
    adapterActor,
    adapterUrl,
  }) => {
    await cookieSignup(adapterActor.ctx, adapterActor.email);
    const original = (await adapterActor.ctx.storageState()).cookies.find(
      (c) => c.name === 'seamless-refresh',
    );

    const browser = await browserHolding(adapterActor, adapterUrl, ['seamless-refresh']);
    try {
      const me = await browser.get('/auth/users/me');
      expect(me.status(), 'signed in from the refresh cookie alone').toBe(200);
      expect(cookieNamed(me, 'seamless-access'), 'a new access cookie').toBeDefined();

      const rotated = cookieNamed(me, 'seamless-refresh');
      expect(rotated, 'a new refresh cookie').toBeDefined();
      expect(rotated!.value, 'the refresh cookie rotated').not.toBe(original?.value);
    } finally {
      await browser.dispose();
    }
  });

  test('concurrent requests holding one refresh cookie all succeed', async ({
    adapterActor,
    adapterUrl,
  }) => {
    await cookieSignup(adapterActor.ctx, adapterActor.email);

    const tabs = await Promise.all(
      [0, 1, 2].map(() => browserHolding(adapterActor, adapterUrl, ['seamless-refresh'])),
    );
    try {
      const statuses = await Promise.all(
        tabs.map(async (tab) => (await tab.get('/auth/users/me')).status()),
      );
      expect(statuses).toEqual([200, 200, 200]);
    } finally {
      await Promise.all(tabs.map((tab) => tab.dispose()));
    }
  });

  test('a refresh cookie used outside the reuse window is refused', async ({
    adapterActor,
    adapterUrl,
  }) => {
    test.setTimeout(30_000);
    await cookieSignup(adapterActor.ctx, adapterActor.email);

    const first = await browserHolding(adapterActor, adapterUrl, ['seamless-refresh']);
    try {
      expect((await first.get('/auth/users/me')).status(), 'first use').toBe(200);
    } finally {
      await first.dispose();
    }

    await waitOutReuseWindow(adapterActor.ctx);

    const replay = await browserHolding(adapterActor, adapterUrl, ['seamless-refresh']);
    try {
      expect((await replay.get('/auth/users/me')).status(), 'replayed refresh').toBe(401);
    } finally {
      await replay.dispose();
    }
  });

  test('POST /auth/refresh rotates both cookies and returns no tokens', async ({
    adapterActor,
  }) => {
    await cookieSignup(adapterActor.ctx, adapterActor.email);

    const res = await adapterActor.ctx.post('/auth/refresh');
    expect(res.status(), 'refresh').toBe(200);
    expect(cookieNamed(res, 'seamless-access'), 'access cookie reissued').toBeDefined();
    expect(cookieNamed(res, 'seamless-refresh'), 'refresh cookie rotated').toBeDefined();

    const body = await res.json().catch(() => null);
    expect(body?.token, 'no access token in the body').toBeUndefined();
    expect(body?.refreshToken, 'no refresh token in the body').toBeUndefined();
  });
});
