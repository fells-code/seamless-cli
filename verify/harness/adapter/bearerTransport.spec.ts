import { setCookies } from '../lib/cookies';
import {
  BEARER_TRANSPORT,
  bearer,
  bearerSignup,
  waitOutReuseWindow,
} from '../lib/conformanceFlows';
import { expect, test } from '../lib/fixtures';

// Bearer transport is for clients that hold their own tokens (mobile, CLIs). The
// adapter passes tokens through in bodies and sets no cookies.
test.describe('bearer transport (adapter)', () => {
  test('signup returns every token in the body and sets no cookies', async ({ adapterActor }) => {
    const session = await bearerSignup(adapterActor.ctx, adapterActor.email);

    for (const [step, res] of Object.entries({
      register: session.register,
      sendCode: session.sendCode,
      verify: session.verify,
    })) {
      expect(setCookies(res), `${step} sets no cookies`).toEqual([]);
    }
  });

  test('the access token is accepted by the adapter and by the app', async ({ adapterActor }) => {
    const { token } = await bearerSignup(adapterActor.ctx, adapterActor.email);
    const headers = { ...BEARER_TRANSPORT, ...bearer(token) };

    const me = await adapterActor.ctx.get('/auth/users/me', { headers });
    expect(me.status(), 'users/me').toBe(200);
    const userId = (await me.json()).user.id;

    const app = await adapterActor.ctx.get('/api/me', { headers: bearer(token) });
    expect(app.status(), 'the app accepts the access token').toBe(200);
    expect((await app.json()).id, 'the app sees the same user').toBe(userId);
  });

  test('refresh rotates the pair and refuses a used refresh token', async ({ adapterActor }) => {
    test.setTimeout(30_000);
    const { refreshToken } = await bearerSignup(adapterActor.ctx, adapterActor.email);

    const rotated = await adapterActor.ctx.post('/auth/refresh', {
      headers: { ...BEARER_TRANSPORT, ...bearer(refreshToken) },
    });
    expect(rotated.status(), 'refresh').toBe(200);
    const body = await rotated.json();
    expect(typeof body.token, 'a new access token').toBe('string');
    expect(body.refreshToken, 'a new refresh token').not.toBe(refreshToken);
    expect(setCookies(rotated), 'refresh sets no cookies').toEqual([]);

    await waitOutReuseWindow(adapterActor.ctx);

    const replay = await adapterActor.ctx.post('/auth/refresh', {
      headers: { ...BEARER_TRANSPORT, ...bearer(refreshToken) },
    });
    expect(replay.status(), 'a used refresh token').toBe(401);
  });

  test('logout ends the session', async ({ adapterActor }) => {
    const { token, refreshToken } = await bearerSignup(adapterActor.ctx, adapterActor.email);

    const out = await adapterActor.ctx.delete('/auth/logout', {
      headers: { ...BEARER_TRANSPORT, ...bearer(token) },
    });
    expect(out.ok(), `logout -> ${out.status()}`).toBeTruthy();

    const refresh = await adapterActor.ctx.post('/auth/refresh', {
      headers: { ...BEARER_TRANSPORT, ...bearer(refreshToken) },
    });
    expect(refresh.status(), 'refresh after logout').toBe(401);
  });
});
