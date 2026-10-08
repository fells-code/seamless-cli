import { randomUUID } from 'crypto';

import { APIRequestContext, request as playwrightRequest } from '@playwright/test';

import { ADAPTER_URL, API_SERVICE_TOKEN, API_URL, uniqueClientIp, uniqueEmail } from './env';
import { mintServiceToken } from './serviceToken';

export interface Actor {
  email: string;
  ctx: APIRequestContext;
  dispose: () => Promise<void>;
}

// An actor is one virtual user: a fresh request context bound to the API, with
// its own client IP + service token applied to every request. This both isolates
// rate-limit buckets and faithfully mirrors how the server adapter calls the API.
export async function newApiActor(prefix = 'verify'): Promise<Actor> {
  const ctx = await playwrightRequest.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: {
      'x-seamless-client-ip': uniqueClientIp(),
      'x-seamless-service-token': `Bearer ${mintServiceToken(API_SERVICE_TOKEN)}`,
    },
  });

  return { email: uniqueEmail(prefix), ctx, dispose: () => ctx.dispose() };
}

// A browser-like actor for the cookie path: a context bound to an adapter that
// persists cookies across requests (the adapter handles service tokens internally).
// `baseURL` selects which adapter, so the same specs drive every adapter.
//
// Each actor arrives through one proxy hop with its own X-Forwarded-For and
// User-Agent. Reference apps trust exactly that hop, so the adapter forwards them
// upstream: the actor gets its own rate-limit bucket, and a spec can find what the
// API recorded for it.
export async function newAdapterActor(
  baseURL: string = ADAPTER_URL,
  prefix = 'verify',
): Promise<AdapterActor> {
  const clientIp = uniqueClientIp();
  const userAgent = `seamless-conformance/${randomUUID()}`;
  const ctx = await playwrightRequest.newContext({
    baseURL,
    userAgent,
    extraHTTPHeaders: { 'x-forwarded-for': clientIp },
  });

  return { email: uniqueEmail(prefix), ctx, clientIp, userAgent, dispose: () => ctx.dispose() };
}

export interface AdapterActor extends Actor {
  clientIp: string;
  userAgent: string;
}
