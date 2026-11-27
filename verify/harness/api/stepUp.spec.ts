import { expect, test } from '../lib/fixtures';
import { login, registerAndVerifyEmail, verifyLoginEmailOtp } from '../lib/flows';
import { totp } from '../lib/totp';

test.describe('step-up (api)', () => {
  test('TOTP MFA freshens the session step-up status', async ({ actor }) => {
    const registered = await registerAndVerifyEmail(actor.ctx, actor.email);
    const enrolling = { Authorization: `Bearer ${registered.token}` };

    // Enroll TOTP (enrollment alone must not satisfy step-up).
    const start = await actor.ctx.post('/totp/enroll/start', { headers: enrolling, data: {} });
    expect(start.ok(), `enroll/start -> ${start.status()}`).toBeTruthy();
    const { secret } = await start.json();
    const enroll = await actor.ctx.post('/totp/enroll/verify', {
      headers: enrolling,
      data: { code: totp(secret) },
    });
    expect(enroll.ok(), `enroll/verify -> ${enroll.status()}`).toBeTruthy();

    // A step-up only accepts a factor enrolled before the session signed in, so the
    // TOTP proves the holder of the next session, not the one that added it.
    const token = await verifyLoginEmailOtp(actor.ctx, await login(actor.ctx, actor.email));
    const auth = { Authorization: `Bearer ${token}` };

    const before = await actor.ctx.get('/step-up/status', { headers: auth });
    expect(before.ok()).toBeTruthy();
    expect((await before.json()).fresh, 'step-up is not fresh before MFA').toBe(false);

    // Verifying TOTP MFA records a step-up. Use the next window's code: the API
    // rejects a code whose counter is not strictly greater than the last used one
    // (enrollment just consumed the current window), and accepts up to +1 of skew.
    const mfa = await actor.ctx.post('/totp/verify-mfa', {
      headers: auth,
      data: { code: totp(secret, Date.now() + 30_000) },
    });
    expect(mfa.ok(), `verify-mfa -> ${mfa.status()} ${await mfa.text()}`).toBeTruthy();
    const mfaBody = await mfa.json();
    expect(mfaBody.fresh, 'verify-mfa returns a fresh step-up').toBe(true);
    expect(mfaBody.method, 'step-up method is totp').toBe('totp');

    const after = await actor.ctx.get('/step-up/status', { headers: auth });
    expect((await after.json()).fresh, 'step-up is fresh after MFA').toBe(true);
  });
});
