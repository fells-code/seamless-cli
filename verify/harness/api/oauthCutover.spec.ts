import { randomUUID } from 'crypto';

import {
  bearer,
  createLegacyProvider,
  enrollPasskey,
  legacySignIn,
  ownerAdminToken,
} from '../lib/cutoverFlows';
import { uniqueEmail } from '../lib/env';
import { expect, test } from '../lib/fixtures';
import { refresh } from '../lib/flows';

// The migration cutover path from fells-code/seamless-auth-api#337, end to end:
// import a user from a directory, sign them in through that directory's OIDC provider
// (linked on the directory id, not the email), send them into passkey enrollment, then
// retire the provider for their organization and roll the retirement back.
test.describe('OAuth migration cutover (api)', () => {
  test('links an imported user, enrolls a passkey, then retires and restores the provider', async ({
    actor,
  }) => {
    const { ctx } = actor;
    const admin = await ownerAdminToken(ctx);
    const source = `verify-${randomUUID().slice(0, 8)}`;
    const providerId = await createLegacyProvider(ctx, admin, source);

    const organization = await ctx.post('/admin/organizations', {
      headers: bearer(admin),
      data: { name: `Cutover ${source}` },
    });
    expect(organization.status(), await organization.text()).toBe(201);
    const organizationId = (await organization.json()).organization.id as string;

    // The directory reports a different address than the one imported, so a link can
    // only have come from the directory id.
    const oid = randomUUID();
    const importedEmail = uniqueEmail('imported');
    const directory = { sub: `legacy-${oid}`, oid, email: uniqueEmail('directory') };

    const imported = await ctx.post('/admin/users/import', {
      headers: bearer(admin),
      data: {
        source,
        users: [{ externalId: oid, email: importedEmail, organizations: [{ organizationId }] }],
      },
    });
    expect(imported.ok(), `import -> ${imported.status()} ${await imported.text()}`).toBeTruthy();
    const [row] = (await imported.json()).results;
    expect(row.status, 'the user is imported').toBe('created');

    await test.step('the first sign-in links the imported user and asks for a passkey', async () => {
      const res = await legacySignIn(ctx, providerId, directory);
      expect(res.status(), await res.text()).toBe(200);
      const body = await res.json();

      expect(body.sub, 'signed in as the imported user').toBe(row.userId);
      expect(body.email, 'the imported address is kept').toBe(importedEmail);
      expect(body.nextStep).toBe('enroll_passkey');

      await enrollPasskey(ctx, body.token);
    });

    const enrolled = await test.step('with a passkey, the prompt stops', async () => {
      const res = await legacySignIn(ctx, providerId, directory);
      expect(res.status(), await res.text()).toBe(200);
      const body = await res.json();

      expect(body.nextStep, 'no further step once a passkey exists').toBeUndefined();
      return body as { token: string; refreshToken: string };
    });

    await test.step('retiring the provider revokes sessions and refuses sign-in', async () => {
      const retired = await ctx.put(
        `/admin/organizations/${organizationId}/oauth-providers/${providerId}/retirement`,
        { headers: bearer(admin) },
      );
      expect(retired.status(), await retired.text()).toBe(200);
      expect((await retired.json()).organization.retiredOAuthProviders).toContain(providerId);

      const me = await ctx.get('/users/me', { headers: bearer(enrolled.token) });
      expect(me.status(), 'the access token stops working').toBe(401);
      const refreshed = await refresh(ctx, enrolled.refreshToken);
      expect(refreshed.status(), 'the refresh token stops working').toBe(401);

      const res = await legacySignIn(ctx, providerId, directory);
      expect(res.status(), await res.text()).toBe(403);
      expect((await res.json()).code).toBe('oauth_provider_retired');
    });

    await test.step('restoring the provider lets the user back in', async () => {
      // Creating the organization made the owner a member, so the retirement revoked
      // the owner's session too.
      const stale = await ctx.get('/users/me', { headers: bearer(admin) });
      expect(stale.status(), 'the retiring admin, a member, was signed out too').toBe(401);
      const freshAdmin = await ownerAdminToken(ctx);

      const restored = await ctx.delete(
        `/admin/organizations/${organizationId}/oauth-providers/${providerId}/retirement`,
        { headers: bearer(freshAdmin) },
      );
      expect(restored.status(), await restored.text()).toBe(200);

      const res = await legacySignIn(ctx, providerId, directory);
      expect(res.status(), await res.text()).toBe(200);
      expect((await res.json()).sub).toBe(row.userId);
    });
  });
});
