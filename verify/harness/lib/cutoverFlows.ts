import { randomUUID } from 'crypto';

import { APIRequestContext, expect } from '@playwright/test';

import { MOCK_OIDC_ISSUER } from '../mock-oidc';
import { MOCK_OIDC_PORT, OWNER_EMAIL } from './env';
import { registerEmail, requestEmailOtp, verifyEmailOtp } from './flows';
import { SoftwareAuthenticator } from './softwareAuthenticator';

// Helpers for the migration cutover path (fells-code/seamless-auth-api#337): a legacy
// OIDC provider that links imported users by their directory id, prompts them into
// passkey enrollment, and can be retired per organization.

// The browser origin the stack accepts for WebAuthn (ORIGINS / RPID in the compose file).
const WEBAUTHN_ORIGIN = 'http://localhost:5173';
const REDIRECT_URI = 'http://localhost:5173/oauth/callback';

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * An admin access token. Only OWNER_EMAIL is granted admin at signup, so this signs
 * in as the owner; registering an address that already has an account continues
 * that account, so it works whether or not the owner spec has run first.
 */
export async function ownerAdminToken(ctx: APIRequestContext): Promise<string> {
  const ephemeral = await registerEmail(ctx, OWNER_EMAIL);
  const code = await requestEmailOtp(ctx, ephemeral);
  const res = await verifyEmailOtp(ctx, ephemeral, code);
  expect(res.ok(), `owner sign-in -> ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()).token as string;
}

/** Adds an OIDC provider that verifies the mock's ID tokens and links on `oid`. */
export async function createLegacyProvider(
  ctx: APIRequestContext,
  adminToken: string,
  externalIdSource: string,
): Promise<string> {
  const id = `legacy-${randomUUID().slice(0, 8)}`;
  const res = await ctx.post('/system-config/oauth-providers', {
    headers: bearer(adminToken),
    data: {
      id,
      name: 'Legacy IdP',
      enabled: true,
      clientId: `${id}-client`,
      clientSecretEnv: 'MOCK_CLIENT_SECRET',
      authorizationUrl: `http://localhost:${MOCK_OIDC_PORT}/authorize`,
      tokenUrl: `http://host.docker.internal:${MOCK_OIDC_PORT}/token`,
      userInfoUrl: `http://host.docker.internal:${MOCK_OIDC_PORT}/userinfo`,
      scopes: ['openid', 'email'],
      redirectUri: REDIRECT_URI,
      redirectUris: [REDIRECT_URI],
      // Only imported users get in: a sign-in that matches nobody is refused.
      allowSignup: false,
      accountLinking: 'email',
      issuer: MOCK_OIDC_ISSUER,
      jwksUri: `http://host.docker.internal:${MOCK_OIDC_PORT}/jwks`,
      externalIdSource,
      externalIdJsonPath: 'oid',
      promptPasskeyEnrollment: true,
    },
  });
  expect(res.status(), `create provider -> ${res.status()} ${await res.text()}`).toBe(201);
  return id;
}

export interface LegacyProfile {
  sub: string;
  oid: string;
  email: string;
}

/**
 * Signs in through the legacy provider as a given directory user, returning the raw
 * callback response so a spec can assert refusals as well as sessions.
 */
export async function legacySignIn(
  ctx: APIRequestContext,
  providerId: string,
  profile: LegacyProfile,
) {
  const start = await ctx.post(`/oauth/${providerId}/start`, {
    data: { redirectUri: REDIRECT_URI },
  });
  expect(start.ok(), `oauth start -> ${start.status()} ${await start.text()}`).toBeTruthy();

  const authorizationUrl = new URL((await start.json()).authorizationUrl);
  authorizationUrl.searchParams.set('mock_sub', profile.sub);
  authorizationUrl.searchParams.set('mock_oid', profile.oid);
  authorizationUrl.searchParams.set('mock_email', profile.email);

  const authorize = await ctx.get(authorizationUrl.toString(), { maxRedirects: 0 });
  expect(authorize.status(), 'authorize redirects with a code').toBe(302);
  const redirected = new URL(authorize.headers()['location']);

  return ctx.post(`/oauth/${providerId}/callback`, {
    data: {
      code: redirected.searchParams.get('code'),
      state: redirected.searchParams.get('state'),
    },
  });
}

/** Enrolls a passkey on the account the access token belongs to. */
export async function enrollPasskey(ctx: APIRequestContext, accessToken: string): Promise<void> {
  const start = await ctx.get('/webAuthn/register/start', { headers: bearer(accessToken) });
  expect(start.ok(), `register start -> ${start.status()} ${await start.text()}`).toBeTruthy();
  const options = await start.json();

  const attestationResponse = new SoftwareAuthenticator().register({
    challenge: options.challenge,
    origin: WEBAUTHN_ORIGIN,
    rpId: options.rp.id,
  });

  const finish = await ctx.post('/webAuthn/register/finish', {
    headers: bearer(accessToken),
    data: {
      attestationResponse,
      metadata: {
        friendlyName: 'verify harness',
        platform: 'node',
        browser: 'none',
        deviceInfo: 'software authenticator',
      },
    },
  });
  expect(finish.ok(), `register finish -> ${finish.status()} ${await finish.text()}`).toBeTruthy();
}
