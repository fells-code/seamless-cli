import { expect, test } from '../lib/fixtures';
import { registerAndVerifyEmail } from '../lib/flows';
import {
  expectSignedIn,
  lastCapturedCode,
  readStarterMagicLink,
  startSignIn,
} from '../lib/nextjsFlows';

test.describe('magic link login (nextjs, browser)', { tag: '@login' }, () => {
  test('request a link, open it in a second tab -> both tabs signed in', async ({
    page,
    context,
    actor,
  }) => {
    await registerAndVerifyEmail(actor.ctx, actor.email);

    await startSignIn(page, actor.email);
    const previous = await lastCapturedCode(page, actor.email);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByText(/We emailed a sign-in link/)).toBeVisible();

    const link = await readStarterMagicLink(page, actor.email, previous);
    const linkTab = await context.newPage();

    // Opening the link (GET verify) never signs in: it answers 409 with
    // `sameDevice: true` in the browser that asked, and the page confirms with the
    // code from the fragment. The confirm spends the link, and the dev pass runs
    // under Strict Mode, which runs the effect twice, so every confirm has to succeed.
    const verifyStatuses: number[] = [];
    const confirmStatuses: number[] = [];
    linkTab.on('response', (res) => {
      const { pathname } = new URL(res.url());
      if (!pathname.startsWith('/auth/magic-link/verify/')) return;
      if (pathname.endsWith('/confirm')) confirmStatuses.push(res.status());
      else verifyStatuses.push(res.status());
    });
    await linkTab.goto(link);

    // The requesting tab collects the session from /magic-link/check.
    await expect(page.getByRole('heading', { name: 'Your session' })).toBeVisible({
      timeout: 15_000,
    });
    await expectSignedIn(page, actor.email);

    // Opened in the same browser, the link tab signs in too.
    await expect(linkTab.getByRole('heading', { name: 'Your session' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(linkTab.getByText('This link did not work')).toHaveCount(0);
    expect(confirmStatuses.length, 'the link was confirmed').toBeGreaterThan(0);
    expect(
      verifyStatuses.filter((status) => status !== 409),
      `every verify answered 409 confirmation_required (got ${verifyStatuses.join(', ')})`,
    ).toEqual([]);
    expect(
      confirmStatuses.filter((status) => status >= 400),
      `every confirm for the link succeeded (got ${confirmStatuses.join(', ')})`,
    ).toEqual([]);
    await linkTab.close();
  });
});
