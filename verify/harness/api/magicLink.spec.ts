import { expect, test } from '../lib/fixtures';
import {
  confirmMagicLink,
  login,
  pollMagicLink,
  registerAndVerifyEmail,
  requestMagicLink,
  verifyMagicLink,
} from '../lib/flows';

// The link is `<target>?token=T#code=C`. Opening it (GET verify) never signs in:
// only a confirm that carries the code from the fragment consumes it. A query string
// leaks through a Referer, an analytics beacon or an access log, so the token on its
// own must never be enough.

test.describe('magic link (api)', () => {
  test('request -> poll(waiting) -> verify(409) -> confirm with code -> poll issues a session', async ({
    actor,
  }) => {
    await registerAndVerifyEmail(actor.ctx, actor.email); // user must exist + be verified
    const ephemeral = await login(actor.ctx, actor.email);

    const { token, code } = await requestMagicLink(actor.ctx, ephemeral);

    // Polling before the link is verified must return 204 (still waiting), never 500.
    // This is the exact regression that created the otp-sanatization branch.
    const pending = await pollMagicLink(actor.ctx, ephemeral);
    expect(pending.status(), 'poll before verify is 204, not 500').toBe(204);

    const verified = await verifyMagicLink(actor.ctx, token, ephemeral);
    expect(verified.status(), 'verify never signs in, even on the requesting device').toBe(409);
    const held = await verified.json();
    expect(held.error).toBe('confirmation_required');
    expect(held.sameDevice, 'the requesting attempt is recognised').toBe(true);
    expect(held.requestedFrom?.requestedAt, 'requestedFrom says when it was asked for').toBeTruthy();

    // Opening the link does not consume it.
    expect((await pollMagicLink(actor.ctx, ephemeral)).status(), 'still waiting after verify').toBe(
      204,
    );

    const confirmed = await confirmMagicLink(actor.ctx, token, { code }, ephemeral);
    expect(confirmed.ok(), `confirm -> ${confirmed.status()} ${await confirmed.text()}`).toBeTruthy();

    const completed = await pollMagicLink(actor.ctx, ephemeral);
    expect(completed.status(), 'poll after confirm issues a session').toBe(200);
    const body = await completed.json();
    expect(body.token, 'session access token').toBeTruthy();
    expect(body.refreshToken, 'session refresh token').toBeTruthy();
  });

  test('a link with its fragment stripped cannot sign in', async ({ actor }) => {
    await registerAndVerifyEmail(actor.ctx, actor.email);
    const ephemeral = await login(actor.ctx, actor.email);
    const { token } = await requestMagicLink(actor.ctx, ephemeral);

    // Everything a leaked query string hands over: the token, and the attempt that
    // asked for it when the attacker requested the link themselves.
    expect((await verifyMagicLink(actor.ctx, token, ephemeral)).status()).toBe(409);
    const confirmed = await confirmMagicLink(actor.ctx, token, {}, ephemeral);
    expect(confirmed.status(), 'confirm without the code is refused').toBe(400);

    expect(
      (await pollMagicLink(actor.ctx, ephemeral)).status(),
      'no session without the code',
    ).toBe(204);
  });

  test('a wrong code is refused and spends the link', async ({ actor }) => {
    await registerAndVerifyEmail(actor.ctx, actor.email);
    const ephemeral = await login(actor.ctx, actor.email);
    const { token, code } = await requestMagicLink(actor.ctx, ephemeral);

    const wrong = await confirmMagicLink(actor.ctx, token, { code: `${code}x` }, ephemeral);
    expect(wrong.status(), 'a wrong code is refused').toBe(400);

    // Spent, so the right code can no longer be guessed toward.
    const retry = await confirmMagicLink(actor.ctx, token, { code }, ephemeral);
    expect(retry.status(), 'the right code after a wrong one is refused').toBe(400);
    expect((await verifyMagicLink(actor.ctx, token, ephemeral)).status(), 'spent link').toBe(400);
    expect((await pollMagicLink(actor.ctx, ephemeral)).status(), 'no session').toBe(204);
  });

  test('an invalid magic-link token is rejected', async ({ actor }) => {
    const res = await verifyMagicLink(actor.ctx, 'not-a-real-token');
    expect(res.status()).toBe(400);
  });
});
