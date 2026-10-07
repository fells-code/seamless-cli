import { expect, test } from '../lib/fixtures';
import { registerAndVerifyEmail } from '../lib/flows';
import { expectSignedIn, signInWithEmailCode } from '../lib/nextjsFlows';

// These load pages with JavaScript off, so what they see is the document the
// server rendered: no client code ran to redirect, fetch, or fill anything in.
test.describe('server-rendered session (nextjs)', { tag: '@session' }, () => {
  test('a signed-out request for /session is redirected before the page renders', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      const redirects: number[] = [];
      page.on('response', (res) => {
        if (new URL(res.url()).pathname === '/session') redirects.push(res.status());
      });

      await page.goto('/session');

      expect(redirects).toEqual([307]);
      const landed = new URL(page.url());
      expect(landed.pathname).toBe('/login');
      expect(landed.searchParams.get('next')).toBe('/session');
    } finally {
      await context.close();
    }
  });

  test('the session page is rendered on the server with the signed-in user', async ({
    browser,
    baseURL,
    page,
    context,
    actor,
  }) => {
    await registerAndVerifyEmail(actor.ctx, actor.email);
    await signInWithEmailCode(page, actor.email, '/session');
    await expectSignedIn(page, actor.email);

    const serverOnly = await browser.newContext({
      baseURL,
      javaScriptEnabled: false,
      storageState: await context.storageState(),
    });
    try {
      const ssr = await serverOnly.newPage();
      const res = await ssr.goto('/session');
      expect(res?.status()).toBe(200);
      await expect(ssr.getByRole('heading', { name: 'Your session' })).toBeVisible();
      await expect(ssr.getByRole('main').getByText(actor.email)).toBeVisible();
    } finally {
      await serverOnly.close();
    }
  });
});
