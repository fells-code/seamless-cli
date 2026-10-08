import { expect, test } from '../lib/fixtures';

// Clients branch on the auth API's status codes and error bodies, so an adapter must
// pass them through rather than reshape them.
test.describe('error passthrough (adapter)', () => {
  test('a validation failure keeps its status and body', async ({ adapterActor }) => {
    const res = await adapterActor.ctx.post('/auth/login', { data: {} });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error, 'the API error code').toBe('invalid_request');
    expect(Array.isArray(body.details?.issues), 'the field-level detail').toBe(true);
  });

  test('a request with no session answers 401', async ({ adapterActor }) => {
    const res = await adapterActor.ctx.get('/auth/users/me');

    expect(res.status()).toBe(401);
    expect(typeof (await res.json()).error, 'an error code to branch on').toBe('string');
  });

  test('a route neither the adapter nor the API serves answers 404', async ({ adapterActor }) => {
    expect((await adapterActor.ctx.get('/auth/no-such-route')).status()).toBe(404);
  });
});
