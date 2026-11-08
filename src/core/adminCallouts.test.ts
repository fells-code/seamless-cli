import { describe, expect, it } from "vitest";
import type { AuthClient } from "./authClient.js";
import type { ApiResponse } from "./http.js";
import {
  AdminApiError,
  AUDIT_SINKS_UNSUPPORTED_MESSAGE,
  createAuditSink,
  createWebhook,
  CUSTOM_CLAIMS_UNSUPPORTED_MESSAGE,
  deleteAuditSink,
  deleteCustomClaims,
  deleteLoginHook,
  deleteWebhook,
  getAuditSink,
  getCustomClaims,
  getWebhook,
  getWebhookDelivery,
  listAuditSinks,
  listCustomClaims,
  listLoginHookInvocations,
  listLoginHooks,
  listWebhookDeliveries,
  listWebhooks,
  LOGIN_HOOKS_UNSUPPORTED_MESSAGE,
  redeliverWebhook,
  rotateLoginHookSecret,
  rotateWebhookSecret,
  setCustomClaims,
  setLoginHook,
  testAuditSink,
  testLoginHook,
  testWebhook,
  updateAuditSink,
  updateWebhook,
  WEBHOOKS_UNSUPPORTED_MESSAGE,
} from "./admin.js";
import { StepUpError } from "./stepUp.js";
import {
  apiAuditSink,
  apiClaimSource,
  apiDelivery,
  apiInvocation,
  apiLoginHook,
  apiWebhook,
  DELIVERY_ID,
  SECRET,
  SINK_ID,
  WEBHOOK_ID,
} from "./admin.fixtures.js";

function response<T>(status: number, data: T | null): ApiResponse<T> {
  return { ok: status >= 200 && status < 300, status, data, headers: new Headers() };
}

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

function fakeClient(
  handler: (rec: Recorded) => ApiResponse<unknown>,
): { client: AuthClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const record = (method: string, path: string, init?: RequestInit) => {
    const rec: Recorded = {
      method,
      path,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(rec);
    return handler(rec);
  };
  return {
    calls,
    client: {
      profile: { name: "default", instanceUrl: "https://auth.example.com" },
      get: async (path) => record("GET", path) as never,
      post: async (path) => record("POST", path) as never,
      request: async (path, init) =>
        record((init?.method ?? "GET").toUpperCase(), path, init) as never,
    },
  };
}

// What an instance from before v0.23 answers for a route it does not have.
const routeMissing = () => response(404, { error: "Not Found" });

async function message(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdminApiError);
  return (err as Error).message;
}

const TEST_OK = { ok: true, failure: null, statusCode: 200, durationMs: 12 };

describe("webhooks", () => {
  it("lists endpoints, keeping an event type this CLI does not know", async () => {
    const { client, calls } = fakeClient(() =>
      response(200, { endpoints: [apiWebhook({ eventTypes: ["user.future"] })] }),
    );
    const endpoints = await listWebhooks(client);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/admin/webhooks" });
    expect(endpoints[0].eventTypes).toEqual(["user.future"]);
  });

  it("creates an endpoint and returns the secret", async () => {
    const { client, calls } = fakeClient(() =>
      response(201, { endpoint: apiWebhook(), secret: SECRET }),
    );
    const created = await createWebhook(client, {
      url: "https://hooks.example.com/seamless",
      eventTypes: ["user.created"],
    });
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/admin/webhooks",
      body: { url: "https://hooks.example.com/seamless", eventTypes: ["user.created"] },
    });
    expect(created.secret).toBe(SECRET);
  });

  it("refuses a created response without a well-formed secret", async () => {
    const { client } = fakeClient(() =>
      response(201, { endpoint: apiWebhook(), secret: "plain" }),
    );
    expect(
      await message(createWebhook(client, { url: "https://x.example", eventTypes: ["user.created"] })),
    ).toContain("cannot read");
  });

  it("spells out the fields a 400 names", async () => {
    const { client } = fakeClient(() =>
      response(400, {
        error: "invalid_request",
        message: "Request failed schema validation.",
        details: {
          issues: [
            { path: ["url"], code: "custom", message: "must use https" },
            { path: [], code: "custom", message: "nothing to update" },
            "junk",
            { path: ["x"] },
          ],
        },
      }),
    );
    expect(await message(updateWebhook(client, WEBHOOK_ID, { enabled: true }))).toBe(
      "Could not update webhook (400: invalid_request), url must use https; nothing to update.",
    );
  });

  it("reports a 400 or 409 without issues as it came", async () => {
    const { client } = fakeClient(() =>
      response(409, {
        error: "CALLOUT_SECRET_ENCRYPTION_KEY must be set before a webhook can be created",
      }),
    );
    expect(
      await message(createWebhook(client, { url: "https://x.example", eventTypes: ["user.created"] })),
    ).toBe(
      "Could not create webhook (409: CALLOUT_SECRET_ENCRYPTION_KEY must be set before a webhook can be created).",
    );

    const empty = fakeClient(() => response(400, { error: "bad", details: { issues: ["x"] } }));
    expect(await message(updateWebhook(empty.client, WEBHOOK_ID, { enabled: true }))).toBe(
      "Could not update webhook (400: bad).",
    );
  });

  it("gets, updates, deletes, rotates and tests by encoded id", async () => {
    const { client, calls } = fakeClient((rec) => {
      if (rec.path.endsWith("/secret")) {
        return response(200, { secret: SECRET, previousSecretExpiresAt: "2026-07-14T10:00:00.000Z" });
      }
      if (rec.path.endsWith("/test")) return response(200, TEST_OK);
      if (rec.method === "DELETE") return response(200, { message: "Webhook deleted" });
      return response(200, { endpoint: apiWebhook() });
    });
    await getWebhook(client, WEBHOOK_ID);
    await updateWebhook(client, WEBHOOK_ID, { enabled: false });
    await deleteWebhook(client, WEBHOOK_ID);
    const rotated = await rotateWebhookSecret(client, WEBHOOK_ID);
    const tested = await testWebhook(client, WEBHOOK_ID);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /admin/webhooks/${WEBHOOK_ID}`,
      `PATCH /admin/webhooks/${WEBHOOK_ID}`,
      `DELETE /admin/webhooks/${WEBHOOK_ID}`,
      `POST /admin/webhooks/${WEBHOOK_ID}/secret`,
      `POST /admin/webhooks/${WEBHOOK_ID}/test`,
    ]);
    expect(calls[1].body).toEqual({ enabled: false });
    expect(rotated.secret).toBe(SECRET);
    expect(tested.ok).toBe(true);

    const odd = fakeClient(() => response(200, { endpoint: apiWebhook() }));
    await getWebhook(odd.client, "a/b");
    expect(odd.calls[0].path).toBe("/admin/webhooks/a%2Fb");
  });

  it("names a missing endpoint on every per-id route", async () => {
    const { client } = fakeClient(() => response(404, { error: "Webhook not found" }));
    const expected = `No webhook found with id ${WEBHOOK_ID} (404: Webhook not found).`;
    expect(await message(getWebhook(client, WEBHOOK_ID))).toBe(expected);
    expect(await message(updateWebhook(client, WEBHOOK_ID, { enabled: true }))).toBe(expected);
    expect(await message(deleteWebhook(client, WEBHOOK_ID))).toBe(expected);
    expect(await message(rotateWebhookSecret(client, WEBHOOK_ID))).toBe(expected);
    expect(await message(testWebhook(client, WEBHOOK_ID))).toBe(expected);
  });

  it("reports any other failure on every webhook route", async () => {
    const { client } = fakeClient(() => response(500, null));
    expect(await message(listWebhooks(client))).toBe("Could not list webhooks (500).");
    expect(await message(getWebhook(client, WEBHOOK_ID))).toBe("Could not load webhook (500).");
    expect(await message(deleteWebhook(client, WEBHOOK_ID))).toBe("Could not delete webhook (500).");
    expect(await message(rotateWebhookSecret(client, WEBHOOK_ID))).toBe(
      "Could not rotate the webhook secret (500).",
    );
    expect(await message(testWebhook(client, WEBHOOK_ID))).toBe(
      "Could not send a test event (500).",
    );
    expect(await message(listWebhookDeliveries(client))).toBe(
      "Could not list webhook deliveries (500).",
    );
    expect(await message(getWebhookDelivery(client, DELIVERY_ID))).toBe(
      "Could not load delivery (500).",
    );
    expect(await message(redeliverWebhook(client, DELIVERY_ID))).toBe("Could not redeliver (500).");
  });

  it("lists deliveries with only the filters given", async () => {
    const { client, calls } = fakeClient(() =>
      response(200, { deliveries: [apiDelivery({ eventType: "webhook.test" })], nextCursor: "c2" }),
    );
    const page = await listWebhookDeliveries(client);
    expect(calls[0].path).toBe("/admin/webhook-deliveries");
    expect(page.nextCursor).toBe("c2");

    await listWebhookDeliveries(client, {
      endpointId: WEBHOOK_ID,
      status: "dead",
      eventType: "user.created",
      limit: 10,
      cursor: "a b",
    });
    expect(calls[1].path).toBe(
      `/admin/webhook-deliveries?endpointId=${WEBHOOK_ID}&status=dead&eventType=user.created&limit=10&cursor=a+b`,
    );
  });

  it("gets and redelivers a delivery with its event", async () => {
    const event = { id: "e1", type: "user.created", version: 1, timestamp: "t", data: {} };
    const { client, calls } = fakeClient(() =>
      response(200, { delivery: { ...apiDelivery({ status: "succeeded" }), event } }),
    );
    expect((await getWebhookDelivery(client, DELIVERY_ID)).event).toEqual(event);
    await redeliverWebhook(client, DELIVERY_ID);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /admin/webhook-deliveries/${DELIVERY_ID}`,
      `POST /admin/webhook-deliveries/${DELIVERY_ID}/redeliver`,
    ]);
  });

  it("names a missing delivery", async () => {
    const { client } = fakeClient(() => response(404, { error: "Delivery not found" }));
    const expected = `No delivery found with id ${DELIVERY_ID} (404: Delivery not found).`;
    expect(await message(getWebhookDelivery(client, DELIVERY_ID))).toBe(expected);
    expect(await message(redeliverWebhook(client, DELIVERY_ID))).toBe(expected);
  });

  it("says an instance before v0.23 has no webhooks", async () => {
    const { client } = fakeClient(routeMissing);
    for (const attempt of [
      () => listWebhooks(client),
      () => getWebhook(client, WEBHOOK_ID),
      () => createWebhook(client, { url: "https://x.example", eventTypes: ["user.created"] }),
      () => updateWebhook(client, WEBHOOK_ID, { enabled: true }),
      () => deleteWebhook(client, WEBHOOK_ID),
      () => rotateWebhookSecret(client, WEBHOOK_ID),
      () => testWebhook(client, WEBHOOK_ID),
      () => listWebhookDeliveries(client),
      () => getWebhookDelivery(client, DELIVERY_ID),
      () => redeliverWebhook(client, DELIVERY_ID),
    ]) {
      expect(await message(attempt())).toBe(WEBHOOKS_UNSUPPORTED_MESSAGE);
    }
  });
});

describe("login hooks", () => {
  it("lists hooks", async () => {
    const { client, calls } = fakeClient(() => response(200, { hooks: [apiLoginHook()] }));
    expect(await listLoginHooks(client)).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/admin/login-hooks" });
  });

  it("sets a hook with PUT and returns a secret only when one came", async () => {
    const body = {
      url: "https://hooks.example.com/login",
      timeoutMs: 2000,
      failureMode: "closed" as const,
      enabled: true,
    };
    const created = fakeClient(() => response(201, { hook: apiLoginHook(), secret: SECRET }));
    expect((await setLoginHook(created.client, "post_login", body)).secret).toBe(SECRET);
    expect(created.calls[0]).toEqual({ method: "PUT", path: "/admin/login-hooks/post_login", body });

    const replaced = fakeClient(() => response(200, { hook: apiLoginHook() }));
    expect((await setLoginHook(replaced.client, "post_login", body)).secret).toBeUndefined();

    const refused = fakeClient(() => response(400, { error: "url must use https" }));
    expect(await message(setLoginHook(refused.client, "pre_token", body))).toBe(
      "Could not set the pre_token hook (400: url must use https).",
    );
  });

  it("deletes, rotates, tests and lists invocations by trigger", async () => {
    const { client, calls } = fakeClient((rec) => {
      if (rec.path.endsWith("/secret")) {
        return response(200, { secret: SECRET, previousSecretExpiresAt: "x" });
      }
      if (rec.path.endsWith("/test")) return response(200, { ...TEST_OK, failure: "future_reason" });
      if (rec.path.includes("/invocations")) {
        return response(200, { invocations: [apiInvocation()] });
      }
      return response(200, { message: "Login hook deleted" });
    });
    await deleteLoginHook(client, "pre_token");
    await rotateLoginHookSecret(client, "pre_token");
    expect((await testLoginHook(client, "pre_token")).failure).toBe("future_reason");
    await listLoginHookInvocations(client, "pre_token");
    await listLoginHookInvocations(client, "pre_token", { limit: 5, outcome: "denied" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /admin/login-hooks/pre_token",
      "POST /admin/login-hooks/pre_token/secret",
      "POST /admin/login-hooks/pre_token/test",
      "GET /admin/login-hooks/pre_token/invocations",
      "GET /admin/login-hooks/pre_token/invocations?limit=5&outcome=denied",
    ]);
  });

  it("names a hook that is not set", async () => {
    const { client } = fakeClient(() => response(404, { error: "Login hook not found" }));
    const expected = "No post_login hook is set (404: Login hook not found).";
    expect(await message(deleteLoginHook(client, "post_login"))).toBe(expected);
    expect(await message(rotateLoginHookSecret(client, "post_login"))).toBe(expected);
    expect(await message(testLoginHook(client, "post_login"))).toBe(expected);
  });

  it("reports any other failure on every hook route", async () => {
    const { client } = fakeClient(() => response(500, null));
    expect(await message(listLoginHooks(client))).toBe("Could not list login hooks (500).");
    expect(await message(deleteLoginHook(client, "post_login"))).toBe(
      "Could not delete the post_login hook (500).",
    );
    expect(await message(rotateLoginHookSecret(client, "post_login"))).toBe(
      "Could not rotate the post_login hook secret (500).",
    );
    expect(await message(testLoginHook(client, "post_login"))).toBe(
      "Could not test the post_login hook (500).",
    );
    expect(await message(listLoginHookInvocations(client, "post_login"))).toBe(
      "Could not list post_login hook invocations (500).",
    );
  });

  it("says an instance before v0.23 has no login hooks", async () => {
    const { client } = fakeClient(routeMissing);
    const body = { url: "https://x.example", timeoutMs: 2000, failureMode: "open" as const, enabled: true };
    for (const attempt of [
      () => listLoginHooks(client),
      () => setLoginHook(client, "post_login", body),
      () => deleteLoginHook(client, "post_login"),
      () => rotateLoginHookSecret(client, "post_login"),
      () => testLoginHook(client, "post_login"),
      () => listLoginHookInvocations(client, "post_login"),
    ]) {
      expect(await message(attempt())).toBe(LOGIN_HOOKS_UNSUPPORTED_MESSAGE);
    }
  });
});

describe("custom claims", () => {
  const listed = {
    sources: [apiClaimSource()],
    reservedNames: ["sub"],
    reservedPrefixes: ["seamless_"],
    budgetBytes: 1024,
  };

  it("lists sources with the budget", async () => {
    const { client, calls } = fakeClient(() => response(200, listed));
    expect((await listCustomClaims(client)).budgetBytes).toBe(1024);
    expect(calls[0].path).toBe("/admin/custom-claims");
  });

  it("gets a source, or nothing when it has no claims", async () => {
    const { client, calls } = fakeClient(() => response(200, { source: apiClaimSource() }));
    expect(await getCustomClaims(client, "organization_role", "billing")).toMatchObject({
      claims: { tier: "gold" },
    });
    expect(calls[0].path).toBe("/admin/custom-claims/organization_role/billing");

    const none = fakeClient(() => response(404, { error: "Custom claims not found" }));
    expect(await getCustomClaims(none.client, "oidc_client", "a/b")).toBeUndefined();
    expect(none.calls[0].path).toBe("/admin/custom-claims/oidc_client/a%2Fb");
  });

  it("sets the whole set with PUT", async () => {
    const { client, calls } = fakeClient(() => response(200, { source: apiClaimSource() }));
    await setCustomClaims(client, "instance_role", "support", { tier: "gold" });
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/admin/custom-claims/instance_role/support",
      body: { claims: { tier: "gold" } },
    });
  });

  it("names a missing source on set and delete", async () => {
    const { client } = fakeClient(() => response(404, { error: "Source not found" }));
    expect(await message(setCustomClaims(client, "organization_role", "x", {}))).toBe(
      "No organization_role named x (404: Source not found).",
    );
    const none = fakeClient(() => response(404, { error: "Custom claims not found" }));
    expect(await message(deleteCustomClaims(none.client, "organization_role", "x"))).toBe(
      "No custom claims are set for organization_role x (404: Custom claims not found).",
    );
  });

  it("reports any other failure on every claims route", async () => {
    const { client } = fakeClient(() => response(500, null));
    expect(await message(listCustomClaims(client))).toBe("Could not list custom claims (500).");
    expect(await message(getCustomClaims(client, "instance_role", "a"))).toBe(
      "Could not load the custom claims of a (500).",
    );
    expect(await message(setCustomClaims(client, "instance_role", "a", {}))).toBe(
      "Could not set the custom claims of a (500).",
    );
    expect(await message(deleteCustomClaims(client, "instance_role", "a"))).toBe(
      "Could not delete the custom claims of a (500).",
    );
  });

  it("deletes a source's claims", async () => {
    const { client, calls } = fakeClient(() => response(200, { message: "Custom claims deleted" }));
    await deleteCustomClaims(client, "instance_role", "support");
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      path: "/admin/custom-claims/instance_role/support",
    });
  });

  it("says an instance before v0.23 has no custom claims", async () => {
    const { client } = fakeClient(routeMissing);
    for (const attempt of [
      () => listCustomClaims(client),
      () => getCustomClaims(client, "instance_role", "a"),
      () => setCustomClaims(client, "instance_role", "a", {}),
      () => deleteCustomClaims(client, "instance_role", "a"),
    ]) {
      expect(await message(attempt())).toBe(CUSTOM_CLAIMS_UNSUPPORTED_MESSAGE);
    }
  });
});

describe("audit sinks", () => {
  const syslog = {
    kind: "syslog" as const,
    host: "siem.example.com",
    port: 6514,
    transport: "tls" as const,
    appName: "seamless-auth",
    facility: 10,
  };

  it("lists sinks, keeping a settings kind this CLI does not know", async () => {
    const { client, calls } = fakeClient(() =>
      response(200, { sinks: [apiAuditSink({ settings: { kind: "kafka", topic: "t" } })] }),
    );
    expect((await listAuditSinks(client))[0].settings).toEqual({ kind: "kafka", topic: "t" });
    expect(calls[0].path).toBe("/admin/audit-sinks");
  });

  it("creates, gets, updates, deletes and tests a sink", async () => {
    const { client, calls } = fakeClient((rec) => {
      if (rec.path.endsWith("/test")) return response(200, TEST_OK);
      if (rec.method === "DELETE") return response(200, { message: "Audit sink deleted" });
      return response(rec.method === "POST" ? 201 : 200, { sink: apiAuditSink() });
    });
    await createAuditSink(client, { name: "siem", settings: syslog, enabled: true });
    await getAuditSink(client, SINK_ID);
    await updateAuditSink(client, SINK_ID, { enabled: false });
    await deleteAuditSink(client, SINK_ID);
    await testAuditSink(client, SINK_ID);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /admin/audit-sinks",
      `GET /admin/audit-sinks/${SINK_ID}`,
      `PATCH /admin/audit-sinks/${SINK_ID}`,
      `DELETE /admin/audit-sinks/${SINK_ID}`,
      `POST /admin/audit-sinks/${SINK_ID}/test`,
    ]);
    expect(calls[0].body).toEqual({ name: "siem", settings: syslog, enabled: true });
  });

  it("names a missing sink on every per-id route", async () => {
    const { client } = fakeClient(() => response(404, { error: "Audit sink not found" }));
    const expected = `No audit sink found with id ${SINK_ID} (404: Audit sink not found).`;
    expect(await message(getAuditSink(client, SINK_ID))).toBe(expected);
    expect(await message(updateAuditSink(client, SINK_ID, { enabled: true }))).toBe(expected);
    expect(await message(deleteAuditSink(client, SINK_ID))).toBe(expected);
    expect(await message(testAuditSink(client, SINK_ID))).toBe(expected);
  });

  it("passes on the refusal of a syslog sink by auth server v0.23.0", async () => {
    const refusal =
      "Syslog audit sinks are not available in this release; they arrive in Seamless Auth 0.23.1. Use an OTLP sink until then.";
    const { client } = fakeClient(() => response(400, { error: refusal }));
    expect(
      await message(createAuditSink(client, { name: "a", settings: syslog, enabled: true })),
    ).toBe(`Could not create audit sink (400: ${refusal.slice(0, -1)}).`);
  });

  it("reports any other failure on every sink route", async () => {
    const { client } = fakeClient(() => response(500, null));
    expect(await message(listAuditSinks(client))).toBe("Could not list audit sinks (500).");
    expect(await message(getAuditSink(client, SINK_ID))).toBe("Could not load audit sink (500).");
    expect(
      await message(createAuditSink(client, { name: "a", settings: syslog, enabled: true })),
    ).toBe("Could not create audit sink (500).");
    expect(await message(updateAuditSink(client, SINK_ID, { enabled: true }))).toBe(
      "Could not update audit sink (500).",
    );
    expect(await message(deleteAuditSink(client, SINK_ID))).toBe(
      "Could not delete audit sink (500).",
    );
    expect(await message(testAuditSink(client, SINK_ID))).toBe(
      "Could not send a test record (500).",
    );
  });

  it("says an instance before v0.23 has no audit sinks", async () => {
    const { client } = fakeClient(routeMissing);
    for (const attempt of [
      () => listAuditSinks(client),
      () => getAuditSink(client, SINK_ID),
      () => createAuditSink(client, { name: "a", settings: syslog, enabled: true }),
      () => updateAuditSink(client, SINK_ID, { enabled: true }),
      () => deleteAuditSink(client, SINK_ID),
      () => testAuditSink(client, SINK_ID),
    ]) {
      expect(await message(attempt())).toBe(AUDIT_SINKS_UNSUPPORTED_MESSAGE);
    }
  });
});

describe("authorization", () => {
  it("maps a step-up 403 on every write to a StepUpError", async () => {
    const { client } = fakeClient(() =>
      response(403, { error: "step_up_required", fresh: false, maxAgeSeconds: 300 }),
    );
    const hook = { url: "https://x.example", timeoutMs: 2000, failureMode: "open" as const, enabled: true };
    for (const attempt of [
      () => createWebhook(client, { url: "https://x.example", eventTypes: ["user.created"] }),
      () => updateWebhook(client, WEBHOOK_ID, { enabled: false }),
      () => deleteWebhook(client, WEBHOOK_ID),
      () => rotateWebhookSecret(client, WEBHOOK_ID),
      () => testWebhook(client, WEBHOOK_ID),
      () => redeliverWebhook(client, DELIVERY_ID),
      () => setLoginHook(client, "post_login", hook),
      () => deleteLoginHook(client, "post_login"),
      () => rotateLoginHookSecret(client, "post_login"),
      () => testLoginHook(client, "post_login"),
      () => setCustomClaims(client, "instance_role", "a", {}),
      () => deleteCustomClaims(client, "instance_role", "a"),
      () => createAuditSink(client, { name: "a", settings: { kind: "otlp", endpoint: "https://x.example", headersFromEnv: {}, serviceName: "s" }, enabled: true }),
      () => updateAuditSink(client, SINK_ID, { enabled: false }),
      () => deleteAuditSink(client, SINK_ID),
      () => testAuditSink(client, SINK_ID),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(StepUpError);
    }
  });
});
