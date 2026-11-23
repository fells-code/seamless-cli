import { expect, test } from '../lib/fixtures';
import {
  loginViaMagicLink,
  registerAndVerifyEmail,
  requestMagicLinkViaAdapter,
} from '../lib/adapterFlows';

test.describe('magic link login (adapter, cookies)', () => {
  test('register -> verify -> magic-link request/verify/confirm/poll -> session -> /users/me', async ({
    adapterActor,
  }) => {
    await registerAndVerifyEmail(adapterActor.ctx, adapterActor.email);
    await loginViaMagicLink(adapterActor.ctx, adapterActor.email);

    const me = await adapterActor.ctx.get('/auth/users/me');
    expect(me.status(), 'authenticated via magic-link session cookie').toBe(200);
  });

  // The token alone, which is all a leaked query string carries, must not sign in
  // through the adapter either: the API refuses the confirm and the adapter passes the
  // refusal on. The flow above shows the adapter forwards the body when it has a code.
  test('a confirm through the adapter without the code is refused', async ({ adapterActor }) => {
    const { ctx, email } = adapterActor;
    await registerAndVerifyEmail(ctx, email);
    expect((await ctx.post('/auth/login', { data: { identifier: email } })).ok()).toBeTruthy();

    const { token } = await requestMagicLinkViaAdapter(ctx, email);
    expect((await ctx.get(`/auth/magic-link/verify/${token}`)).status()).toBe(409);

    const confirmed = await ctx.post(`/auth/magic-link/verify/${token}/confirm`, { data: {} });
    expect(confirmed.status(), 'confirm without the code is refused').toBe(400);
    expect((await ctx.get('/auth/magic-link/check')).status(), 'no session').toBe(204);
  });
});
