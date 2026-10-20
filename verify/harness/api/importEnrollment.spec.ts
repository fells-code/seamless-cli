import { randomUUID } from 'crypto';

import { bearer, ownerAdminToken } from '../lib/cutoverFlows';
import { EXTERNAL_DELIVERY, uniqueEmail } from '../lib/env';
import { expect, test } from '../lib/fixtures';
import { registerAndVerifyEmail } from '../lib/flows';

// Moving an organization onto Seamless: import its people from another system, then
// invite them to sign in and add a passkey. Imports carry no credentials, so the
// invite is how an imported user finds out they have an account.
test.describe('import to enrollment (api)', () => {
  test('imports an organization, invites it to enroll, and the first sign-in continues the import', async ({
    actor,
  }) => {
    const { ctx } = actor;
    const admin = await ownerAdminToken(ctx);
    const source = `verify-${randomUUID().slice(0, 8)}`;

    const organization = await ctx.post('/admin/organizations', {
      headers: bearer(admin),
      data: { name: `Import ${source}` },
    });
    expect(organization.status(), await organization.text()).toBe(201);
    const organizationId = (await organization.json()).organization.id as string;

    const people = [
      { externalId: `emp-${randomUUID()}`, email: uniqueEmail('import-a') },
      { externalId: `emp-${randomUUID()}`, email: uniqueEmail('import-b') },
    ];
    const importBatch = (dryRun: boolean) =>
      ctx.post('/admin/users/import', {
        headers: bearer(admin),
        data: {
          source,
          dryRun,
          users: people.map((person) => ({ ...person, organizations: [{ organizationId }] })),
        },
      });

    const userIds = await test.step('a dry run writes nothing, then the import creates both', async () => {
      const dry = await importBatch(true);
      expect(dry.ok(), `dry run -> ${dry.status()} ${await dry.text()}`).toBeTruthy();
      expect((await dry.json()).summary).toMatchObject({ created: 2, rejected: 0 });

      const afterDry = await ctx.get(
        `/admin/enrollment?organizationId=${organizationId}&imported=true`,
        { headers: bearer(admin) },
      );
      expect(afterDry.ok(), await afterDry.text()).toBeTruthy();
      expect((await afterDry.json()).summary.total, 'the dry run created no one').toBe(0);

      const applied = await importBatch(false);
      expect(applied.ok(), `import -> ${applied.status()} ${await applied.text()}`).toBeTruthy();
      const body = await applied.json();
      expect(body.summary).toMatchObject({ created: 2, rejected: 0 });
      return (body.results as Array<{ userId: string }>).map((row) => row.userId);
    });

    await test.step('re-running the same import changes nothing', async () => {
      const again = await importBatch(false);
      expect(again.ok(), await again.text()).toBeTruthy();
      expect((await again.json()).summary).toMatchObject({ unchanged: 2, created: 0, updated: 0 });
    });

    await test.step('the enrollment report shows both imported, with no passkey and no invite', async () => {
      const res = await ctx.get(
        `/admin/enrollment?organizationId=${organizationId}&imported=true`,
        { headers: bearer(admin) },
      );
      expect(res.ok(), await res.text()).toBeTruthy();
      const body = await res.json();
      expect(body.summary).toMatchObject({ total: 2, none: 2 });
      for (const user of body.users) {
        expect(user.imported).toBe(true);
        expect(user.status).toBe('none');
        expect(user.enrollmentInvitedAt).toBeNull();
      }
    });

    await test.step('an organization-wide invite reaches every member without a passkey', async () => {
      // The admin who created the organization is a member too, and is invited if they
      // have no passkey either, so the expected set comes from the report.
      const report = await ctx.get(`/admin/enrollment?organizationId=${organizationId}&status=none`, {
        headers: bearer(admin),
      });
      const expected = ((await report.json()).users as Array<{ email: string }>)
        .map((user) => user.email)
        .sort();
      for (const person of people) expect(expected).toContain(person.email);

      const res = await ctx.post('/admin/enrollment/invites', {
        headers: { ...bearer(admin), ...EXTERNAL_DELIVERY },
        data: { organizationId },
      });
      expect(res.ok(), `invite -> ${res.status()} ${await res.text()}`).toBeTruthy();
      const body = await res.json();
      expect(body).toMatchObject({ sent: expected.length, skipped: 0, remaining: 0 });

      const deliveries = body.results.map((result: { delivery: unknown }) => result.delivery);
      expect(deliveries.map((d: { to: string }) => d.to).sort()).toEqual(expected);
      for (const delivery of deliveries) {
        expect(delivery.kind).toBe('enrollment_invite_email');
        expect(new URL(delivery.signInUrl).pathname).toBe('/login');
        // The invite is a pointer to the sign-in page, never a credential.
        expect(new URL(delivery.signInUrl).search).toBe('');
      }
    });

    await test.step('a second invite the same day is held back', async () => {
      const res = await ctx.post('/admin/enrollment/invites', {
        headers: { ...bearer(admin), ...EXTERNAL_DELIVERY },
        data: { userIds },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
      const body = await res.json();
      expect(body).toMatchObject({ sent: 0, skipped: 2 });
      for (const result of body.results) {
        expect(result.reason).toBe('recently_invited');
      }

      const report = await ctx.get(
        `/admin/enrollment?organizationId=${organizationId}&imported=true`,
        { headers: bearer(admin) },
      );
      for (const user of (await report.json()).users) {
        expect(user.enrollmentInvitedAt, 'the invite is recorded').not.toBeNull();
      }
    });

    await test.step('registering with the imported address continues the imported account', async () => {
      const session = await registerAndVerifyEmail(ctx, people[0].email);
      expect(session.sub, 'signed in as the imported user').toBe(userIds[0]);

      const members = await ctx.get(`/admin/organizations/${organizationId}/members`, {
        headers: bearer(admin),
      });
      expect(members.ok(), await members.text()).toBeTruthy();
      const ids = JSON.stringify(await members.json());
      expect(ids, 'the imported membership is kept').toContain(userIds[0]);
    });
  });
});
