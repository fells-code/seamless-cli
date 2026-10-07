import { OWNER_EMAIL } from '../lib/env';
import { expect, test } from '../lib/fixtures';
import { ownerAccessToken, registerAndVerifyEmail, setUserRoles } from '../lib/flows';
import { expectSignedIn, signInWithEmailCode } from '../lib/nextjsFlows';

test.describe('role-gated route (nextjs)', { tag: '@roles' }, () => {
  test('/api/beta-users answers 403 until the user holds betaUser, then the list', async ({
    page,
    actor,
  }) => {
    const { sub } = await registerAndVerifyEmail(actor.ctx, actor.email);
    expect(sub, 'registration returns the user id').toBeTruthy();

    // /beta is protected, so a signed-out visit goes through sign-in and back.
    await signInWithEmailCode(page, actor.email, '/beta');
    await expect(page.getByRole('heading', { name: 'Beta access' })).toBeVisible();
    await expectSignedIn(page, actor.email);
    await expect(page.getByText(/The server answered 403/)).toBeVisible();
    await expect(page.getByText('You do not hold the betaUser role.', { exact: false })).toBeVisible();

    const admin = await ownerAccessToken(actor.ctx, OWNER_EMAIL);
    await setUserRoles(actor.ctx, admin, sub!, ['user', 'betaUser']);

    // Roles travel in the access token, so the new one applies from the next sign-in.
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await signInWithEmailCode(page, actor.email, '/beta');

    await expect(page.getByRole('heading', { name: 'Beta access' })).toBeVisible();
    await expect(page.getByText('You hold the betaUser role.')).toBeVisible();
    await expect(page.getByText('ada@example.com')).toBeVisible();
  });
});
