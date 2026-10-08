import { recordedEvents } from '../lib/authEvents';
import { cookieSignup, currentUserId } from '../lib/conformanceFlows';
import { expect, test } from '../lib/fixtures';

// The auth API attributes rate limits, audit events and device classes to the
// browser, not to the adopter's server, only if the adapter forwards the client's
// address and user agent. Read back from what the API recorded.
test.describe('client forwarding (adapter, cookies)', () => {
  test('the API records the browser address and user agent', async ({ adapterActor, actor }) => {
    await cookieSignup(adapterActor.ctx, adapterActor.email);
    const userId = await currentUserId(adapterActor.ctx);

    const events = await recordedEvents(actor.ctx, userId);
    expect(events.length, 'events were recorded for the user').toBeGreaterThan(0);

    expect(
      events.some((event) => event.ip_address === adapterActor.clientIp),
      `an event from ${adapterActor.clientIp}`,
    ).toBe(true);
    expect(
      events.some((event) => event.user_agent === adapterActor.userAgent),
      `an event from ${adapterActor.userAgent}`,
    ).toBe(true);
  });
});
