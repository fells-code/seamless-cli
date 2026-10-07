import { expect, test } from '../lib/fixtures';
import { registerAndVerifyEmail } from '../lib/flows';
import {
  expectSignedIn,
  lastCapturedCode,
  readStarterCode,
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

    const token = await readStarterCode(page, actor.email, previous);
    const linkTab = await context.newPage();

    // The link is single use, and the dev pass runs under Strict Mode, which runs
    // the verify effect twice. Every verify request the tab sends has to succeed.
    const verifyStatuses: number[] = [];
    linkTab.on('response', (res) => {
      if (new URL(res.url()).pathname.startsWith('/auth/magic-link/verify/')) {
        verifyStatuses.push(res.status());
      }
    });
    await linkTab.goto(`/verify-magiclink?token=${encodeURIComponent(token)}`);

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
    expect(verifyStatuses.length, 'the link was verified').toBeGreaterThan(0);
    expect(
      verifyStatuses.filter((status) => status >= 400),
      `every verify request for the link succeeded (got ${verifyStatuses.join(', ')})`,
    ).toEqual([]);
    await linkTab.close();
  });
});
