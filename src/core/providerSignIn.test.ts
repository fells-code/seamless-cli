import { createHash, generateKeyPairSync } from "crypto";
import { exportJWK, SignJWT, type JWK } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  builtInResource,
  discoverProvider,
  readAdvertisedProvider,
  exchangeForSession,
  normalizeIssuer,
  PROVIDER_SCOPE,
  ProviderSignInError,
  signInWithDevice,
  signInWithLoopback,
  type ProviderMetadata,
} from "./providerSignIn.js";

const ISSUER = "https://auth.example.com";
const INSTANCE = "https://api.example.com";
const CLIENT_ID = "cli-client";
const RESOURCE = `${ISSUER}/seamless`;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const metadata: ProviderMetadata = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  deviceAuthorizationEndpoint: `${ISSUER}/device/auth`,
  jwksUri: `${ISSUER}/jwks`,
  issParameterSupported: true,
};

const discoveryDocument = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  device_authorization_endpoint: `${ISSUER}/device/auth`,
  jwks_uri: `${ISSUER}/jwks`,
  code_challenge_methods_supported: ["S256"],
  authorization_response_iss_parameter_supported: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
let jwk: JWK;

beforeAll(async () => {
  jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
});

async function idToken(
  claims: Record<string, unknown> = {},
  { audience = CLIENT_ID, issuer = ISSUER, subject = "user-1" } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

interface Recorded {
  url: string;
  init: RequestInit;
}

// Everything to the provider goes through this; the loopback callback is real HTTP.
function stubProvider(token: (form: URLSearchParams) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
      calls.push({ url, init });
      if (url === metadata.jwksUri) return json({ keys: [jwk] });
      if (url === metadata.tokenEndpoint) {
        return token(new URLSearchParams(String(init.body)));
      }
      throw new Error(`unexpected request to ${url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("normalizeIssuer", () => {
  it("drops a trailing slash", () => {
    expect(normalizeIssuer(`${ISSUER}/`)).toBe(ISSUER);
  });

  it("refuses an issuer that is not https", () => {
    expect(() => normalizeIssuer("http://auth.example.com")).toThrow(/https/);
  });

  it("refuses a query or a fragment", () => {
    expect(() => normalizeIssuer(`${ISSUER}?a=1`)).toThrow(ProviderSignInError);
    expect(() => normalizeIssuer(`${ISSUER}#a`)).toThrow(ProviderSignInError);
  });

  it("refuses something that is not a URL", () => {
    expect(() => normalizeIssuer("not a url")).toThrow(ProviderSignInError);
  });
});

describe("builtInResource", () => {
  it("is the issuer with /seamless", () => {
    expect(builtInResource(ISSUER)).toBe(RESOURCE);
  });
});

describe("readAdvertisedProvider", () => {
  const stubPublic = (answer: () => Response) => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer());
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("reads oidcProvider from the instance's public config", async () => {
    const fetchMock = stubPublic(() =>
      json({
        loginMethods: ["passkey"],
        oidcProvider: { issuer: ISSUER, cliClientId: CLIENT_ID },
      }),
    );
    await expect(readAdvertisedProvider(INSTANCE)).resolves.toEqual({
      issuer: ISSUER,
      cliClientId: CLIENT_ID,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${INSTANCE}/system-config/public`);
  });

  it("is undefined on an older API, which omits it", async () => {
    stubPublic(() => json({ loginMethods: ["passkey"], recoveryCodes: true }));
    await expect(readAdvertisedProvider(INSTANCE)).resolves.toBeUndefined();
  });

  it.each([
    ["a string", { oidcProvider: "https://auth.example.com" }],
    ["null", { oidcProvider: null }],
    ["no client id", { oidcProvider: { issuer: ISSUER } }],
    ["no issuer", { oidcProvider: { cliClientId: CLIENT_ID } }],
    ["an empty client id", { oidcProvider: { issuer: ISSUER, cliClientId: "" } }],
  ])("is undefined for a malformed advertisement: %s", async (_name, body) => {
    stubPublic(() => json(body));
    await expect(readAdvertisedProvider(INSTANCE)).resolves.toBeUndefined();
  });

  it("keeps fields it does not know", async () => {
    stubPublic(() =>
      json({ oidcProvider: { issuer: ISSUER, cliClientId: CLIENT_ID, extra: 1 }, other: 2 }),
    );
    await expect(readAdvertisedProvider(INSTANCE)).resolves.toMatchObject({ issuer: ISSUER });
  });

  it("is undefined when the instance answers an error", async () => {
    stubPublic(() => json({ error: "nope" }, 500));
    await expect(readAdvertisedProvider(INSTANCE)).resolves.toBeUndefined();
  });

  it("is undefined when the body is not JSON", async () => {
    stubPublic(() => new Response("<html>"));
    await expect(readAdvertisedProvider(INSTANCE)).resolves.toBeUndefined();
  });

  it("is undefined when the instance cannot be reached, for the sign-in to report", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(readAdvertisedProvider(INSTANCE)).resolves.toBeUndefined();
  });
});

describe("discoverProvider", () => {
  const stubDiscovery = (body: unknown, status = 200) => {
    const fetchMock = vi.fn(async () => json(body, status));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("reads the document at the issuer's well-known path", async () => {
    const fetchMock = stubDiscovery(discoveryDocument);
    await expect(discoverProvider(ISSUER)).resolves.toEqual(metadata);
    expect(fetchMock.mock.calls[0]?.[0 as never]).toBe(
      `${ISSUER}/.well-known/openid-configuration`,
    );
  });

  it("does not require session:exchange in scopes_supported, which is expected to be absent", async () => {
    stubDiscovery({ ...discoveryDocument, scopes_supported: ["openid", "email"] });
    await expect(discoverProvider(ISSUER)).resolves.toMatchObject({ issuer: ISSUER });
  });

  it("refuses a document naming another issuer", async () => {
    stubDiscovery({ ...discoveryDocument, issuer: "https://evil.example.com" });
    await expect(discoverProvider(ISSUER)).rejects.toThrow(/issuer/i);
  });

  it("refuses an endpoint that is not https", async () => {
    stubDiscovery({ ...discoveryDocument, token_endpoint: "http://auth.example.com/token" });
    await expect(discoverProvider(ISSUER)).rejects.toThrow(ProviderSignInError);
  });

  it("refuses a provider without PKCE S256", async () => {
    stubDiscovery({ ...discoveryDocument, code_challenge_methods_supported: ["plain"] });
    await expect(discoverProvider(ISSUER)).rejects.toThrow(/S256/);
  });

  it("reports an unreachable provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(discoverProvider(ISSUER)).rejects.toThrow(/Could not read/);
  });

  it("reports a provider answering with an error", async () => {
    stubDiscovery({}, 404);
    await expect(discoverProvider(ISSUER)).rejects.toThrow(/404/);
  });

  it("reports a document it cannot read", async () => {
    stubDiscovery({ issuer: ISSUER });
    await expect(discoverProvider(ISSUER)).rejects.toThrow(ProviderSignInError);
  });
});

describe("signInWithLoopback", () => {
  // Stands in for the browser: receives the URL and hits the redirect it names.
  function browser(
    respond: (authorize: URL) => string | Record<string, string>,
  ): { open: (url: string) => Promise<boolean>; opened: URL[] } {
    const opened: URL[] = [];
    return {
      opened,
      open: async (url) => {
        const authorize = new URL(url);
        opened.push(authorize);
        const answer = respond(authorize);
        const redirect = new URL(authorize.searchParams.get("redirect_uri") as string);
        if (typeof answer === "string") {
          redirect.search = answer;
        } else {
          redirect.search = new URLSearchParams(answer).toString();
        }
        void realFetch(redirect).catch(() => {});
        return true;
      },
    };
  }

  const approved = (authorize: URL) => ({
    code: "the-code",
    state: authorize.searchParams.get("state") as string,
    iss: ISSUER,
  });

  function tokenFromNonce(extra: Record<string, unknown> = {}) {
    let nonce = "";
    return {
      setNonce: (value: string) => {
        nonce = value;
      },
      respond: async () =>
        json({ access_token: "at-1", id_token: await idToken({ nonce }), ...extra }),
    };
  }

  function nonceAwareBrowser(
    token: { setNonce: (value: string) => void },
    respond: (authorize: URL) => string | Record<string, string> = approved,
  ) {
    return browser((authorize) => {
      token.setNonce(authorize.searchParams.get("nonce") as string);
      return respond(authorize);
    });
  }

  it("sends an authorization request with PKCE S256, the built-in resource and the exact scope", async () => {
    const token = tokenFromNonce();
    let form = new URLSearchParams();
    stubProvider((body) => {
      form = body;
      return token.respond();
    });
    const { open, opened } = nonceAwareBrowser(token);

    await signInWithLoopback({ metadata, clientId: CLIENT_ID, openBrowser: open, say: () => {} });

    const params = opened[0]?.searchParams as URLSearchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("resource")).toBe(RESOURCE);
    expect(params.get("scope")).toBe("openid session:exchange");
    expect(PROVIDER_SCOPE).toBe("openid session:exchange");
    expect(params.get("scope")).not.toContain("offline_access");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("acr_values")).toBeNull();
    expect(params.get("max_age")).toBeNull();
    expect(params.get("state")?.length).toBeGreaterThan(20);
    expect(params.get("nonce")?.length).toBeGreaterThan(20);

    const verifier = form.get("code_verifier") as string;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      params.get("code_challenge"),
    );
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("redirect_uri")).toBe(params.get("redirect_uri"));
    expect(form.get("resource")).toBe(RESOURCE);
  });

  it("redirects to 127.0.0.1 on a random port at /callback", async () => {
    const token = tokenFromNonce();
    stubProvider(() => token.respond());
    const { open, opened } = nonceAwareBrowser(token);
    await signInWithLoopback({ metadata, clientId: CLIENT_ID, openBrowser: open, say: () => {} });

    const redirect = new URL(opened[0]?.searchParams.get("redirect_uri") as string);
    expect(redirect.protocol).toBe("http:");
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(Number(redirect.port)).toBeGreaterThan(0);
    expect(redirect.pathname).toBe("/callback");
  });

  it("uses a new state, nonce and verifier for each sign-in", async () => {
    const token = tokenFromNonce();
    stubProvider(() => token.respond());
    const { open, opened } = nonceAwareBrowser(token);
    await signInWithLoopback({ metadata, clientId: CLIENT_ID, openBrowser: open, say: () => {} });
    await signInWithLoopback({ metadata, clientId: CLIENT_ID, openBrowser: open, say: () => {} });

    for (const key of ["state", "nonce", "code_challenge"]) {
      expect(opened[0]?.searchParams.get(key)).not.toBe(opened[1]?.searchParams.get(key));
    }
  });

  it("returns the access token and the verified subject", async () => {
    const token = tokenFromNonce();
    stubProvider(() => token.respond());
    const { open } = nonceAwareBrowser(token);
    await expect(
      signInWithLoopback({ metadata, clientId: CLIENT_ID, openBrowser: open, say: () => {} }),
    ).resolves.toEqual({ accessToken: "at-1", sub: "user-1" });
  });

  it("adds acr_values and max_age for a step-up", async () => {
    const token = tokenFromNonce();
    stubProvider(() => token.respond());
    const { open, opened } = nonceAwareBrowser(token);
    await signInWithLoopback({
      metadata,
      clientId: CLIENT_ID,
      openBrowser: open,
      say: () => {},
      acrValues: "phr",
      maxAge: 300,
    });
    expect(opened[0]?.searchParams.get("acr_values")).toBe("phr");
    expect(opened[0]?.searchParams.get("max_age")).toBe("300");
  });

  it("tells the user a confirmation is coming", async () => {
    const token = tokenFromNonce();
    stubProvider(() => token.respond());
    const { open } = nonceAwareBrowser(token);
    const said: string[] = [];
    await signInWithLoopback({
      metadata,
      clientId: CLIENT_ID,
      openBrowser: open,
      say: (line) => said.push(line),
    });
    expect(said.join("\n")).toMatch(/Continue to/);
  });

  it("prints the URL when no browser opens", async () => {
    const token = tokenFromNonce();
    stubProvider(() => token.respond());
    const { open } = nonceAwareBrowser(token);
    const said: string[] = [];
    await signInWithLoopback({
      metadata,
      clientId: CLIENT_ID,
      say: (line) => said.push(line),
      openBrowser: async (url) => {
        await open(url);
        return false;
      },
    });
    expect(said.join("\n")).toContain(`${ISSUER}/authorize?`);
    expect(said.join("\n")).toContain("--device");
  });

  it("never says the code or a token", async () => {
    const token = tokenFromNonce();
    stubProvider(() => token.respond());
    const { open } = nonceAwareBrowser(token);
    const said: string[] = [];
    await signInWithLoopback({
      metadata,
      clientId: CLIENT_ID,
      openBrowser: open,
      say: (line) => said.push(line),
    });
    expect(said.join("\n")).not.toContain("the-code");
    expect(said.join("\n")).not.toContain("at-1");
  });

  it("refuses a callback with the wrong state and closes the listener", async () => {
    const calls = stubProvider(() => json({}));
    let redirect = "";
    const { open } = browser((authorize) => {
      redirect = authorize.searchParams.get("redirect_uri") as string;
      return { code: "x", state: "wrong", iss: ISSUER };
    });

    await expect(
      signInWithLoopback({ metadata, clientId: CLIENT_ID, openBrowser: open, say: () => {} }),
    ).rejects.toThrow(/state/i);
    expect(calls.filter((call) => call.url === metadata.tokenEndpoint)).toHaveLength(0);
    await expect(realFetch(redirect)).rejects.toThrow();
  });

  it("accepts one callback and then closes", async () => {
    const token = tokenFromNonce();
    stubProvider(() => token.respond());
    let redirect = "";
    const { open } = nonceAwareBrowser(token, (authorize) => {
      redirect = authorize.searchParams.get("redirect_uri") as string;
      return approved(authorize);
    });
    await signInWithLoopback({ metadata, clientId: CLIENT_ID, openBrowser: open, say: () => {} });
    await expect(realFetch(redirect)).rejects.toThrow();
  });

  it("does not let another path consume the one callback", async () => {
    const token = tokenFromNonce();
    stubProvider(() => token.respond());
    const statuses: number[] = [];
    await signInWithLoopback({
      metadata,
      clientId: CLIENT_ID,
      say: () => {},
      openBrowser: async (url) => {
        const authorize = new URL(url);
        token.setNonce(authorize.searchParams.get("nonce") as string);
        const redirect = new URL(authorize.searchParams.get("redirect_uri") as string);
        const favicon = await realFetch(new URL("/favicon.ico", redirect));
        statuses.push(favicon.status);
        const post = await realFetch(redirect, { method: "POST" });
        statuses.push(post.status);
        redirect.search = new URLSearchParams(approved(authorize)).toString();
        const done = await realFetch(redirect);
        statuses.push(done.status);
        return true;
      },
    });
    expect(statuses).toEqual([404, 404, 200]);
  });

  it("does not echo the callback's query into its page", async () => {
    const token = tokenFromNonce();
    stubProvider(() => token.respond());
    let page = "";
    let headers = new Headers();
    await signInWithLoopback({
      metadata,
      clientId: CLIENT_ID,
      say: () => {},
      openBrowser: async (url) => {
        const authorize = new URL(url);
        token.setNonce(authorize.searchParams.get("nonce") as string);
        const redirect = new URL(authorize.searchParams.get("redirect_uri") as string);
        redirect.search = new URLSearchParams(approved(authorize)).toString();
        const res = await realFetch(redirect);
        page = await res.text();
        headers = res.headers;
        return true;
      },
    });
    expect(page).not.toContain("the-code");
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("reports an error from the provider without its control characters", async () => {
    stubProvider(() => json({}));
    const { open } = browser((authorize) => ({
      error: "invalid_target",
      error_description: "bad\u001b[31mresource",
      state: authorize.searchParams.get("state") as string,
      iss: ISSUER,
    }));
    const error = await signInWithLoopback({
      metadata,
      clientId: CLIENT_ID,
      openBrowser: open,
      say: () => {},
    }).catch((err: Error) => err);
    expect(String((error as Error).message)).toContain("invalid_target");
    expect(String((error as Error).message)).not.toContain("\u001b");
  });

  it("names the settings a client needs when the provider refuses the resource or scope", async () => {
    stubProvider(() => json({}));
    const { open } = browser((authorize) => ({
      error: "invalid_scope",
      state: authorize.searchParams.get("state") as string,
      iss: ISSUER,
    }));
    await expect(
      signInWithLoopback({ metadata, clientId: CLIENT_ID, openBrowser: open, say: () => {} }),
    ).rejects.toThrow(/sessionExchangeEnabled/);
  });

  it("refuses a callback whose iss names another provider (RFC 9207)", async () => {
    const calls = stubProvider(() => json({}));
    const { open } = browser((authorize) => ({
      ...approved(authorize),
      iss: "https://evil.example.com",
    }));
    await expect(
      signInWithLoopback({ metadata, clientId: CLIENT_ID, openBrowser: open, say: () => {} }),
    ).rejects.toThrow(/iss/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a missing iss when the provider advertises it", async () => {
    stubProvider(() => json({}));
    const { open } = browser((authorize) => ({
      code: "x",
      state: authorize.searchParams.get("state") as string,
    }));
    await expect(
      signInWithLoopback({ metadata, clientId: CLIENT_ID, openBrowser: open, say: () => {} }),
    ).rejects.toThrow(/iss/);
  });

  it("accepts a missing iss when the provider does not advertise it", async () => {
    const token = tokenFromNonce();
    stubProvider(() => token.respond());
    const { open } = nonceAwareBrowser(token, (authorize) => ({
      code: "x",
      state: authorize.searchParams.get("state") as string,
    }));
    await expect(
      signInWithLoopback({
        metadata: { ...metadata, issParameterSupported: false },
        clientId: CLIENT_ID,
        openBrowser: open,
        say: () => {},
      }),
    ).resolves.toMatchObject({ accessToken: "at-1" });
  });

  it("refuses a callback with no code", async () => {
    stubProvider(() => json({}));
    const { open } = browser((authorize) => ({
      state: authorize.searchParams.get("state") as string,
      iss: ISSUER,
    }));
    await expect(
      signInWithLoopback({ metadata, clientId: CLIENT_ID, openBrowser: open, say: () => {} }),
    ).rejects.toThrow(/code/);
  });

  it("times out and closes the listener", async () => {
    stubProvider(() => json({}));
    let redirect = "";
    await expect(
      signInWithLoopback({
        metadata,
        clientId: CLIENT_ID,
        say: () => {},
        timeoutMs: 30,
        openBrowser: async (url) => {
          redirect = new URL(url).searchParams.get("redirect_uri") as string;
          return true;
        },
      }),
    ).rejects.toThrow(/timed out/i);
    await expect(realFetch(redirect)).rejects.toThrow();
  });

  it("reports a token endpoint refusal without the code", async () => {
    stubProvider(() => json({ error: "invalid_grant" }, 400));
    const token = tokenFromNonce();
    const { open } = nonceAwareBrowser(token);
    const error = (await signInWithLoopback({
      metadata,
      clientId: CLIENT_ID,
      openBrowser: open,
      say: () => {},
    }).catch((err: Error) => err)) as Error;
    expect(error).toBeInstanceOf(ProviderSignInError);
    expect(error.message).toContain("invalid_grant");
    expect(error.message).not.toContain("the-code");
  });

  it("reports an unreachable token endpoint", async () => {
    const token = tokenFromNonce();
    stubProvider(() => {
      throw new TypeError("fetch failed");
    });
    const { open } = nonceAwareBrowser(token);
    await expect(
      signInWithLoopback({ metadata, clientId: CLIENT_ID, openBrowser: open, say: () => {} }),
    ).rejects.toThrow(/Could not reach/);
  });

  describe("ID token", () => {
    const signIn = async (
      makeToken: (nonce: string) => Promise<unknown>,
    ): Promise<unknown> => {
      let nonce = "";
      stubProvider(async () => json({ access_token: "at-1", id_token: await makeToken(nonce) }));
      const { open } = browser((authorize) => {
        nonce = authorize.searchParams.get("nonce") as string;
        return approved(authorize);
      });
      return signInWithLoopback({
        metadata,
        clientId: CLIENT_ID,
        openBrowser: open,
        say: () => {},
      });
    };

    it("refuses a wrong nonce", async () => {
      await expect(signIn(() => idToken({ nonce: "other" }))).rejects.toThrow(/nonce/i);
    });

    it("refuses a missing nonce", async () => {
      await expect(signIn(() => idToken())).rejects.toThrow(/nonce/i);
    });

    it("refuses another audience", async () => {
      await expect(
        signIn((nonce) => idToken({ nonce }, { audience: "another-client" })),
      ).rejects.toThrow(/ID token/);
    });

    it("refuses another issuer", async () => {
      await expect(
        signIn((nonce) => idToken({ nonce }, { issuer: "https://evil.example.com" })),
      ).rejects.toThrow(/ID token/);
    });

    it("refuses a token signed with another key", async () => {
      const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
      await expect(
        signIn((nonce) =>
          new SignJWT({ nonce })
            .setProtectedHeader({ alg: "RS256", kid: "k1" })
            .setIssuer(ISSUER)
            .setAudience(CLIENT_ID)
            .setSubject("user-1")
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(other),
        ),
      ).rejects.toThrow(/ID token/);
    });

    it("refuses a response with no ID token", async () => {
      await expect(signIn(async () => undefined)).rejects.toThrow(/ID token/);
    });
  });

  it("refuses a response with no access token", async () => {
    let nonce = "";
    stubProvider(async () => json({ id_token: await idToken({ nonce }) }));
    const { open } = browser((authorize) => {
      nonce = authorize.searchParams.get("nonce") as string;
      return approved(authorize);
    });
    await expect(
      signInWithLoopback({ metadata, clientId: CLIENT_ID, openBrowser: open, say: () => {} }),
    ).rejects.toThrow(/access token/);
  });
});

describe("signInWithDevice", () => {
  const deviceResponse = {
    device_code: "secret-device-code",
    user_code: "ABCD-EFGH",
    verification_uri: `${ISSUER}/device`,
    verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`,
    expires_in: 600,
    interval: 5,
  };

  function stubDevice(
    answers: Array<() => Response | Promise<Response>>,
    authorization: Response = json(deviceResponse),
  ) {
    const forms: URLSearchParams[] = [];
    let authForm = new URLSearchParams();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        if (input === metadata.deviceAuthorizationEndpoint) {
          authForm = new URLSearchParams(String(init.body));
          return authorization;
        }
        if (input === metadata.jwksUri) return json({ keys: [jwk] });
        forms.push(new URLSearchParams(String(init.body)));
        const answer = answers.shift();
        if (!answer) throw new Error("polled too many times");
        return answer();
      }),
    );
    return { forms, authForm: () => authForm };
  }

  const pending = () => json({ error: "authorization_pending" }, 400);
  const tokens = async () =>
    json({ access_token: "at-device", id_token: await idToken({}, { subject: "user-2" }) });

  function clock() {
    let now = 1_000_000;
    const waits: number[] = [];
    return {
      waits,
      now: () => now,
      sleep: async (ms: number) => {
        waits.push(ms);
        now += ms;
      },
    };
  }

  it("requests the built-in resource and the exact scope, with no acr_values or max_age", async () => {
    const { authForm } = stubDevice([tokens]);
    const c = clock();
    await signInWithDevice({
      metadata,
      clientId: CLIENT_ID,
      say: () => {},
      sleep: c.sleep,
      now: c.now,
    });
    const form = authForm();
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("resource")).toBe(RESOURCE);
    expect(form.get("scope")).toBe("openid session:exchange");
    expect(form.has("acr_values")).toBe(false);
    expect(form.has("max_age")).toBe(false);
  });

  it("shows the verification URI and the user code, never the device code", async () => {
    stubDevice([tokens]);
    const c = clock();
    const said: string[] = [];
    await signInWithDevice({
      metadata,
      clientId: CLIENT_ID,
      say: (line) => said.push(line),
      sleep: c.sleep,
      now: c.now,
    });
    const text = said.join("\n");
    expect(text).toContain(`${ISSUER}/device`);
    expect(text).toContain("ABCD-EFGH");
    expect(text).not.toContain("secret-device-code");
    expect(text).not.toContain("at-device");
  });

  it("polls with the device grant at the interval until approved", async () => {
    const { forms } = stubDevice([pending, pending, tokens]);
    const c = clock();
    await expect(
      signInWithDevice({ metadata, clientId: CLIENT_ID, say: () => {}, sleep: c.sleep, now: c.now }),
    ).resolves.toEqual({ accessToken: "at-device", sub: "user-2" });

    expect(c.waits).toEqual([5000, 5000, 5000]);
    expect(forms).toHaveLength(3);
    expect(forms[0]?.get("grant_type")).toBe(DEVICE_GRANT);
    expect(forms[0]?.get("device_code")).toBe("secret-device-code");
    expect(forms[0]?.get("client_id")).toBe(CLIENT_ID);
  });

  it("defaults the interval to 5 seconds", async () => {
    const { interval: _omit, ...withoutInterval } = deviceResponse;
    stubDevice([tokens], json(withoutInterval));
    const c = clock();
    await signInWithDevice({ metadata, clientId: CLIENT_ID, say: () => {}, sleep: c.sleep, now: c.now });
    expect(c.waits).toEqual([5000]);
  });

  it("slows down by 5 seconds on slow_down", async () => {
    stubDevice([() => json({ error: "slow_down" }, 400), tokens]);
    const c = clock();
    await signInWithDevice({ metadata, clientId: CLIENT_ID, say: () => {}, sleep: c.sleep, now: c.now });
    expect(c.waits).toEqual([5000, 10000]);
  });

  it("keeps polling through a dropped connection, backing off", async () => {
    stubDevice([
      () => {
        throw new TypeError("fetch failed");
      },
      tokens,
    ]);
    const c = clock();
    await signInWithDevice({ metadata, clientId: CLIENT_ID, say: () => {}, sleep: c.sleep, now: c.now });
    expect(c.waits).toEqual([5000, 10000]);
  });

  it("stops on expired_token", async () => {
    stubDevice([() => json({ error: "expired_token" }, 400)]);
    const c = clock();
    await expect(
      signInWithDevice({ metadata, clientId: CLIENT_ID, say: () => {}, sleep: c.sleep, now: c.now }),
    ).rejects.toThrow(/expired/i);
  });

  it("stops on access_denied", async () => {
    stubDevice([() => json({ error: "access_denied" }, 400)]);
    const c = clock();
    await expect(
      signInWithDevice({ metadata, clientId: CLIENT_ID, say: () => {}, sleep: c.sleep, now: c.now }),
    ).rejects.toThrow(/denied/i);
  });

  it("stops on any other token error", async () => {
    stubDevice([() => json({ error: "invalid_grant" }, 400)]);
    const c = clock();
    await expect(
      signInWithDevice({ metadata, clientId: CLIENT_ID, say: () => {}, sleep: c.sleep, now: c.now }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("stops polling once the code's lifetime is over", async () => {
    stubDevice(
      [pending, pending, pending],
      json({ ...deviceResponse, expires_in: 8 }),
    );
    const c = clock();
    await expect(
      signInWithDevice({ metadata, clientId: CLIENT_ID, say: () => {}, sleep: c.sleep, now: c.now }),
    ).rejects.toThrow(/expired/i);
  });

  it("verifies the ID token with no nonce", async () => {
    stubDevice([async () => json({ access_token: "at", id_token: await idToken({}, { audience: "x" }) })]);
    const c = clock();
    await expect(
      signInWithDevice({ metadata, clientId: CLIENT_ID, say: () => {}, sleep: c.sleep, now: c.now }),
    ).rejects.toThrow(/ID token/);
  });

  it("says when the provider has no device endpoint", async () => {
    const { deviceAuthorizationEndpoint: _omit, ...noDevice } = metadata;
    await expect(
      signInWithDevice({ metadata: noDevice, clientId: CLIENT_ID, say: () => {} }),
    ).rejects.toThrow(/device/i);
  });

  it("names the client settings when the device request is refused", async () => {
    stubDevice([], json({ error: "unauthorized_client" }, 400));
    await expect(
      signInWithDevice({ metadata, clientId: CLIENT_ID, say: () => {} }),
    ).rejects.toThrow(/unauthorized_client/);
  });

  it("reports an unreachable device endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(
      signInWithDevice({ metadata, clientId: CLIENT_ID, say: () => {} }),
    ).rejects.toThrow(/Could not reach/);
  });

  it("reports a device response it cannot read", async () => {
    stubDevice([], json({ user_code: "A" }));
    await expect(
      signInWithDevice({ metadata, clientId: CLIENT_ID, say: () => {} }),
    ).rejects.toThrow(ProviderSignInError);
  });
});

describe("exchangeForSession", () => {
  const success = {
    message: "Success",
    token: "fp-access",
    refreshToken: "fp-refresh",
    sub: "user-1",
    email: "owner@example.com",
    ttl: 1800,
    refreshTtl: 120,
    issued_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
  };

  function stubExchange(answer: () => Response | Promise<Response>) {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer());
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("posts exactly the four strict fields to the instance", async () => {
    const fetchMock = stubExchange(() => json(success));
    await exchangeForSession(INSTANCE, "subject");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${INSTANCE}/sessions/exchange`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "subject",
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      requested_token_type: "urn:ietf:params:oauth:token-type:refresh_token",
    });
  });

  it("returns the first-party tokens", async () => {
    stubExchange(() => json(success));
    const result = await exchangeForSession(INSTANCE, "subject");
    expect(result.tokens.accessToken).toBe("fp-access");
    expect(result.tokens.refreshToken).toBe("fp-refresh");
    expect(result.sub).toBe("user-1");
    expect(result.email).toBe("owner@example.com");
  });

  it("reads refreshTtl as the time remaining, even on the first response", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    stubExchange(() => json(success));
    const { tokens } = await exchangeForSession(INSTANCE, "subject");
    expect(tokens.refreshTokenExpiresAt).toBe(1_000_000 + 120_000);
    expect(tokens.accessTokenExpiresAt).toBe(1_000_000 + 1_800_000);
  });

  describe("never retries", () => {
    it.each([
      ["a bare invalid_request", () => json({ error: "invalid_request" }, 400), /sign in again/i],
      ["a schema failure", () => json({ error: "invalid_request", message: "x", details: {} }, 400), /sign in again/i],
      ["a replay", () => json({ error: "invalid_request", error_description: "token_already_used" }, 400), /intercepted/i],
      ["a rate limit", () => json({ error: "Too many requests, please try again later" }, 429), /wait/i],
      ["a server failure", () => json({ error: "boom" }, 500), /sign in again/i],
      ["a body it cannot read", () => json({ message: "Success" }), /sign in again/i],
      ["a missing route", () => json({ error: "Not found" }, 404), /--email-code/],
    ])("%s", async (_name, answer, message) => {
      const fetchMock = stubExchange(answer);
      await expect(exchangeForSession(INSTANCE, "subject")).rejects.toThrow(message);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("a lost response, which a retry would turn into a replay", async () => {
      const fetchMock = stubExchange(() => {
        throw new TypeError("fetch failed");
      });
      await expect(exchangeForSession(INSTANCE, "subject")).rejects.toThrow(/sign in again/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("flags a replay so a caller can tell it apart", async () => {
    stubExchange(() =>
      json({ error: "invalid_request", error_description: "token_already_used" }, 400),
    );
    await expect(exchangeForSession(INSTANCE, "subject")).rejects.toMatchObject({
      replayed: true,
    });
  });
});

beforeEach(() => {
  process.stdin.isTTY = true;
});
