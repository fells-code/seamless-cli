import { OWNER_EMAIL } from '../lib/env';
import { expect, test } from '../lib/fixtures';
import { ownerAccessToken, registerAndVerifyEmail, setUserRoles } from '../lib/flows';
import { expectSignedIn, signInWithEmailCode } from '../lib/nextjsFlows';

// The starter serves the admin dashboard at /console (SERVE_ADMIN_CONSOLE in the
// compose file), proxied from the auth server, so the dashboard runs on the app's
// origin and reaches the admin routes through the app's own /auth with its cookies.
test.describe('admin console (nextjs)', { tag: '@console' }, () => {
  test('/console serves the dashboard shell and its assets from the app origin', async ({
    page,
  }) => {
    const assets: number[] = [];
    page.on('response', (res) => {
      if (new URL(res.url()).pathname.startsWith('/console/assets/')) assets.push(res.status());
    });

    const shell = await page.goto('/console');

    expect(shell?.status()).toBe(200);
    expect(shell?.headers()['content-type']).toContain('text/html');
    expect(await shell?.text()).toMatch(/src="\/console\/assets\/[^"]+\.js"/);
    await expect.poll(() => assets.length, { message: 'a /console/assets/ request' }).toBeGreaterThan(0);
    expect(assets.every((status) => status === 200), `asset statuses ${assets}`).toBe(true);
  });

  test('an admin signed in on the app loads the console, which calls the admin API through it', async ({
    page,
    actor,
  }) => {
    const { sub } = await registerAndVerifyEmail(actor.ctx, actor.email);
    expect(sub, 'registration returns the user id').toBeTruthy();
    const owner = await ownerAccessToken(actor.ctx, OWNER_EMAIL);
    await setUserRoles(actor.ctx, owner, sub!, ['user', 'admin']);

    await signInWithEmailCode(page, actor.email);
    await expectSignedIn(page, actor.email);

    const users = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/auth/admin/users' && res.request().method() === 'GET',
    );
    await page.goto('/console/users');

    expect((await users).status(), 'GET /auth/admin/users from the console').toBe(200);
    await expect(page.getByText(actor.email).first()).toBeVisible();
  });
});
