import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PORTAL_PROFILE_NAME,
  savePortalSession,
  upsertProfile,
} from "./config.js";
import { isRateLimited } from "./http.js";
import {
  getTokens,
  KeychainUnavailableError,
  saveTokens,
  setBackendForTesting,
  type KeychainBackend,
} from "./keychain.js";
import {
  createAuthClient,
  createPortalClient,
  ReauthRequiredError,
  tokensFromAuthResponse,
  tokensFromRefreshResponse,
} from "./authClient.js";

function fakeBackend(): KeychainBackend {
  const store = new Map<string, string>();
  return {
    get: (account) => store.get(account) ?? null,
    set: (account, secret) => {
      store.set(account, secret);
    },
    delete: (account) => store.delete(account),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(makers: Array<() => Response>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const make = makers[Math.min(i, makers.length - 1)];
      i++;
      return make();
    }),
  );
  return calls;
}

function authHeader(call: Call): string | undefined {
  return (call.init.headers as Record<string, string> | undefined)
    ?.Authorization;
}

const profile = { name: "default", instanceUrl: "https://auth.example.com" };
let configHome: string;

beforeEach(async () => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-http-"));
  process.env.XDG_CONFIG_HOME = configHome;
  delete process.env.SEAMLESS_REFRESH_TOKEN;
  setBackendForTesting(fakeBackend());
  upsertProfile({ name: "default", instanceUrl: "https://auth.example.com" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setBackendForTesting(null);
  fs.rmSync(configHome, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.SEAMLESS_REFRESH_TOKEN;
});

describe("createAuthClient", () => {
  it("throws a reauth error when there is no active profile", async () => {
    await expect(
      createAuthClient({ profileFlag: "ghost" }),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("throws a reauth error when there is no session", async () => {
    await expect(createAuthClient()).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("points at the instance login command when a profile has no session", async () => {
    await expect(createAuthClient()).rejects.toThrow(
      "Run: seamless profile login default.",
    );
  });
});

describe("createPortalClient", () => {
  const portalUrl = "https://portal.example.com";
  const portalTarget = { name: PORTAL_PROFILE_NAME, instanceUrl: portalUrl };

  beforeEach(() => {
    process.env.SEAMLESS_PORTAL_AUTH_URL = portalUrl;
  });

  afterEach(() => {
    delete process.env.SEAMLESS_PORTAL_AUTH_URL;
  });

  it("throws a reauth error naming seamless login when signed out", async () => {
    await expect(createPortalClient()).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
    await expect(createPortalClient()).rejects.toThrow("Run: seamless login.");
  });

  // An instance profile with a session must not stand in for a portal account:
  // its token is issued by a different host and the control plane would reject it.
  it("ignores an instance profile session", async () => {
    await saveTokens(profile, { accessToken: "a", refreshToken: "r" });

    await expect(createPortalClient()).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
  });

  it("sends the portal session to an absolute control-plane URL", async () => {
    savePortalSession({ instanceUrl: portalUrl });
    await saveTokens(portalTarget, {
      accessToken: "portal-access",
      refreshToken: "portal-refresh",
    });
    const calls = mockFetch([() => json({ applications: [] })]);

    const client = await createPortalClient();
    await client.get("https://api.seamlessauth.com/applications");

    expect(calls[0].url).toBe("https://api.seamlessauth.com/applications");
    expect(authHeader(calls[0])).toBe("Bearer portal-access");
  });

  it("refreshes against the portal auth host, not the control plane", async () => {
    savePortalSession({ instanceUrl: portalUrl });
    await saveTokens(portalTarget, {
      accessToken: "stale",
      refreshToken: "portal-refresh",
    });
    const calls = mockFetch([
      () => json({ error: "expired" }, 401),
      () => json({ token: "fresh", refreshToken: "rotated" }),
      () => json({ applications: [] }),
    ]);

    const client = await createPortalClient();
    await client.get("https://api.seamlessauth.com/applications");

    expect(calls[1].url).toBe(`${portalUrl}/refresh`);
    expect(authHeader(calls[2])).toBe("Bearer fresh");
    expect((await getTokens(portalTarget))?.refreshToken).toBe("rotated");
  });
});

describe("transparent refresh", () => {
  it("refreshes on 401, stores the rotated pair, and retries once", async () => {
    await saveTokens(profile, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });

    const calls = mockFetch([
      () => new Response(null, { status: 401 }),
      () =>
        json({
          token: "new-access",
          refreshToken: "new-refresh",
          ttl: 900,
          refreshTtl: 86400,
        }),
      () => json({ sub: "user-1" }),
    ]);

    const client = await createAuthClient();
    const res = await client.get<{ sub: string }>("/whoami");

    expect(res.ok).toBe(true);
    expect(res.data?.sub).toBe("user-1");
    expect(calls).toHaveLength(3);

    expect(authHeader(calls[0])).toBe("Bearer old-access");
    expect(calls[1].url).toBe("https://auth.example.com/refresh");
    expect(authHeader(calls[1])).toBe("Bearer old-refresh");
    expect(authHeader(calls[2])).toBe("Bearer new-access");

    const stored = await getTokens(profile);
    expect(stored?.refreshToken).toBe("new-refresh");
    expect(stored?.accessTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it("re-sends the request body on the retried call", async () => {
    await saveTokens(profile, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });

    const calls = mockFetch([
      () => new Response(null, { status: 401 }),
      () => json({ token: "new-access", refreshToken: "new-refresh" }),
      () => json({ ok: true }),
    ]);

    const client = await createAuthClient();
    await client.post("/things", { name: "widget" });

    expect(calls[2].init.body).toBe(JSON.stringify({ name: "widget" }));
    expect(authHeader(calls[2])).toBe("Bearer new-access");
  });

  it("clears the session and demands re-login when refresh is rejected", async () => {
    await saveTokens(profile, {
      accessToken: "old-access",
      refreshToken: "reused-refresh",
    });

    mockFetch([
      () => new Response(null, { status: 401 }),
      () => json({ error: "token reuse detected" }, 401),
    ]);

    const client = await createAuthClient();
    await expect(client.get("/whoami")).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );

    expect(await getTokens(profile)).toBeNull();
  });

  it("demands re-login when the refresh response is missing token fields", async () => {
    await saveTokens(profile, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });

    mockFetch([
      () => new Response(null, { status: 401 }),
      () => json({ message: "no tokens here" }),
    ]);

    const client = await createAuthClient();
    await expect(client.get("/whoami")).rejects.toThrow(
      /unexpected refresh response/,
    );

    expect(await getTokens(profile)).toBeNull();
  });

  it("swallows a KeychainUnavailableError when persisting rotated tokens", async () => {
    const store = new Map<string, string>();
    const key = `${profile.name}::${profile.instanceUrl}`;
    store.set(
      key,
      JSON.stringify({ accessToken: "old-access", refreshToken: "old-refresh" }),
    );
    setBackendForTesting({
      get: (account) => store.get(account) ?? null,
      set: () => {
        throw new KeychainUnavailableError();
      },
      delete: (account) => store.delete(account),
    });

    mockFetch([
      () => new Response(null, { status: 401 }),
      () => json({ token: "new-access", refreshToken: "new-refresh" }),
      () => json({ sub: "user-1" }),
    ]);

    const client = await createAuthClient();
    const res = await client.get("/whoami");
    expect(res.ok).toBe(true);
  });

  it("propagates unexpected errors when persisting rotated tokens", async () => {
    await saveTokens(profile, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });
    const client = await createAuthClient();

    setBackendForTesting({
      get: () => null,
      set: () => {
        throw new Error("disk full");
      },
      delete: () => false,
    });

    mockFetch([
      () => new Response(null, { status: 401 }),
      () => json({ token: "new-access", refreshToken: "new-refresh" }),
    ]);

    await expect(client.get("/whoami")).rejects.toThrow("disk full");
  });

  it("propagates unexpected errors when clearing a rejected session", async () => {
    await saveTokens(profile, {
      accessToken: "old-access",
      refreshToken: "reused-refresh",
    });
    const client = await createAuthClient();

    setBackendForTesting({
      get: () => null,
      set: () => {},
      delete: () => {
        throw new Error("keychain locked");
      },
    });

    mockFetch([
      () => new Response(null, { status: 401 }),
      () => json({ error: "token reuse detected" }, 401),
    ]);

    await expect(client.get("/whoami")).rejects.toThrow("keychain locked");
  });

  it("swallows a KeychainUnavailableError when clearing a rejected session", async () => {
    await saveTokens(profile, {
      accessToken: "old-access",
      refreshToken: "reused-refresh",
    });
    const client = await createAuthClient();

    setBackendForTesting({
      get: () => null,
      set: () => {},
      delete: () => {
        throw new KeychainUnavailableError();
      },
    });

    mockFetch([
      () => new Response(null, { status: 401 }),
      () => json({ error: "token reuse detected" }, 401),
    ]);

    await expect(client.get("/whoami")).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
  });
});

describe("error and edge responses", () => {
  beforeEach(async () => {
    await saveTokens(profile, {
      accessToken: "access",
      refreshToken: "refresh",
    });
  });

  it("surfaces 429 without attempting a refresh", async () => {
    const calls = mockFetch([() => json({ error: "rate limited" }, 429)]);

    const client = await createAuthClient();
    const res = await client.get("/otp/generate-login-email-otp");

    expect(res.status).toBe(429);
    expect(isRateLimited(res)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does not crash on an HTML body", async () => {
    mockFetch([
      () =>
        new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    ]);

    const client = await createAuthClient();
    const res = await client.get("/whoami");

    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
    expect(res.data).toBeNull();
  });

  it("does not crash on an empty body", async () => {
    mockFetch([() => new Response(null, { status: 204 })]);

    const client = await createAuthClient();
    const res = await client.get("/whoami");

    expect(res.ok).toBe(true);
    expect(res.data).toBeNull();
  });
});

describe("tokensFromAuthResponse", () => {
  it("maps the contract fields and computes expiries", () => {
    const before = Date.now();
    const bundle = tokensFromAuthResponse({
      token: "a",
      refreshToken: "r",
      ttl: 300,
      refreshTtl: 3600,
    });

    expect(bundle?.accessToken).toBe("a");
    expect(bundle?.refreshToken).toBe("r");
    expect(bundle?.accessTokenExpiresAt).toBeGreaterThanOrEqual(before + 300 * 1000);
    expect(bundle?.refreshTokenExpiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  it("returns null when required fields are missing", () => {
    expect(tokensFromAuthResponse({ token: "a" })).toBeNull();
    expect(tokensFromAuthResponse(null)).toBeNull();
  });
});

describe("tokensFromRefreshResponse", () => {
  const current = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    refreshTokenExpiresAt: 4_000,
  };

  // The response schema marks both tokens optional. Requiring the pair, as a login
  // rightly does, wiped a session the instance had just renewed.
  it("keeps the current refresh token when only the access token comes back", () => {
    const bundle = tokensFromRefreshResponse({ token: "new-access" }, current);

    expect(bundle?.accessToken).toBe("new-access");
    expect(bundle?.refreshToken).toBe("old-refresh");
    expect(bundle?.refreshTokenExpiresAt).toBe(4_000);
  });

  it("takes the rotated refresh token when the instance sends one", () => {
    const bundle = tokensFromRefreshResponse(
      { token: "new-access", refreshToken: "new-refresh", refreshTtl: 3600 },
      current,
    );

    expect(bundle?.refreshToken).toBe("new-refresh");
    expect(bundle?.refreshTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it("returns null without a usable access token", () => {
    expect(tokensFromRefreshResponse({ refreshToken: "r" }, current)).toBeNull();
    expect(tokensFromRefreshResponse({}, current)).toBeNull();
    expect(tokensFromRefreshResponse(null, current)).toBeNull();
  });
});

describe("refresh robustness", () => {
  it("keeps working when the instance rotates only the access token", async () => {
    await saveTokens(profile, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });

    const calls = mockFetch([
      () => new Response(null, { status: 401 }),
      () => json({ message: "Success", token: "new-access" }),
      () => json({ ok: true }),
    ]);

    const client = await createAuthClient();
    const res = await client.get("/whoami");

    expect(res.status).toBe(200);
    expect(authHeader(calls[2])).toBe("Bearer new-access");
    expect((await getTokens(profile))?.refreshToken).toBe("old-refresh");
  });

  // The instance revokes the whole session chain when it sees a refresh token twice,
  // so parallel refreshes would log the developer out rather than merely race.
  it("refreshes once for concurrent 401s", async () => {
    await saveTokens(profile, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });

    const calls: Call[] = [];
    let refreshes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url.endsWith("/refresh")) {
          refreshes++;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return json({ token: "new-access", refreshToken: "new-refresh" });
        }
        const auth = (init.headers as Record<string, string>)?.Authorization;
        return auth === "Bearer new-access"
          ? json({ ok: true })
          : new Response(null, { status: 401 });
      }),
    );

    const client = await createAuthClient();
    const results = await Promise.all([
      client.get("/a"),
      client.get("/b"),
      client.get("/c"),
    ]);

    expect(refreshes).toBe(1);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it("raises ReauthRequired when a refreshed token is still rejected", async () => {
    await saveTokens(profile, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });

    mockFetch([
      () => new Response(null, { status: 401 }),
      () => json({ token: "new-access", refreshToken: "new-refresh" }),
      () => new Response(null, { status: 401 }),
    ]);

    const client = await createAuthClient();
    const err = await client.get("/whoami").catch((e: Error) => e);

    expect(err).toBeInstanceOf(ReauthRequiredError);
    expect((err as Error).message).toMatch(/rejected after refreshing it/);
    expect(await getTokens(profile)).toBeNull();
  });

  it("leaves a non-401 failure to the caller", async () => {
    await saveTokens(profile, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });

    mockFetch([() => json({ error: "nope" }, 403)]);

    const client = await createAuthClient();
    expect((await client.get("/whoami")).status).toBe(403);
  });
});

describe("a headless session", () => {
  beforeEach(() => {
    process.env.SEAMLESS_REFRESH_TOKEN = "env-refresh";
  });

  // getTokens reads the environment fresh on every run, so a rotated token written
  // to the keychain is never read back: storing it only makes it look preserved.
  it("does not write a rotated token to the keychain", async () => {
    mockFetch([
      () => new Response(null, { status: 401 }),
      () => json({ token: "new-access", refreshToken: "rotated" }),
      () => json({ ok: true }),
    ]);

    const client = await createAuthClient();
    await client.get("/whoami");

    delete process.env.SEAMLESS_REFRESH_TOKEN;
    expect(await getTokens(profile)).toBeNull();
  });

  it("explains rotation when the environment's token is rejected", async () => {
    mockFetch([
      () => new Response(null, { status: 401 }),
      () => json({ error: "refresh_token_reused" }, 401),
    ]);

    const client = await createAuthClient();
    await expect(client.get("/whoami")).rejects.toThrow(
      /SEAMLESS_REFRESH_TOKEN.*rotates the refresh token on every refresh/s,
    );
  });
});

describe("step-up on admin writes", () => {
  const stepUpRequired = () =>
    json({ error: "step_up_required", fresh: false, maxAgeSeconds: 300 }, 403);

  beforeEach(async () => {
    await saveTokens(profile, { accessToken: "access", refreshToken: "refresh" });
  });

  it("steps up the same session and retries the request once", async () => {
    const calls = mockFetch([stepUpRequired, () => json({ success: true })]);
    const stepUp = vi.fn(async () => {});

    const client = await createAuthClient({ stepUp });
    const res = await client.request("/admin/users", {
      method: "DELETE",
      body: JSON.stringify({ userId: "u1" }),
    });

    expect(res.status).toBe(200);
    expect(stepUp).toHaveBeenCalledWith(client);
    expect(calls).toHaveLength(2);
    expect(calls[1].init.method).toBe("DELETE");
    expect(calls[1].init.body).toBe(JSON.stringify({ userId: "u1" }));
    expect(authHeader(calls[1])).toBe("Bearer access");
  });

  it("returns a second refusal to the caller instead of looping", async () => {
    const calls = mockFetch([stepUpRequired]);
    const stepUp = vi.fn(async () => {});

    const client = await createAuthClient({ stepUp });
    const res = await client.post("/admin/organizations", { name: "Acme" });

    expect(res.status).toBe(403);
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it("steps up again when a later request finds the window lapsed", async () => {
    mockFetch([
      stepUpRequired,
      () => json({ ok: 1 }),
      () => json({ ok: 2 }),
      stepUpRequired,
      () => json({ ok: 3 }),
    ]);
    const stepUp = vi.fn(async () => {});

    const client = await createAuthClient({ stepUp });
    for (let i = 0; i < 3; i++) {
      expect((await client.post("/admin/users/import", {})).ok).toBe(true);
    }

    expect(stepUp).toHaveBeenCalledTimes(2);
  });

  it("shares one step-up between concurrent refusals", async () => {
    mockFetch([stepUpRequired, stepUpRequired, () => json({ ok: true })]);
    let release!: () => void;
    const stepUp = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const client = await createAuthClient({ stepUp });
    const both = Promise.all([client.post("/a"), client.post("/b")]);
    await vi.waitFor(() => expect(stepUp).toHaveBeenCalled());
    release();
    const results = await both;

    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("does not retry when the step-up fails", async () => {
    const calls = mockFetch([stepUpRequired]);
    const stepUp = vi.fn(async () => {
      throw new Error("no code");
    });

    const client = await createAuthClient({ stepUp });
    await expect(client.post("/admin/organizations", {})).rejects.toThrow("no code");
    expect(calls).toHaveLength(1);
  });

  it("leaves a 403 for a missing admin role alone", async () => {
    const calls = mockFetch([() => json({ error: "Forbidden" }, 403)]);
    const stepUp = vi.fn(async () => {});

    const client = await createAuthClient({ stepUp });
    const res = await client.get("/admin/users");

    expect(res.status).toBe(403);
    expect(stepUp).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("returns a rejected code without refreshing or clearing the session", async () => {
    const calls = mockFetch([() => json({ error: "totp_verification_failed" }, 401)]);

    const client = await createAuthClient({ stepUp: vi.fn() });
    const res = await client.post("/totp/verify-mfa", { code: "123456" });

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect((await getTokens(profile))?.refreshToken).toBe("refresh");
  });

  it("steps up with the authenticator app by default", async () => {
    vi.stubEnv("SEAMLESS_TOTP_CODE", "123456");
    const calls = mockFetch([
      stepUpRequired,
      () => json({ enabled: true, verifiedAt: null, lastUsedAt: null }),
      () =>
        json({
          message: "Success",
          fresh: true,
          method: "totp",
          verifiedAt: "2026-10-28T00:00:00.000Z",
          expiresAt: "2026-10-28T00:05:00.000Z",
          maxAgeSeconds: 300,
        }),
      () => json({ success: true }),
    ]);

    const client = await createAuthClient();
    const res = await client.post("/admin/organizations", { name: "Acme" });
    vi.unstubAllEnvs();

    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "https://auth.example.com/admin/organizations",
      "https://auth.example.com/totp/status",
      "https://auth.example.com/totp/verify-mfa",
      "https://auth.example.com/admin/organizations",
    ]);
    expect(calls[2].init.body).toBe(JSON.stringify({ code: "123456" }));
  });

  it("never steps up a portal session", async () => {
    process.env.SEAMLESS_PORTAL_AUTH_URL = "https://portal.example.com";
    const portal = { name: PORTAL_PROFILE_NAME, instanceUrl: "https://portal.example.com" };
    savePortalSession({ instanceUrl: portal.instanceUrl });
    await saveTokens(portal, { accessToken: "pa", refreshToken: "pr" });
    const calls = mockFetch([stepUpRequired]);

    const client = await createPortalClient();
    const res = await client.post("/anything");
    delete process.env.SEAMLESS_PORTAL_AUTH_URL;

    expect(res.status).toBe(403);
    expect(calls).toHaveLength(1);
  });
});
