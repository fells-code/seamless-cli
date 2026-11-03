import { request as playwrightRequest } from '@playwright/test';

import { cookieSignup } from '../lib/conformanceFlows';
import { expect, test } from '../lib/fixtures';
import { requireContract } from '../lib/pendingContracts';

// What an adapter refuses before a cookie-transport request reaches the auth API.
// A cross-site page can make a browser send a form POST with the victim's cookies
// and no CORS preflight; these are the two checks that stop it.
test.describe('request guards (adapter, cookies)', () => {
  test('a body-less form POST without a transport header is refused with 415', async ({
    adapterActor,
    adapterUrl,
  }) => {
    requireContract('content-type-gate');
    await cookieSignup(adapterActor.ctx, adapterActor.email);

    // The same session, but without the header the actor sends, as a cross-site
    // form would arrive. No Sec-Fetch-Site or Origin, so only this check applies.
    const { cookies } = await adapterActor.ctx.storageState();
    const form = await playwrightRequest.newContext({
      baseURL: adapterUrl,
      userAgent: adapterActor.userAgent,
      extraHTTPHeaders: { 'x-forwarded-for': adapterActor.clientIp },
      storageState: { cookies, origins: [] },
    });

    try {
      const refused = await form.post('/auth/recovery-codes', {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(refused.status(), 'a body-less form POST').toBe(415);
      expect((await refused.json()).error).toBe('unsupported_media_type');
    } finally {
      await form.dispose();
    }

    // With the header the same request goes through. A 201 also shows the refused
    // request made no codes: replacing an existing set needs a fresh step-up.
    const accepted = await adapterActor.ctx.post('/auth/recovery-codes');
    expect(accepted.status(), 'the same request naming cookie transport').toBe(201);
  });

  // The reference app issues SameSite=None cookies (see CONFORMANCE.md), which a
  // browser attaches to a cross-site request, so this is the case the guard exists
  // for. A Lax or Strict deployment is refused the same way from v0.23.
  test('a cross-site unsafe request is refused with 403 and changes nothing', async ({
    adapterActor,
  }) => {
    await cookieSignup(adapterActor.ctx, adapterActor.email);
    const crossSite = { 'sec-fetch-site': 'cross-site', origin: 'https://attacker.example' };

    const generate = await adapterActor.ctx.post('/auth/recovery-codes', {
      headers: crossSite,
      data: {},
    });
    expect(generate.status(), 'cross-site POST /auth/recovery-codes').toBe(403);
    expect((await generate.json()).error).toBe('cross_site_request_blocked');

    const logout = await adapterActor.ctx.delete('/auth/logout', { headers: crossSite });
    expect(logout.status(), 'cross-site DELETE /auth/logout').toBe(403);
    expect((await logout.json()).error).toBe('cross_site_request_blocked');

    const me = await adapterActor.ctx.get('/auth/users/me');
    expect(me.status(), 'the session survives the refused logout').toBe(200);
  });
});
