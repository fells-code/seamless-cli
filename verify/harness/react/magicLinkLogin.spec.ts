import { expect, test } from '../lib/fixtures';
import { registerAndVerifyEmail } from '../lib/flows';
import { gotoSignIn, readCapturedMagicLink } from '../lib/reactFlows';

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

    // "Click" the emailed link, `/verify-magiclink?token=T#code=C`, in a second tab;
    // the original tab completes via BroadcastChannel + polling.
    const link = await readCapturedMagicLink(actor.email);
    const linkTab = await context.newPage();

    // Opening the link (GET verify) never signs in: it answers 409 with
    // `sameDevice: true` here, since the tab shares the requesting browser. The
    // screen then confirms with the code from the fragment, without asking, and
    // that confirm is what spends the link. Under Strict Mode (the react-dev
    // project) an unguarded effect runs twice, and a second confirm finds the link
    // spent and is refused, so every confirm the tab sends has to succeed.
    const verifyStatuses: number[] = [];
    const confirmStatuses: number[] = [];
    linkTab.on('response', (res) => {
      const { pathname } = new URL(res.url());
      if (!pathname.startsWith('/auth/magic-link/verify/')) return;
      if (pathname.endsWith('/confirm')) confirmStatuses.push(res.status());
      else verifyStatuses.push(res.status());
    });

    await linkTab.goto(link);

    await expect(page.getByText('You are signed in')).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(() => confirmStatuses.length, { message: 'the link was confirmed' })
      .toBeGreaterThan(0);
    await linkTab.waitForLoadState('networkidle');
    expect(
      verifyStatuses.filter((status) => status !== 409),
      `every verify answered 409 confirmation_required (got ${verifyStatuses.join(', ')})`,
    ).toEqual([]);
    expect(
      confirmStatuses.filter((status) => status >= 400),
      `every confirm for the link succeeded (got ${confirmStatuses.join(', ')})`,
    ).toEqual([]);
    expect(new URL(linkTab.url()).hash, 'the screen strips the code from the address').not.toContain(
      'code=',
    );
    await expect(linkTab.getByText('Failed to verify token')).toHaveCount(0);
    await linkTab.close();
  });
});
