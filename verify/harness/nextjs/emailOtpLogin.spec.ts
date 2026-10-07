import { expect, test } from '../lib/fixtures';
import { registerAndVerifyEmail } from '../lib/flows';
import { expectSignedIn, signInWithEmailCode } from '../lib/nextjsFlows';

test.describe('email OTP login (nextjs, browser)', { tag: '@login' }, () => {
  test('sign in with an emailed one-time code -> session page', async ({ page, actor }) => {
    await registerAndVerifyEmail(actor.ctx, actor.email);

    await signInWithEmailCode(page, actor.email);
    await expect(page.getByRole('heading', { name: 'Your session' })).toBeVisible();
    await expectSignedIn(page, actor.email);
  });
});
