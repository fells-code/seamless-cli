import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertUsableProfileName,
  clearPortalSession,
  DEFAULT_PORTAL_AUTH_URL,
  getConfigPath,
  getPortalAuthUrl,
  getPortalSession,
  getProfile,
  listProfiles,
  loadConfig,
  isLocalInstanceUrl,
  isLoopbackInstanceUrl,
  normalizeInstanceUrl,
  PORTAL_PROFILE_NAME,
  removeProfile,
  resolveActiveProfileName,
  savePortalSession,
  setActiveProfile,
  upsertProfile,
} from "./config.js";

let configHome: string;

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-config-"));
  process.env.XDG_CONFIG_HOME = configHome;
  delete process.env.SEAMLESS_PROFILE;
});

afterEach(() => {
  fs.rmSync(configHome, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.SEAMLESS_PROFILE;
  delete process.env.SEAMLESS_PORTAL_AUTH_URL;
});

describe("getPortalAuthUrl", () => {
  it("defaults to the managed portal auth instance", () => {
    expect(getPortalAuthUrl()).toBe(DEFAULT_PORTAL_AUTH_URL);
  });

  it("honors SEAMLESS_PORTAL_AUTH_URL and normalizes it", () => {
    process.env.SEAMLESS_PORTAL_AUTH_URL = "http://localhost:5312/";
    expect(getPortalAuthUrl()).toBe("http://localhost:5312");
  });

  it("rejects an override that is not a valid instance URL", () => {
    process.env.SEAMLESS_PORTAL_AUTH_URL = "not-a-url";
    expect(() => getPortalAuthUrl()).toThrow(/Invalid instance URL/);
  });
});

describe("assertUsableProfileName", () => {
  it("rejects the reserved portal name", () => {
    expect(() => assertUsableProfileName(PORTAL_PROFILE_NAME)).toThrow(
      /reserved for the portal session/,
    );
  });

  it("accepts an ordinary name", () => {
    expect(() => assertUsableProfileName("prod")).not.toThrow();
  });
});

describe("portal session", () => {
  beforeEach(() => {
    process.env.SEAMLESS_PORTAL_AUTH_URL = "https://portal.example.com";
  });

  it("is undefined before signing in", () => {
    expect(getPortalSession()).toBeUndefined();
  });

  it("round-trips and stays out of the profile map", () => {
    savePortalSession({
      instanceUrl: "https://portal.example.com",
      sub: "user-1",
      email: "dev@example.com",
      identifierType: "email",
    });

    const session = getPortalSession()!;
    expect(session.name).toBe(PORTAL_PROFILE_NAME);
    expect(session.email).toBe("dev@example.com");
    expect(loadConfig().profiles).toEqual({});
    expect(listProfiles()).toEqual([]);
  });

  // Tokens are keyed by host, so a session for another portal is unusable here
  // and must read as signed out rather than being silently reused.
  it("is undefined when it belongs to a different portal host", () => {
    savePortalSession({ instanceUrl: "https://portal.example.com" });
    process.env.SEAMLESS_PORTAL_AUTH_URL = "https://other.example.com";

    expect(getPortalSession()).toBeUndefined();
    expect(loadConfig().portal).toBeDefined();
  });

  it("clears", () => {
    savePortalSession({ instanceUrl: "https://portal.example.com" });
    clearPortalSession();

    expect(getPortalSession()).toBeUndefined();
    expect(loadConfig().portal).toBeUndefined();
  });

  it("survives a reload and ignores a malformed stored value", () => {
    savePortalSession({ instanceUrl: "https://portal.example.com" });
    expect(loadConfig().portal?.instanceUrl).toBe("https://portal.example.com");

    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({ activeProfile: "default", profiles: {}, portal: 42 }),
    );
    expect(loadConfig().portal).toBeUndefined();
  });
});

describe("loadConfig", () => {
  it("returns an empty config when no file exists", () => {
    expect(loadConfig()).toEqual({ activeProfile: "default", profiles: {} });
  });

  it("persists profiles across invocations", () => {
    upsertProfile({ name: "prod", instanceUrl: "https://auth.example.com" });
    expect(getProfile("prod")?.instanceUrl).toBe("https://auth.example.com");
    expect(listProfiles()).toHaveLength(1);
  });

  it("throws a clear error on malformed JSON", () => {
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(getConfigPath(), "{ not json");
    expect(() => loadConfig()).toThrow(/not valid JSON/);
  });

  it("throws a clear error when the config file cannot be read", () => {
    fs.mkdirSync(getConfigPath(), { recursive: true });
    expect(() => loadConfig()).toThrow(/Unable to read config/);
  });

  it("picks up a persisted identifierType", () => {
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({
        activeProfile: "prod",
        profiles: {
          prod: {
            name: "prod",
            instanceUrl: "https://auth.example.com",
            identifierType: "phone",
          },
        },
      }),
    );
    expect(getProfile("prod")?.identifierType).toBe("phone");
  });

  it("falls back to the default active profile when unset", () => {
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({
        profiles: {
          prod: { name: "prod", instanceUrl: "https://auth.example.com" },
        },
      }),
    );
    expect(loadConfig().activeProfile).toBe("default");
  });
});

describe("upsertProfile", () => {
  it("makes the first profile active and stores no secrets", () => {
    upsertProfile({
      name: "prod",
      instanceUrl: "https://auth.example.com",
      email: "dev@example.com",
      sub: "user-123",
      identifierType: "email",
    });

    const onDisk = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    expect(onDisk.activeProfile).toBe("prod");

    const keys = Object.keys(onDisk.profiles.prod).sort();
    expect(keys).toEqual(["email", "identifierType", "instanceUrl", "name", "sub"]);
    expect(JSON.stringify(onDisk)).not.toMatch(/token/i);
  });

  it("does not steal the active profile from an existing one", () => {
    upsertProfile({ name: "prod", instanceUrl: "https://a.example.com" });
    upsertProfile({ name: "staging", instanceUrl: "https://b.example.com" });
    expect(loadConfig().activeProfile).toBe("prod");
  });
});

describe("setActiveProfile / removeProfile", () => {
  it("switches the active profile", () => {
    upsertProfile({ name: "prod", instanceUrl: "https://a.example.com" });
    upsertProfile({ name: "staging", instanceUrl: "https://b.example.com" });
    setActiveProfile("staging");
    expect(loadConfig().activeProfile).toBe("staging");
  });

  it("rejects switching to an unknown profile", () => {
    expect(() => setActiveProfile("ghost")).toThrow(/does not exist/);
  });

  it("reassigns the active profile when the active one is removed", () => {
    upsertProfile({ name: "prod", instanceUrl: "https://a.example.com" });
    upsertProfile({ name: "staging", instanceUrl: "https://b.example.com" });
    removeProfile("prod");
    expect(loadConfig().activeProfile).toBe("staging");
  });

  it("rejects removing an unknown profile", () => {
    expect(() => removeProfile("ghost")).toThrow(/does not exist/);
  });
});

describe("resolveActiveProfileName", () => {
  beforeEach(() => {
    upsertProfile({ name: "prod", instanceUrl: "https://a.example.com" });
    setActiveProfile("prod");
  });

  it("prefers the flag over env and persisted value", () => {
    process.env.SEAMLESS_PROFILE = "fromEnv";
    expect(resolveActiveProfileName({ profileFlag: "fromFlag" })).toBe("fromFlag");
  });

  it("uses the env var when no flag is given", () => {
    process.env.SEAMLESS_PROFILE = "fromEnv";
    expect(resolveActiveProfileName({})).toBe("fromEnv");
  });

  it("falls back to the persisted active profile", () => {
    expect(resolveActiveProfileName({})).toBe("prod");
  });

  it("falls back to the default profile name when nothing else is set", () => {
    expect(
      resolveActiveProfileName({}, { activeProfile: "", profiles: {} }),
    ).toBe("default");
  });
});

describe("normalizeInstanceUrl", () => {
  it("strips a trailing slash", () => {
    expect(normalizeInstanceUrl("https://auth.example.com/")).toBe(
      "https://auth.example.com",
    );
  });

  it("preserves a base path without a trailing slash", () => {
    expect(normalizeInstanceUrl("https://auth.example.com/base/")).toBe(
      "https://auth.example.com/base",
    );
  });

  it("allows http for localhost", () => {
    expect(normalizeInstanceUrl("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(normalizeInstanceUrl("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("rejects http for a non-local host", () => {
    expect(() => normalizeInstanceUrl("http://auth.example.com")).toThrow(
      /must use https/,
    );
  });

  it("rejects a value without a scheme", () => {
    expect(() => normalizeInstanceUrl("auth.example.com")).toThrow(/Invalid/);
  });

  it("rejects an empty value", () => {
    expect(() => normalizeInstanceUrl("  ")).toThrow(/required/);
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => normalizeInstanceUrl("ftp://auth.example.com")).toThrow(
      /must use http or https/,
    );
  });
});

describe("isLoopbackInstanceUrl", () => {
  it.each([
    "http://localhost:5312",
    "http://auth.localhost",
    "http://127.0.0.1:5312",
    "http://127.8.9.1",
    "http://[::1]:5312",
  ])("is true for %s", (url) => {
    expect(isLoopbackInstanceUrl(url)).toBe(true);
  });

  it.each([
    "http://auth.local",
    "http://192.168.1.10",
    "http://10.0.0.1",
    "http://0.0.0.0",
    "http://[::]",
    "https://auth.example.com",
    "http://127.0.0.1.example.com",
    "not a url",
  ])("is false for %s", (url) => {
    expect(isLoopbackInstanceUrl(url)).toBe(false);
  });
});

describe("isLocalInstanceUrl", () => {
  it.each([
    ["localhost", "http://localhost:5312"],
    ["a .localhost subdomain", "http://auth.localhost:5312"],
    ["IPv4 loopback", "http://127.0.0.1:5312"],
    ["the rest of the loopback /8", "http://127.0.0.2:5312"],
    ["IPv6 loopback", "http://[::1]:5312"],
    ["the unspecified IPv4 address a dev server binds to", "http://0.0.0.0:3000"],
    ["the unspecified IPv6 address", "http://[::]:3000"],
    ["a 10/8 LAN address", "http://10.1.2.3:5312"],
    ["a 192.168/16 LAN address", "http://192.168.1.10:5312"],
    ["the bottom of the 172.16/12 range", "http://172.16.0.1:5312"],
    ["the top of the 172.16/12 range", "http://172.31.255.254:5312"],
    ["a link-local address", "http://169.254.1.1:5312"],
    ["an mDNS .local name", "http://macbook.local:5312"],
    ["an IPv6 unique-local address", "http://[fd00::1]:5312"],
    ["an IPv6 link-local address", "http://[fe80::1]:5312"],
  ])("treats %s as local", (_label, url) => {
    expect(isLocalInstanceUrl(url)).toBe(true);
  });

  it.each([
    ["a public host", "https://auth.example.com"],
    ["a public IPv4 address", "http://93.184.216.34"],
    ["172.15, just below the private range", "http://172.15.0.1"],
    ["172.32, just above the private range", "http://172.32.0.1"],
    ["a host merely containing localhost", "https://notlocalhost.example.com"],
    ["a host ending in .local.example.com", "https://box.local.example.com"],
    ["a global IPv6 address", "http://[2606:4700::1111]"],
    ["something that is not a URL", "not a url"],
    ["an empty value", ""],
  ])("does not treat %s as local", (_label, url) => {
    expect(isLocalInstanceUrl(url)).toBe(false);
  });

  // Octets are numbers, not a prefix match: 1.10.0.0 is not inside 10/8.
  it("does not mistake a public address that starts with a private octet", () => {
    expect(isLocalInstanceUrl("http://1.10.0.1")).toBe(false);
    expect(isLocalInstanceUrl("http://100.64.0.1")).toBe(false);
  });
});

describe("provider settings", () => {
  it("round-trips the issuer and client id", () => {
    upsertProfile({
      name: "prod",
      instanceUrl: "https://api.example.com",
      oidcIssuer: "https://auth.example.com",
      oidcClientId: "cli",
    });
    expect(loadConfig().profiles.prod).toEqual({
      name: "prod",
      instanceUrl: "https://api.example.com",
      oidcIssuer: "https://auth.example.com",
      oidcClientId: "cli",
    });
  });
});

