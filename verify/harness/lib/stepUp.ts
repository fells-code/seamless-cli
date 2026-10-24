import { APIRequestContext, expect } from '@playwright/test';

import { OWNER_EMAIL } from './env';
import { SoftwareAuthenticator } from './softwareAuthenticator';

// The browser origin the stack accepts for WebAuthn (ORIGINS / RPID in the compose file).
export const WEBAUTHN_ORIGIN = 'http://localhost:5173';

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Enrolls `authenticator` as a passkey on the signed-in account. */
export async function registerPasskey(
  ctx: APIRequestContext,
  accessToken: string,
  authenticator: SoftwareAuthenticator,
): Promise<void> {
  const start = await ctx.get('/webAuthn/register/start', { headers: bearer(accessToken) });
  expect(start.ok(), `register start -> ${start.status()} ${await start.text()}`).toBeTruthy();
  const options = await start.json();

  const finish = await ctx.post('/webAuthn/register/finish', {
    headers: bearer(accessToken),
    data: {
      attestationResponse: authenticator.register({
        challenge: options.challenge,
        origin: WEBAUTHN_ORIGIN,
        rpId: options.rp.id,
      }),
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

/**
 * Freshens the owner session's step-up, which admin writes require. Uses one passkey
 * derived from OWNER_EMAIL, enrolled the first time it is needed.
 */
export async function stepUpOwner(ctx: APIRequestContext, accessToken: string): Promise<void> {
  const authenticator = new SoftwareAuthenticator(`verify-owner:${OWNER_EMAIL}`);

  const begin = async () => {
    const res = await ctx.post('/step-up/webauthn/start', {
      headers: bearer(accessToken),
      data: {},
    });
    if (res.status() === 401) return null;
    expect(res.ok(), `step-up start -> ${res.status()} ${await res.text()}`).toBeTruthy();
    const options = await res.json();
    const enrolled = (options.allowCredentials ?? []).some(
      (credential: { id: string }) => credential.id === authenticator.id,
    );
    return enrolled ? options : null;
  };

  let options = await begin();
  if (!options) {
    await registerPasskey(ctx, accessToken, authenticator);
    options = await begin();
  }
  expect(options, 'step-up offers the owner passkey').toBeTruthy();

  const finish = await ctx.post('/step-up/webauthn/finish', {
    headers: bearer(accessToken),
    data: {
      assertionResponse: authenticator.authenticate({
        challenge: options.challenge,
        origin: WEBAUTHN_ORIGIN,
        rpId: options.rpId,
      }),
    },
  });
  expect(finish.ok(), `step-up finish -> ${finish.status()} ${await finish.text()}`).toBeTruthy();
}
