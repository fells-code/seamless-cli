import { APIRequestContext, expect } from '@playwright/test';

import { OWNER_EMAIL } from './env';
import { ownerAccessToken } from './flows';

export interface RecordedEvent {
  type: string;
  ip_address?: string | null;
  user_agent?: string | null;
}

// What the auth API recorded for a user, read through its admin API as the tenant
// owner. This is how the suite sees what an adapter sent upstream without looking
// inside the adapter.
export async function recordedEvents(
  apiCtx: APIRequestContext,
  userId: string,
): Promise<RecordedEvent[]> {
  const token = await ownerAccessToken(apiCtx, OWNER_EMAIL);
  const res = await apiCtx.get('/admin/auth-events', {
    headers: { Authorization: `Bearer ${token}` },
    params: { userId, limit: 100 },
  });

  expect(res.ok(), `admin auth-events -> ${res.status()}`).toBeTruthy();
  return (await res.json()).events as RecordedEvent[];
}
