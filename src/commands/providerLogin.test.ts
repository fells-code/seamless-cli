import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => {
  const CANCEL = Symbol("cancel");
  return {
    CANCEL,
    intro: vi.fn(),
    outro: vi.fn(),
    text: vi.fn(),
    isCancel: (value: unknown) => value === CANCEL,
    cancel: vi.fn(),
    confirm: vi.fn(),
  };
});

vi.mock("../core/providerSignIn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/providerSignIn.js")>();
  return {
    ...actual,
    discoverProvider: vi.fn(),
    readAdvertisedProvider: vi.fn(),
    signInWithLoopback: vi.fn(),
    signInWithDevice: vi.fn(),
    exchangeForSession: vi.fn(),
  };
});

vi.mock("../core/interactiveLogin.js", () => ({ promptLogin: vi.fn() }));

import { confirm, outro } from "@clack/prompts";
import { CancelledError } from "../core/cancel.js";
import { loadConfig, upsertProfile } from "../core/config.js";
import { promptLogin } from "../core/interactiveLogin.js";
import {
  accountKey,
  KEYCHAIN_REQUIRED_MESSAGE,
  KeychainUnavailableError,
  setBackendForTesting,
  type KeychainBackend,
} from "../core/keychain.js";
import {
  discoverProvider,
  exchangeForSession,
  ProviderSignInError,
  readAdvertisedProvider,
  signInWithDevice,
  signInWithLoopback,
  type ProviderMetadata,
} from "../core/providerSignIn.js";
import { loginToInstance } from "./instanceLogin.js";

const INSTANCE = "https://api.example.com";
const ISSUER = "https://auth.example.com";
const metadata: ProviderMetadata = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  deviceAuthorizationEndpoint: `${ISSUER}/device/auth`,
  jwksUri: `${ISSUER}/jwks`,
  issParameterSupported: true,
};

function memory(): KeychainBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (account) => store.get(account) ?? null,
    set: (account, secret) => {
      store.set(account, secret);
    },
    delete: (account) => store.delete(account),
  };
}

let configHome: string;
let backend: ReturnType<typeof memory>;
let logged: string;

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-provider-login-"));
  process.env.XDG_CONFIG_HOME = configHome;
  delete process.env.SEAMLESS_PROFILE;
  delete process.env.SEAMLESS_REFRESH_TOKEN;
  backend = memory();
  setBackendForTesting(backend);

  logged = "";
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged += `${String(line)}\n`;
  });
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    logged += `${String(line)}\n`;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);

  vi.mocked(outro).mockClear();
  vi.mocked(confirm).mockReset().mockResolvedValue(true);
  vi.mocked(promptLogin).mockReset();
  vi.mocked(discoverProvider).mockReset().mockResolvedValue(metadata);
  vi.mocked(readAdvertisedProvider).mockReset().mockResolvedValue(undefined);
  vi.mocked(signInWithLoopback)
    .mockReset()
    .mockResolvedValue({ accessToken: "subject", sub: "user-1" });
  vi.mocked(signInWithDevice)
    .mockReset()
    .mockResolvedValue({ accessToken: "subject", sub: "user-1" });
  vi.mocked(exchangeForSession)
    .mockReset()
    .mockResolvedValue({
      tokens: { accessToken: "fp-access", refreshToken: "fp-refresh" },
      sub: "user-1",
      email: "owner@example.com",
    });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setBackendForTesting(null);
  fs.rmSync(configHome, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

const configured = {
  name: "prod",
  instanceUrl: INSTANCE,
  oidcIssuer: ISSUER,
  oidcClientId: "cli-client",
};
const account = accountKey(configured);

const stored = () => JSON.parse(backend.store.get(account) as string) as Record<string, unknown>;

describe("loginToInstance through the OpenID Provider", () => {
  it("signs in with the browser and exchanges at the instance", async () => {
    upsertProfile(configured);
    await loginToInstance({ profileName: "prod" });

    expect(discoverProvider).toHaveBeenCalledWith(ISSUER);
    expect(signInWithLoopback).toHaveBeenCalledWith(
      expect.objectContaining({ metadata, clientId: "cli-client" }),
    );
    expect(signInWithDevice).not.toHaveBeenCalled();
    expect(exchangeForSession).toHaveBeenCalledWith(INSTANCE, "subject");
    expect(promptLogin).not.toHaveBeenCalled();
  });

  it("uses the device grant with --device", async () => {
    upsertProfile(configured);
    await loginToInstance({ profileName: "prod", device: true });
    expect(signInWithDevice).toHaveBeenCalledWith(
      expect.objectContaining({ metadata, clientId: "cli-client" }),
    );
    expect(signInWithLoopback).not.toHaveBeenCalled();
  });

  it.each([
    [false, "loopback"],
    [true, "device"],
  ])("stores first-party tokens and no provider token (device: %s)", async (device, signIn) => {
    upsertProfile(configured);
    await loginToInstance({ profileName: "prod", device });
    expect(stored()).toEqual({ accessToken: "fp-access", refreshToken: "fp-refresh", signIn });
    expect(backend.store.get(account)).not.toContain("subject");
  });

  it("saves what it learned and keeps the provider settings on the profile", async () => {
    upsertProfile(configured);
    await loginToInstance({ profileName: "prod" });
    expect(loadConfig().profiles.prod).toEqual({
      ...configured,
      sub: "user-1",
      email: "owner@example.com",
    });
    expect(vi.mocked(outro).mock.calls.at(-1)?.[0]).toContain("owner@example.com");
  });

  it("saves --oidc-issuer and --client-id after a successful sign-in", async () => {
    upsertProfile({ name: "prod", instanceUrl: INSTANCE });
    await loginToInstance({
      profileName: "prod",
      oidcIssuer: `${ISSUER}/`,
      clientId: "cli-client",
    });
    expect(discoverProvider).toHaveBeenCalledWith(ISSUER);
    expect(loadConfig().profiles.prod).toMatchObject({
      oidcIssuer: ISSUER,
      oidcClientId: "cli-client",
    });
  });

  it("does not save provider settings when the sign-in fails", async () => {
    upsertProfile({ name: "prod", instanceUrl: INSTANCE });
    vi.mocked(signInWithLoopback).mockRejectedValue(new ProviderSignInError("nope"));
    await expect(
      loginToInstance({ profileName: "prod", oidcIssuer: ISSUER, clientId: "cli-client" }),
    ).rejects.toThrow("exit:1");
    expect(loadConfig().profiles.prod?.oidcIssuer).toBeUndefined();
  });

  it("refuses a session for a different subject than the ID token and ends it", async () => {
    upsertProfile(configured);
    vi.mocked(exchangeForSession).mockResolvedValue({
      tokens: { accessToken: "fp-access", refreshToken: "fp-refresh" },
      sub: "user-9",
    });
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(backend.store.has(account)).toBe(false);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${INSTANCE}/logout`);
    expect(init.method).toBe("DELETE");
  });

  it("ends the new session when the keychain cannot hold it", async () => {
    upsertProfile(configured);
    // Passes the preflight, then fails: a keychain can lock during a sign-in.
    setBackendForTesting({
      ...backend,
      set: (acct, secret) => {
        if (acct === account) throw new KeychainUnavailableError();
        backend.set(acct, secret);
      },
    });
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(vi.mocked(outro).mock.calls.at(-1)?.[0]).toContain("needs an OS keychain");
    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${INSTANCE}/logout`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fp-access");
  });

  it("does not exchange when the provider sign-in failed, and leaves stored tokens alone", async () => {
    upsertProfile(configured);
    backend.store.set(account, JSON.stringify({ accessToken: "a", refreshToken: "r" }));
    vi.mocked(signInWithLoopback).mockRejectedValue(new ProviderSignInError("denied"));
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(exchangeForSession).not.toHaveBeenCalled();
    expect(stored()).toEqual({ accessToken: "a", refreshToken: "r" });
    expect(vi.mocked(outro).mock.calls.at(-1)?.[0]).toContain("denied");
  });

  it("says an identifier is not used", async () => {
    upsertProfile(configured);
    await loginToInstance({ profileName: "prod", identifier: "a@example.com" });
    expect(logged).toMatch(/not used here/);
    expect(promptLogin).not.toHaveBeenCalled();
  });

  it("does not retry a failed exchange", async () => {
    upsertProfile(configured);
    vi.mocked(exchangeForSession).mockRejectedValue(new ProviderSignInError("sign in again"));
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(exchangeForSession).toHaveBeenCalledTimes(1);
    expect(signInWithLoopback).toHaveBeenCalledTimes(1);
  });
});

describe("falling back to the email code", () => {
  const emailResult = {
    tokens: { accessToken: "ea", refreshToken: "er" },
    identity: { sub: "user-1", email: "o@example.com", identifierType: "email" as const },
    channel: "email" as const,
    identifier: "o@example.com",
  };

  beforeEach(() => {
    vi.mocked(promptLogin).mockResolvedValue(emailResult);
  });

  it("uses it on an instance without a provider", async () => {
    upsertProfile({ name: "prod", instanceUrl: INSTANCE });
    await loginToInstance({ profileName: "prod" });
    expect(promptLogin).toHaveBeenCalled();
    expect(discoverProvider).not.toHaveBeenCalled();
    expect(stored()).toEqual({ accessToken: "ea", refreshToken: "er" });
  });

  it("uses it with --device on an instance without a provider, and says so", async () => {
    upsertProfile({ name: "prod", instanceUrl: INSTANCE });
    await loginToInstance({ profileName: "prod", device: true });
    expect(promptLogin).toHaveBeenCalled();
    expect(signInWithDevice).not.toHaveBeenCalled();
    expect(logged).toMatch(/email code/i);
  });

  it("uses it with --email-code even with a provider", async () => {
    upsertProfile(configured);
    await loginToInstance({ profileName: "prod", emailCode: true });
    expect(promptLogin).toHaveBeenCalled();
    expect(discoverProvider).not.toHaveBeenCalled();
  });

  it("uses it with --local, which only applies to email codes", async () => {
    upsertProfile({ ...configured, instanceUrl: "http://localhost:5312" });
    await loginToInstance({ profileName: "prod", local: true });
    expect(promptLogin).toHaveBeenCalled();
  });

  it("clears a previous sign-in kind", async () => {
    upsertProfile({ name: "prod", instanceUrl: INSTANCE });
    backend.store.set(
      accountKey({ name: "prod", instanceUrl: INSTANCE }),
      JSON.stringify({ accessToken: "a", refreshToken: "r", signIn: "device" }),
    );
    await loginToInstance({ profileName: "prod" });
    expect(stored().signIn).toBeUndefined();
  });

  it("does not silently downgrade when the configured provider cannot be read", async () => {
    upsertProfile(configured);
    vi.mocked(discoverProvider).mockRejectedValue(new ProviderSignInError("Could not read"));
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(promptLogin).not.toHaveBeenCalled();
    expect(vi.mocked(outro).mock.calls.at(-1)?.[0]).toContain("--email-code");
  });
});

describe("refused combinations", () => {
  it("refuses --device with --email-code", async () => {
    upsertProfile(configured);
    await expect(
      loginToInstance({ profileName: "prod", device: true, emailCode: true }),
    ).rejects.toThrow("exit:1");
    expect(logged).toContain("--device");
  });

  it("refuses --device with --local", async () => {
    upsertProfile({ ...configured, instanceUrl: "http://localhost:5312" });
    await expect(
      loginToInstance({ profileName: "prod", device: true, local: true }),
    ).rejects.toThrow("exit:1");
  });

  it("refuses an issuer with no client id, naming the flag", async () => {
    upsertProfile({ name: "prod", instanceUrl: INSTANCE, oidcIssuer: ISSUER });
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(logged).toContain("--client-id");
    expect(promptLogin).not.toHaveBeenCalled();
  });

  it("refuses a client id with no issuer, naming the flag", async () => {
    upsertProfile({ name: "prod", instanceUrl: INSTANCE, oidcClientId: "c" });
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(logged).toContain("--oidc-issuer");
  });

  it("refuses an issuer that is not https", async () => {
    upsertProfile({ name: "prod", instanceUrl: INSTANCE });
    await expect(
      loginToInstance({ profileName: "prod", oidcIssuer: "http://a.example.com", clientId: "c" }),
    ).rejects.toThrow("exit:1");
    expect(logged).toContain("https");
  });
});

describe("the instance's advertisement", () => {
  const advertised = { issuer: ISSUER, cliClientId: "advertised-client" };
  const bare = { name: "prod", instanceUrl: INSTANCE };

  it("is used when neither flags nor the profile name a provider", async () => {
    upsertProfile(bare);
    vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
    await loginToInstance({ profileName: "prod" });
    expect(readAdvertisedProvider).toHaveBeenCalledWith(INSTANCE);
    expect(discoverProvider).toHaveBeenCalledWith(ISSUER);
    expect(signInWithLoopback).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "advertised-client" }),
    );
    expect(promptLogin).not.toHaveBeenCalled();
  });

  it("is saved to the profile only after a successful sign-in", async () => {
    upsertProfile(bare);
    vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
    vi.mocked(signInWithLoopback).mockRejectedValueOnce(new ProviderSignInError("nope"));
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(loadConfig().profiles.prod?.oidcIssuer).toBeUndefined();

    await loginToInstance({ profileName: "prod" });
    expect(loadConfig().profiles.prod).toMatchObject({
      oidcIssuer: ISSUER,
      oidcClientId: "advertised-client",
    });
  });

  it("works with --device", async () => {
    upsertProfile(bare);
    vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
    await loginToInstance({ profileName: "prod", device: true });
    expect(signInWithDevice).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "advertised-client" }),
    );
  });

  it("no advertisement and no configured issuer means the email code", async () => {
    upsertProfile(bare);
    vi.mocked(promptLogin).mockResolvedValue({
      tokens: { accessToken: "ea", refreshToken: "er" },
      identity: { identifierType: "email" },
      channel: "email",
      identifier: "o@example.com",
    });
    await loginToInstance({ profileName: "prod" });
    expect(promptLogin).toHaveBeenCalled();
    expect(discoverProvider).not.toHaveBeenCalled();
  });

  it("flags win over the profile and the advertisement", async () => {
    upsertProfile({ ...bare, oidcIssuer: "https://saved.example.com", oidcClientId: "saved" });
    vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
    await loginToInstance({
      profileName: "prod",
      oidcIssuer: "https://flag.example.com",
      clientId: "flag",
    });
    expect(discoverProvider).toHaveBeenCalledWith("https://flag.example.com");
    expect(signInWithLoopback).toHaveBeenCalledWith(expect.objectContaining({ clientId: "flag" }));
  });

  it("the profile wins over the advertisement, without asking", async () => {
    upsertProfile({ ...bare, oidcIssuer: "https://saved.example.com", oidcClientId: "saved" });
    vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
    await loginToInstance({ profileName: "prod" });
    expect(readAdvertisedProvider).not.toHaveBeenCalled();
    expect(discoverProvider).toHaveBeenCalledWith("https://saved.example.com");
    expect(signInWithLoopback).toHaveBeenCalledWith(expect.objectContaining({ clientId: "saved" }));
  });

  it("a later response without the advertisement does not downgrade a saved issuer", async () => {
    upsertProfile(bare);
    vi.mocked(readAdvertisedProvider).mockResolvedValueOnce(advertised);
    await loginToInstance({ profileName: "prod" });

    vi.mocked(readAdvertisedProvider).mockResolvedValue(undefined);
    vi.mocked(signInWithLoopback).mockClear();
    await loginToInstance({ profileName: "prod" });

    expect(signInWithLoopback).toHaveBeenCalledTimes(1);
    expect(promptLogin).not.toHaveBeenCalled();
  });

  it("a saved issuer with no client id and no advertisement stops rather than using the email code", async () => {
    upsertProfile({ ...bare, oidcIssuer: ISSUER });
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(promptLogin).not.toHaveBeenCalled();
    expect(logged).toContain("--client-id");
  });

  it("fills a missing client id only from an advertisement for the same issuer", async () => {
    upsertProfile({ ...bare, oidcIssuer: `${ISSUER}/` });
    vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
    await loginToInstance({ profileName: "prod" });
    expect(signInWithLoopback).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "advertised-client" }),
    );
  });

  it("does not take a client id from an advertisement for another issuer", async () => {
    upsertProfile({ ...bare, oidcIssuer: "https://saved.example.com" });
    vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(signInWithLoopback).not.toHaveBeenCalled();
    expect(logged).toContain("--client-id");
  });

  it("fills a missing issuer when only a client id is configured, keeping that client id", async () => {
    upsertProfile({ ...bare, oidcClientId: "saved" });
    vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
    await loginToInstance({ profileName: "prod" });
    expect(discoverProvider).toHaveBeenCalledWith(ISSUER);
    expect(signInWithLoopback).toHaveBeenCalledWith(expect.objectContaining({ clientId: "saved" }));
  });

  it("an advertised issuer that cannot be read stops, naming --email-code", async () => {
    upsertProfile(bare);
    vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
    vi.mocked(discoverProvider).mockRejectedValue(new ProviderSignInError("Could not read"));
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(promptLogin).not.toHaveBeenCalled();
    expect(vi.mocked(outro).mock.calls.at(-1)?.[0]).toContain("--email-code");
  });

  it("an advertised issuer that is not https stops, and does not sign in", async () => {
    upsertProfile(bare);
    vi.mocked(readAdvertisedProvider).mockResolvedValue({
      issuer: "http://auth.example.com",
      cliClientId: "c",
    });
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(promptLogin).not.toHaveBeenCalled();
    expect(signInWithLoopback).not.toHaveBeenCalled();
    expect(logged).toContain("https");
  });

  describe("an issuer on another origin", () => {
    it("asks first, naming the instance and the issuer", async () => {
      upsertProfile(bare);
      vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
      await loginToInstance({ profileName: "prod" });
      const { message } = vi.mocked(confirm).mock.calls[0][0];
      expect(message).toContain(INSTANCE);
      expect(message).toContain(ISSUER);
      expect(signInWithLoopback).toHaveBeenCalled();
    });

    it("does not sign in or save it when the user declines", async () => {
      upsertProfile(bare);
      vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
      vi.mocked(confirm).mockResolvedValue(false);
      await expect(loginToInstance({ profileName: "prod" })).rejects.toBeDefined();
      expect(discoverProvider).not.toHaveBeenCalled();
      expect(signInWithLoopback).not.toHaveBeenCalled();
      expect(promptLogin).not.toHaveBeenCalled();
      expect(loadConfig().profiles.prod.oidcIssuer).toBeUndefined();
    });

    it("does not sign in when the user interrupts the question", async () => {
      const { CANCEL } = (await import("@clack/prompts")) as unknown as { CANCEL: symbol };
      upsertProfile(bare);
      vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
      vi.mocked(confirm).mockResolvedValue(CANCEL);
      await expect(loginToInstance({ profileName: "prod" })).rejects.toBeInstanceOf(CancelledError);
      expect(signInWithLoopback).not.toHaveBeenCalled();
    });

    it("reports declining as a cancellation", async () => {
      upsertProfile(bare);
      vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
      vi.mocked(confirm).mockResolvedValue(false);
      await expect(loginToInstance({ profileName: "prod" })).rejects.toBeInstanceOf(CancelledError);
    });

    it("refuses without a terminal, naming the flags", async () => {
      process.stdin.isTTY = false;
      upsertProfile(bare);
      vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
      await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
      expect(confirm).not.toHaveBeenCalled();
      expect(signInWithLoopback).not.toHaveBeenCalled();
      expect(promptLogin).not.toHaveBeenCalled();
      expect(logged).toContain("--oidc-issuer");
      expect(logged).toContain(ISSUER);
    });

    it("does not ask again once the sign-in saved it", async () => {
      upsertProfile(bare);
      vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
      await loginToInstance({ profileName: "prod" });
      vi.mocked(confirm).mockClear();
      await loginToInstance({ profileName: "prod" });
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  it("does not ask about an issuer on the instance's own origin", async () => {
    const issuer = `${INSTANCE}/oidc`;
    upsertProfile(bare);
    vi.mocked(readAdvertisedProvider).mockResolvedValue({ issuer, cliClientId: "c" });
    vi.mocked(discoverProvider).mockResolvedValue({ ...metadata, issuer });
    await loginToInstance({ profileName: "prod" });
    expect(confirm).not.toHaveBeenCalled();
    expect(signInWithLoopback).toHaveBeenCalled();
  });

  it("does not ask about an issuer the flags named", async () => {
    upsertProfile(bare);
    vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
    await loginToInstance({ profileName: "prod", oidcIssuer: ISSUER });
    expect(confirm).not.toHaveBeenCalled();
    expect(signInWithLoopback).toHaveBeenCalled();
  });

  it("names the issuer before a sign-in, however it was chosen", async () => {
    upsertProfile(configured);
    await loginToInstance({ profileName: "prod" });
    expect(logged).toContain(ISSUER);
  });

  describe("on an instance reached over plain http", () => {
    const lan = { name: "prod", instanceUrl: "http://auth.local" };
    const signedInByEmail = {
      tokens: { accessToken: "ea", refreshToken: "er" },
      identity: { identifierType: "email" as const },
      channel: "email" as const,
      identifier: "o@example.com",
    };

    it("is not read, and the email code says how to use a provider", async () => {
      upsertProfile(lan);
      vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
      vi.mocked(promptLogin).mockResolvedValue(signedInByEmail);
      await loginToInstance({ profileName: "prod" });
      expect(readAdvertisedProvider).not.toHaveBeenCalled();
      expect(signInWithLoopback).not.toHaveBeenCalled();
      expect(logged).toContain("--oidc-issuer");
      expect(loadConfig().profiles.prod.oidcIssuer).toBeUndefined();
    });

    it("cannot supply the client id for a saved issuer", async () => {
      upsertProfile({ ...lan, oidcIssuer: ISSUER });
      vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
      await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
      expect(readAdvertisedProvider).not.toHaveBeenCalled();
      expect(logged).toContain("--client-id");
    });

    it("keeps working with both flags", async () => {
      upsertProfile(lan);
      await loginToInstance({ profileName: "prod", oidcIssuer: ISSUER, clientId: "c" });
      expect(readAdvertisedProvider).not.toHaveBeenCalled();
      expect(signInWithLoopback).toHaveBeenCalled();
    });

    it("is still read on a loopback instance", async () => {
      upsertProfile({ name: "prod", instanceUrl: "http://localhost:5312" });
      vi.mocked(readAdvertisedProvider).mockResolvedValue(advertised);
      await loginToInstance({ profileName: "prod" });
      expect(readAdvertisedProvider).toHaveBeenCalledWith("http://localhost:5312");
      expect(signInWithLoopback).toHaveBeenCalled();
    });
  });

  it.each([
    ["--email-code", { emailCode: true }],
    ["--local", { local: true }],
  ])("is not read with %s", async (_flag, flags) => {
    upsertProfile({ name: "prod", instanceUrl: "http://localhost:5312" });
    vi.mocked(promptLogin).mockResolvedValue({
      tokens: { accessToken: "ea", refreshToken: "er" },
      identity: { identifierType: "email" },
      channel: "email",
      identifier: "o@example.com",
    });
    await loginToInstance({ profileName: "prod", ...flags });
    expect(readAdvertisedProvider).not.toHaveBeenCalled();
  });
});

describe("the keychain preflight", () => {
  const noKeychain: KeychainBackend = {
    get: () => null,
    set: () => {
      throw new KeychainUnavailableError();
    },
    delete: () => false,
  };

  it.each([
    ["the browser", {}],
    ["--device", { device: true }],
  ])("stops %s before the provider is asked for anything", async (_name, flags) => {
    upsertProfile(configured);
    setBackendForTesting(noKeychain);
    await expect(loginToInstance({ profileName: "prod", ...flags })).rejects.toThrow("exit:1");
    expect(vi.mocked(outro).mock.calls.at(-1)?.[0]).toContain(KEYCHAIN_REQUIRED_MESSAGE);
    expect(discoverProvider).not.toHaveBeenCalled();
    expect(signInWithLoopback).not.toHaveBeenCalled();
    expect(signInWithDevice).not.toHaveBeenCalled();
    expect(exchangeForSession).not.toHaveBeenCalled();
  });

  it("stops the email code before a code is sent", async () => {
    upsertProfile({ name: "prod", instanceUrl: INSTANCE });
    setBackendForTesting(noKeychain);
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(promptLogin).not.toHaveBeenCalled();
    expect(vi.mocked(outro).mock.calls.at(-1)?.[0]).toContain(KEYCHAIN_REQUIRED_MESSAGE);
    expect(logged).not.toContain("SEAMLESS_REFRESH_TOKEN");
  });

  it("does not read the advertisement first", async () => {
    upsertProfile({ name: "prod", instanceUrl: INSTANCE });
    setBackendForTesting(noKeychain);
    await expect(loginToInstance({ profileName: "prod" })).rejects.toThrow("exit:1");
    expect(readAdvertisedProvider).not.toHaveBeenCalled();
  });

  it("leaves stored tokens alone", async () => {
    upsertProfile(configured);
    backend.store.set(account, JSON.stringify({ accessToken: "a", refreshToken: "r" }));
    await loginToInstance({ profileName: "prod" });
    expect([...backend.store.keys()]).toEqual([account]);
  });
});

