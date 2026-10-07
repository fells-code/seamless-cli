import { expect, test } from '../lib/fixtures';

test.describe('JWKS (api)', () => {
  test('publishes the active signing key as a JWK', async ({ actor }) => {
    const res = await actor.ctx.get('/.well-known/jwks.json');
    expect(res.status(), 'JWKS endpoint is available').toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.keys), 'has a keys array').toBeTruthy();

    // The kid is not a contract: older dev images publish the constant `dev-main`,
    // newer ones derive it from the key's thumbprint, so a regenerated key gets a
    // new one. Find the signing key by what it is, not by what it is called.
    const signingKeys = body.keys.filter(
      (k: { use?: string; alg?: string }) => k.use === 'sig' && k.alg === 'RS256',
    );
    expect(signingKeys.length, 'publishes an RS256 signing key').toBeGreaterThan(0);

    for (const key of signingKeys) {
      expect(key.kty).toBe('RSA');
      expect(key.kid, 'each signing key has a dev kid').toMatch(/^dev-.+/);
    }
  });
});
