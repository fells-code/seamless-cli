import { APIRequestContext, expect } from '@playwright/test';

import { MagicLink, parseMagicLink } from './flows';

// Cookie-based flows against the adapter (baseURL = adapter). The adapter strips
// OTP/magic-link secrets from browser responses, so codes are read from the
// harness adapter app's /__captured readout.

async function readCaptured(
  ctx: APIRequestContext,
  email: string,
): Promise<{ token: string; magicLinkUrl?: string }> {
  const res = await ctx.get(`/__captured/${encodeURIComponent(email)}`);
  expect(res.ok(), `captured lookup -> ${res.status()}`).toBeTruthy();
  const body = await res.json();
  expect(body?.token, `a captured code for ${email}`).toBeTruthy();
  return { token: String(body.token), magicLinkUrl: body.magicLinkUrl };
}

async function readCapturedCode(ctx: APIRequestContext, email: string): Promise<string> {
  return (await readCaptured(ctx, email)).token;
}

/** The magic link the adapter delivered to `email`, split into token and code. */
export async function readCapturedMagicLink(
  ctx: APIRequestContext,
  email: string,
): Promise<MagicLink> {
  const { magicLinkUrl } = await readCaptured(ctx, email);
  expect(magicLinkUrl, `a captured magic link for ${email}`).toBeTruthy();
  return parseMagicLink(magicLinkUrl!);
}

/** Request a magic link for a started login and return the delivered link. */
export async function requestMagicLinkViaAdapter(
  ctx: APIRequestContext,
  email: string,
): Promise<MagicLink> {
  const res = await ctx.post('/auth/magic-link');
  expect(res.ok(), `magic-link request -> ${res.status()}`).toBeTruthy();
  return readCapturedMagicLink(ctx, email);
}

export async function registerAndVerifyEmail(ctx: APIRequestContext, email: string): Promise<void> {
  let res = await ctx.post('/auth/registration/register', { data: { email } });
  expect(res.ok(), `register -> ${res.status()}`).toBeTruthy();

  res = await ctx.post('/auth/otp/generate-email-otp');
  expect(res.ok(), `generate-email-otp -> ${res.status()}`).toBeTruthy();

  const code = await readCapturedCode(ctx, email);
  res = await ctx.post('/auth/otp/verify-email-otp', { data: { verificationToken: code } });
  expect(res.ok(), `verify-email-otp -> ${res.status()}`).toBeTruthy();
}

export async function loginViaEmailOtp(ctx: APIRequestContext, email: string): Promise<void> {
  let res = await ctx.post('/auth/login', { data: { identifier: email } });
  expect(res.ok(), `login -> ${res.status()}`).toBeTruthy();

  res = await ctx.post('/auth/otp/generate-login-email-otp');
  expect(res.ok(), `generate-login-email-otp -> ${res.status()}`).toBeTruthy();

  const code = await readCapturedCode(ctx, email);
  res = await ctx.post('/auth/otp/verify-login-email-otp', { data: { verificationToken: code } });
  expect(res.ok(), `verify-login-email-otp -> ${res.status()}`).toBeTruthy();
}

export async function loginViaMagicLink(ctx: APIRequestContext, email: string): Promise<void> {
  const res = await ctx.post('/auth/login', { data: { identifier: email } });
  expect(res.ok(), `login -> ${res.status()}`).toBeTruthy();

  const { token, code } = await requestMagicLinkViaAdapter(ctx, email);

  // Polling before the link is verified must return 204 (still waiting).
  const pending = await ctx.get('/auth/magic-link/check');
  expect(pending.status(), 'poll before verify is 204').toBe(204);

  // Opening the link never signs in. The adapter forwards the 409 body verbatim, and
  // the pre-auth cookie it forwards marks this as the requesting device.
  const verified = await ctx.get(`/auth/magic-link/verify/${token}`);
  expect(verified.status(), `verify magic link -> ${verified.status()}`).toBe(409);
  const held = await verified.json();
  expect(held.error, 'verify holds the link for confirmation').toBe('confirmation_required');
  expect(held.sameDevice, 'the adapter forwards the requesting attempt').toBe(true);

  const confirmed = await ctx.post(`/auth/magic-link/verify/${token}/confirm`, {
    data: { code },
  });
  expect(confirmed.ok(), `confirm magic link -> ${confirmed.status()}`).toBeTruthy();

  // Polling after confirmation issues the session (device binding must match).
  const completed = await ctx.get('/auth/magic-link/check');
  expect(completed.status(), 'poll after confirm issues a session').toBe(200);
}
