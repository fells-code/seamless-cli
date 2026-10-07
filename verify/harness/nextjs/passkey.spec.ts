import { expect, test } from '../lib/fixtures';
import { expectSignedIn, registerWithPasskey, startSignIn } from '../lib/nextjsFlows';
import { addVirtualAuthenticator } from '../lib/reactFlows';

test.describe('passkey (nextjs, browser)', { tag: '@login' }, () => {
  test('create an account, enroll a passkey, sign out, and sign back in with it', async ({
    page,
    context,
    actor,
  }) => {
    await addVirtualAuthenticator(context, page);

    await registerWithPasskey(page, actor.email);
    await expect(page.getByRole('heading', { name: 'Your session' })).toBeVisible();
    await expectSignedIn(page, actor.email);

    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();

    // The account offers a passkey and the browser has one, so the ceremony runs
    // straight from the identifier with nothing else to choose.
    await startSignIn(page, actor.email);
    await expect(page.getByRole('heading', { name: 'Your session' })).toBeVisible();
    await expectSignedIn(page, actor.email);
  });
});
