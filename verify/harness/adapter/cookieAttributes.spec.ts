import { cookieNamed, isCleared, SetCookie } from '../lib/cookies';
import { cookieSignup } from '../lib/conformanceFlows';
import { expect, test } from '../lib/fixtures';

// The adapter holds the auth API's tokens in cookies, so the cookie attributes are
// its security contract. These are the defaults every adapter ships with.
function expectSessionAttributes(cookie: SetCookie | undefined, name: string) {
  expect(cookie, `${name} is set`).toBeDefined();
  const { attributes } = cookie!;

  expect(attributes.httponly, `${name} is HttpOnly`).toBe(true);
  expect(attributes.secure, `${name} is Secure`).toBe(true);
  expect(String(attributes.samesite).toLowerCase(), `${name} is SameSite=None`).toBe('none');
  expect(attributes.path, `${name} is scoped to /`).toBe('/');
}

function maxAge(cookie: SetCookie | undefined): number {
  return Number(cookie?.attributes['max-age']);
}

test.describe('cookie attributes (adapter, cookies)', () => {
  test('registration stores the ephemeral token in a session cookie', async ({ adapterActor }) => {
    const { register } = await cookieSignup(adapterActor.ctx, adapterActor.email);

    const ephemeral = cookieNamed(register, 'seamless-ephemeral');
    expectSessionAttributes(ephemeral, 'seamless-ephemeral');
    expect(maxAge(ephemeral), 'ephemeral cookie lives as long as the API said').toBe(
      (await register.json()).ttl,
    );
  });

  test('a completed sign-in sets access and refresh cookies for the lifetimes the API gave', async ({
    adapterActor,
  }) => {
    const { verify } = await cookieSignup(adapterActor.ctx, adapterActor.email);
    const body = await verify.json();

    const access = cookieNamed(verify, 'seamless-access');
    const refresh = cookieNamed(verify, 'seamless-refresh');
    expectSessionAttributes(access, 'seamless-access');
    expectSessionAttributes(refresh, 'seamless-refresh');
    expect(maxAge(access), 'access cookie lifetime').toBe(body.ttl);
    expect(maxAge(refresh), 'refresh cookie lifetime').toBe(body.refreshTtl);
  });

  // Every token lives in a cookie, so none may also be in a body a page script can
  // read (seamless-auth-server#202).
  test('no response body carries a token', async ({ adapterActor }) => {
    const responses = await cookieSignup(adapterActor.ctx, adapterActor.email);

    for (const [step, res] of Object.entries(responses)) {
      const body = await res.json();
      expect(body?.token, `${step} body has no token`).toBeUndefined();
      expect(body?.refreshToken, `${step} body has no refresh token`).toBeUndefined();
    }
  });

  test('logout clears the access and refresh cookies', async ({ adapterActor }) => {
    await cookieSignup(adapterActor.ctx, adapterActor.email);

    const out = await adapterActor.ctx.delete('/auth/logout');
    expect(out.status(), 'logout').toBe(204);

    for (const name of ['seamless-access', 'seamless-refresh']) {
      const cookie = cookieNamed(out, name);
      expect(cookie, `${name} is cleared`).toBeDefined();
      expect(isCleared(cookie!), `${name} is expired`).toBe(true);
      expect(cookie!.attributes.path, `${name} is cleared at /`).toBe('/');
    }
  });
});
