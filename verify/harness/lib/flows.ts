import { APIRequestContext, expect } from '@playwright/test';

import { EXTERNAL_DELIVERY } from './env';

export interface SessionTokens {
  token: string; // signed access token
  refreshToken: string; // opaque refresh token
  sub?: string;
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// All helpers take an actor's request context (baseURL = API, with client-IP +
// service-token headers already applied). Paths are therefore relative.

/** Register a new email user; returns the ephemeral (pre-auth) token. */
export async function registerEmail(ctx: APIRequestContext, email: string): Promise<string> {
  const res = await ctx.post('/registration/register', {
    headers: EXTERNAL_DELIVERY,
    data: { email },
  });
  expect(res.ok(), `register ${email} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  expect(body.token, 'register returns an ephemeral token').toBeTruthy();
  return body.token as string;
}

/** Register a new user with email + phone; returns the ephemeral (pre-auth) token. */
export async function registerWithPhone(
  ctx: APIRequestContext,
  email: string,
  phone: string,
): Promise<string> {
  const res = await ctx.post('/registration/register', {
    headers: EXTERNAL_DELIVERY,
    data: { email, phone },
  });
  expect(res.ok(), `register ${email} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  expect(body.token, 'register returns an ephemeral token').toBeTruthy();
  return body.token as string;
}

/** Generate a phone OTP and return the raw code via the external-delivery seam. */
export async function requestPhoneOtp(ctx: APIRequestContext, ephemeral: string): Promise<string> {
  const res = await ctx.get('/otp/generate-phone-otp', {
    headers: { ...bearer(ephemeral), ...EXTERNAL_DELIVERY },
  });
  expect(res.ok(), `generate-phone-otp -> ${res.status()} ${await res.text()}`).toBeTruthy();
  const code = (await res.json())?.delivery?.token;
  expect(code, 'external delivery returns the phone OTP code').toBeTruthy();
  return String(code);
}

export function verifyPhoneOtp(ctx: APIRequestContext, ephemeral: string, code: string) {
  return ctx.post('/otp/verify-phone-otp', {
    headers: bearer(ephemeral),
    data: { verificationToken: code },
  });
}

/** Generate an email OTP and return the raw code via the external-delivery seam. */
export async function requestEmailOtp(ctx: APIRequestContext, ephemeral: string): Promise<string> {
  const res = await ctx.get('/otp/generate-email-otp', {
    headers: { ...bearer(ephemeral), ...EXTERNAL_DELIVERY },
  });
  expect(res.ok(), `generate-email-otp -> ${res.status()} ${await res.text()}`).toBeTruthy();
  const code = (await res.json())?.delivery?.token;
  expect(code, 'external delivery returns the OTP code').toBeTruthy();
  return String(code);
}

export function verifyEmailOtp(ctx: APIRequestContext, ephemeral: string, code: string) {
  return ctx.post('/otp/verify-email-otp', {
    headers: bearer(ephemeral),
    data: { verificationToken: code },
  });
}

/** Full email-OTP registration -> verified session tokens. */
export async function registerAndVerifyEmail(
  ctx: APIRequestContext,
  email: string,
): Promise<SessionTokens> {
  const ephemeral = await registerEmail(ctx, email);
  const code = await requestEmailOtp(ctx, ephemeral);
  const res = await verifyEmailOtp(ctx, ephemeral, code);
  expect(res.ok(), `verify-email-otp -> ${res.status()} ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  expect(body.token, 'verify returns an access token').toBeTruthy();
  expect(body.refreshToken, 'verify returns a refresh token').toBeTruthy();
  return { token: body.token, refreshToken: body.refreshToken, sub: body.sub };
}

/** Begin a login; returns the ephemeral (pre-auth) token. */
export async function login(ctx: APIRequestContext, identifier: string): Promise<string> {
  const res = await ctx.post('/login', { data: { identifier } });
  expect(res.ok(), `login ${identifier} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  expect(body.token, 'login returns an ephemeral token').toBeTruthy();
  return body.token as string;
}

/** Request a magic link; returns the raw token + URL via external delivery. */
export async function requestMagicLink(
  ctx: APIRequestContext,
  ephemeral: string,
): Promise<{ token: string; magicLinkUrl: string }> {
  const res = await ctx.get('/magic-link', {
    headers: { ...bearer(ephemeral), ...EXTERNAL_DELIVERY },
  });
  expect(res.ok(), `magic-link request -> ${res.status()} ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  expect(body?.delivery?.token, 'external delivery returns the magic-link token').toBeTruthy();
  return { token: body.delivery.token, magicLinkUrl: body.delivery.magicLinkUrl };
}

export function verifyMagicLink(ctx: APIRequestContext, rawToken: string) {
  return ctx.get(`/magic-link/verify/${rawToken}`);
}

export function pollMagicLink(ctx: APIRequestContext, ephemeral: string) {
  return ctx.get('/magic-link/check', { headers: bearer(ephemeral) });
}

export function refresh(ctx: APIRequestContext, refreshToken: string) {
  return ctx.post('/refresh', { headers: bearer(refreshToken) });
}

export function listSessions(ctx: APIRequestContext, accessToken: string) {
  return ctx.get('/sessions', { headers: bearer(accessToken) });
}

export function logout(ctx: APIRequestContext, accessToken: string) {
  return ctx.delete('/logout', { headers: bearer(accessToken) });
}

/**
 * Full OAuth login against the mock IdP: start the flow, follow the authorize
 * redirect to obtain the code (the mock mints a fresh user), then exchange it at
 * the callback for a session. `pathPrefix` is '' for the API, '/auth' for the adapter.
 */
export async function oauthLogin(
  ctx: APIRequestContext,
  providerId = 'mock',
  pathPrefix = '',
): Promise<SessionTokens & { email?: string }> {
  const start = await ctx.post(`${pathPrefix}/oauth/${providerId}/start`, { data: {} });
  expect(start.ok(), `oauth start -> ${start.status()} ${await start.text()}`).toBeTruthy();
  const { authorizationUrl } = await start.json();

  const authorize = await ctx.get(authorizationUrl, { maxRedirects: 0 });
  expect(authorize.status(), `authorize redirects with a code (got ${authorize.status()})`).toBe(
    302,
  );
  const redirected = new URL(authorize.headers()['location']);
  const code = redirected.searchParams.get('code');
  const state = redirected.searchParams.get('state');
  expect(code, 'authorize returns an auth code').toBeTruthy();

  const callback = await ctx.post(`${pathPrefix}/oauth/${providerId}/callback`, {
    data: { code, state },
  });
  expect(callback.ok(), `oauth callback -> ${callback.status()} ${await callback.text()}`).toBeTruthy();
  const body = await callback.json();
  return { token: body.token, refreshToken: body.refreshToken, sub: body.sub, email: body.email };
}

/**
 * An access token for the tenant owner (OWNER_EMAIL, admin at signup), for the
 * admin API. Signs the owner in when the account exists (the api layer usually
 * registered it earlier in the run) and registers it otherwise. An unknown
 * identifier gets a decoy OTP send that delivers nothing, which is how the two
 * cases are told apart.
 */
export async function ownerAccessToken(ctx: APIRequestContext, ownerEmail: string): Promise<string> {
  const ephemeral = await login(ctx, ownerEmail);
  const sent = await ctx.get('/otp/generate-login-email-otp', {
    headers: { ...bearer(ephemeral), ...EXTERNAL_DELIVERY },
  });
  expect(sent.ok(), `generate-login-email-otp -> ${sent.status()}`).toBeTruthy();
  const code = (await sent.json())?.delivery?.token;

  if (code) {
    const res = await ctx.post('/otp/verify-login-email-otp', {
      headers: bearer(ephemeral),
      data: { verificationToken: String(code) },
    });
    expect(res.ok(), `verify-login-email-otp -> ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()).token as string;
  }

  return (await registerAndVerifyEmail(ctx, ownerEmail)).token;
}

/** Replace a user's roles through the admin API. */
export async function setUserRoles(
  ctx: APIRequestContext,
  adminToken: string,
  userId: string,
  roles: string[],
): Promise<void> {
  const res = await ctx.patch(`/admin/users/${userId}`, {
    headers: bearer(adminToken),
    data: { roles },
  });
  expect(res.ok(), `PATCH /admin/users/${userId} -> ${res.status()} ${await res.text()}`).toBeTruthy();
}
