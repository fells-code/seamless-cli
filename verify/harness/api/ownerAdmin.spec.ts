import { OWNER_EMAIL } from '../lib/env';
import { expect, test } from '../lib/fixtures';
import { ownerSession } from '../lib/flows';

test.describe('owner admin (api)', () => {
  // The owner address is fixed in the stack's OWNER_EMAIL before boot, so this spec
  // uses that exact email rather than the actor fixture's random one. Another spec may
  // have registered it already, so it signs in when the account exists.
  test('the owner email is granted the admin role', async ({ actor }) => {
    const { token, roles } = await ownerSession(actor.ctx, OWNER_EMAIL);
    expect(token, 'session access token').toBeTruthy();
    expect(
      roles.includes('admin'),
      `the owner holds the admin role (got ${JSON.stringify(roles)})`,
    ).toBeTruthy();
  });
});
