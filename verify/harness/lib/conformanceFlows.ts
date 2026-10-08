import { APIRequestContext, APIResponse, expect } from '@playwright/test';

// Flows for the adapter conformance specs. Unlike adapterFlows.ts they hand back
// the responses, because these specs assert on what the adapter sent (cookies,
// bodies, statuses) and not only on where the flow ended up.

// Adapters answer a refresh token presented again within this window with the
// rotation it already got, so parallel requests from several tabs with one expired
// session all succeed instead of tripping the auth API's reuse detection.
export const REFRESH_REUSE_WINDOW_MS = 5_000;

/**
 * Waits until a refresh token's reuse window has passed.
 *
 * Pings the app's health route while it waits. Node closes an idle keep-alive
 * connection after 5 seconds by default, and Playwright pools connections across
 * request contexts, so a request sent after a silent 6-second wait can land on a
 * socket the app already closed and fail with "socket hang up". Keeping the pool
 * busy leaves the next request a live connection.
 */
export async function waitOutReuseWindow(ctx: APIRequestContext): Promise<void> {
  const until = Date.now() + REFRESH_REUSE_WINDOW_MS + 1_000;

  while (Date.now() < until) {
    await ctx.get('/');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

export const BEARER_TRANSPORT = { 'x-seamless-auth-transport': 'bearer' } as const;

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export async function capturedCode(ctx: APIRequestContext, recipient: string): Promise<string> {
  const res = await ctx.get(`/__captured/${encodeURIComponent(recipient)}`);
  expect(res.ok(), `captured lookup -> ${res.status()}`).toBeTruthy();
  const body = await res.json();
  expect(body?.token, `a captured code for ${recipient}`).toBeTruthy();
  return String(body.token);
}

export interface CookieSignup {
  register: APIResponse;
  sendCode: APIResponse;
  verify: APIResponse;
}

/** Email signup in cookie transport: register, send the code, verify it. */
export async function cookieSignup(ctx: APIRequestContext, email: string): Promise<CookieSignup> {
  const register = await ctx.post('/auth/registration/register', { data: { email } });
  expect(register.ok(), `register -> ${register.status()}`).toBeTruthy();

  const sendCode = await ctx.post('/auth/otp/generate-email-otp');
  expect(sendCode.ok(), `generate-email-otp -> ${sendCode.status()}`).toBeTruthy();

  const code = await capturedCode(ctx, email);
  const verify = await ctx.post('/auth/otp/verify-email-otp', {
    data: { verificationToken: code },
  });
  expect(verify.ok(), `verify-email-otp -> ${verify.status()}`).toBeTruthy();

  return { register, sendCode, verify };
}

export interface BearerSession {
  ephemeral: string;
  token: string;
  refreshToken: string;
  register: APIResponse;
  sendCode: APIResponse;
  verify: APIResponse;
}

/** Email signup in bearer transport, where the client holds every token itself. */
export async function bearerSignup(ctx: APIRequestContext, email: string): Promise<BearerSession> {
  const register = await ctx.post('/auth/registration/register', {
    headers: BEARER_TRANSPORT,
    data: { email },
  });
  expect(register.ok(), `register -> ${register.status()}`).toBeTruthy();
  const ephemeral = (await register.json()).token;
  expect(typeof ephemeral, 'register returns the ephemeral token to a bearer client').toBe(
    'string',
  );

  const sendCode = await ctx.post('/auth/otp/generate-email-otp', {
    headers: { ...BEARER_TRANSPORT, ...bearer(ephemeral) },
  });
  expect(sendCode.ok(), `generate-email-otp -> ${sendCode.status()}`).toBeTruthy();

  const code = await capturedCode(ctx, email);
  const verify = await ctx.post('/auth/otp/verify-email-otp', {
    headers: { ...BEARER_TRANSPORT, ...bearer(ephemeral) },
    data: { verificationToken: code },
  });
  expect(verify.ok(), `verify-email-otp -> ${verify.status()}`).toBeTruthy();

  const body = await verify.json();
  expect(typeof body.token, 'verify returns an access token').toBe('string');
  expect(typeof body.refreshToken, 'verify returns a refresh token').toBe('string');

  return { ephemeral, token: body.token, refreshToken: body.refreshToken, register, sendCode, verify };
}

/** The user id the adapter's session belongs to, read through the adapter. */
export async function currentUserId(ctx: APIRequestContext, headers = {}): Promise<string> {
  const res = await ctx.get('/auth/users/me', { headers });
  expect(res.status(), 'users/me').toBe(200);
  const id = (await res.json())?.user?.id;
  expect(typeof id, 'users/me returns the user id').toBe('string');
  return id;
}
