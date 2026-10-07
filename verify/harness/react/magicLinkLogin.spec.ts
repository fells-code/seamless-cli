import { expect, test } from '../lib/fixtures';
import { registerAndVerifyEmail } from '../lib/flows';
import { gotoSignIn, readCapturedCode } from '../lib/reactFlows';

test.describe('magic link login (react, browser)', { tag: '@login' }, () => {
  test('request a magic link, open it in a second tab -> original tab authenticates', async ({
    page,
    context,
    actor,
  }) => {
    await registerAndVerifyEmail(actor.ctx, actor.email);

    await gotoSignIn(page);
    await page.locator('#identifier').fill(actor.email);
    await page.getByRole('button', { name: 'Login', exact: true }).click();

    await page.getByRole('button', { name: /Email Magic Link/ }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

    // "Click" the emailed link in a second tab; the original tab completes via
    // BroadcastChannel + polling (same device binding — same browser/adapter).
    const token = await readCapturedCode(actor.email);
    const linkTab = await context.newPage();

    // The link is single use. Under Strict Mode (the react-dev project) an
    // unguarded verify effect runs twice: the first request spends the link and
    // the second is refused, and the screen reports that refusal. Every verify
    // request the tab sends has to succeed.
    const verifyStatuses: number[] = [];
    linkTab.on('response', (res) => {
      if (new URL(res.url()).pathname.startsWith('/auth/magic-link/verify/')) {
        verifyStatuses.push(res.status());
      }
    });

    await linkTab.goto(`/verify-magiclink?token=${encodeURIComponent(token)}`);

    await expect(page.getByText('You are signed in')).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(() => verifyStatuses.length, { message: 'the link was verified' })
      .toBeGreaterThan(0);
    await linkTab.waitForLoadState('networkidle');
    expect(
      verifyStatuses.filter((status) => status >= 400),
      `every verify request for the link succeeded (got ${verifyStatuses.join(', ')})`,
    ).toEqual([]);
    await expect(linkTab.getByText('Failed to verify token')).toHaveCount(0);
    await linkTab.close();
  });
});
