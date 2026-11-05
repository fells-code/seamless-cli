import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountKey,
  assertKeychainUsable,
  deleteTokens,
  getTokens,
  KEYCHAIN_REQUIRED_MESSAGE,
  KeychainUnavailableError,
  saveTokens,
  setBackendForTesting,
  type KeychainBackend,
  type TokenBundle,
} from "./keychain.js";

function fakeBackend(): KeychainBackend & { store: Map<string, string> } {
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

const prod = { name: "prod", instanceUrl: "https://auth.example.com" };
const bundle: TokenBundle = {
  accessToken: "access-abc",
  refreshToken: "refresh-xyz",
  accessTokenExpiresAt: 1000,
  refreshTokenExpiresAt: 2000,
};

let backend: ReturnType<typeof fakeBackend>;

beforeEach(() => {
  backend = fakeBackend();
  setBackendForTesting(backend);
  delete process.env.SEAMLESS_REFRESH_TOKEN;
});

afterEach(() => {
  setBackendForTesting(null);
  delete process.env.SEAMLESS_REFRESH_TOKEN;
});

describe("accountKey", () => {
  it("scopes by profile name and instance URL", () => {
    expect(accountKey(prod)).toBe("prod::https://auth.example.com");
    expect(accountKey({ name: "prod", instanceUrl: "https://other.example.com" })).not.toBe(
      accountKey(prod),
    );
  });
});

describe("saveTokens / getTokens", () => {
  it("round-trips a token bundle", async () => {
    await saveTokens(prod, bundle);
    expect(await getTokens(prod)).toEqual(bundle);
  });

  it("keeps tokens for same-named profiles on different instances separate", async () => {
    const staging = { name: "prod", instanceUrl: "https://staging.example.com" };
    await saveTokens(prod, bundle);
    await saveTokens(staging, { accessToken: "a2", refreshToken: "r2" });

    expect((await getTokens(prod))?.refreshToken).toBe("refresh-xyz");
    expect((await getTokens(staging))?.refreshToken).toBe("r2");
    expect(backend.store.size).toBe(2);
  });

  it("returns null when nothing is stored", async () => {
    expect(await getTokens(prod)).toBeNull();
  });

  it("returns null on corrupt stored data", async () => {
    backend.set(accountKey(prod), "{ not json");
    expect(await getTokens(prod)).toBeNull();
  });
});

describe("SEAMLESS_REFRESH_TOKEN fallback", () => {
  it("returns the env refresh token without touching the keychain", async () => {
    process.env.SEAMLESS_REFRESH_TOKEN = "ci-refresh";
    setBackendForTesting({
      get: () => {
        throw new Error("keychain should not be read when env is set");
      },
      set: () => {},
      delete: () => false,
    });

    expect(await getTokens(prod)).toEqual({
      accessToken: "",
      refreshToken: "ci-refresh",
    });
  });
});

describe("deleteTokens", () => {
  it("clears a profile's entry", async () => {
    await saveTokens(prod, bundle);
    expect(await deleteTokens(prod)).toBe(true);
    expect(await getTokens(prod)).toBeNull();
  });

  it("reports false when there was nothing to delete", async () => {
    expect(await deleteTokens(prod)).toBe(false);
  });
});

describe("loadBackend (real backend, mocked @napi-rs/keyring)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@napi-rs/keyring");
    vi.resetModules();
  });

  it("wraps a failure to load the native module in a KeychainUnavailableError", async () => {
    vi.doMock("@napi-rs/keyring", () => {
      throw new Error("native module not found for this platform");
    });

    const mod = await import("./keychain.js");
    await expect(mod.saveTokens(prod, bundle)).rejects.toBeInstanceOf(
      mod.KeychainUnavailableError,
    );
  });

  it("gets, sets, and deletes through the real Entry-backed backend", async () => {
    const store = new Map<string, string>();
    vi.doMock("@napi-rs/keyring", () => ({
      Entry: class {
        account: string;
        constructor(_service: string, account: string) {
          this.account = account;
        }
        getPassword() {
          const value = store.get(this.account);
          if (value === undefined) throw new Error("no matching entry found");
          return value;
        }
        setPassword(secret: string) {
          store.set(this.account, secret);
        }
        deletePassword() {
          if (!store.has(this.account)) throw new Error("entry not found");
          store.delete(this.account);
          return true;
        }
      },
    }));

    const mod = await import("./keychain.js");

    expect(await mod.getTokens(prod)).toBeNull();

    await mod.saveTokens(prod, bundle);
    expect(await mod.getTokens(prod)).toEqual(bundle);

    expect(await mod.deleteTokens(prod)).toBe(true);
    expect(await mod.deleteTokens(prod)).toBe(false);
  });

  it("wraps unexpected keychain errors in a KeychainUnavailableError", async () => {
    vi.doMock("@napi-rs/keyring", () => ({
      Entry: class {
        getPassword(): string {
          throw new Error("permission denied");
        }
        setPassword(): void {
          throw new Error("permission denied");
        }
        deletePassword(): boolean {
          throw new Error("permission denied");
        }
      },
    }));

    const mod = await import("./keychain.js");
    await expect(mod.getTokens(prod)).rejects.toBeInstanceOf(
      mod.KeychainUnavailableError,
    );
    await expect(mod.saveTokens(prod, bundle)).rejects.toBeInstanceOf(
      mod.KeychainUnavailableError,
    );
    await expect(mod.deleteTokens(prod)).rejects.toBeInstanceOf(
      mod.KeychainUnavailableError,
    );
  });
});

describe("assertKeychainUsable", () => {
  function recording(overrides: Partial<KeychainBackend> = {}) {
    const store = new Map<string, string>();
    const backend: KeychainBackend = {
      get: (account) => store.get(account) ?? null,
      set: (account, secret) => {
        store.set(account, secret);
      },
      delete: (account) => store.delete(account),
      ...overrides,
    };
    return { store, backend };
  }

  afterEach(() => {
    setBackendForTesting(null);
  });

  it("passes on a keychain that can write, read and delete, and leaves nothing behind", async () => {
    const { store, backend } = recording();
    store.set("prod::https://auth.example.com", "existing");
    setBackendForTesting(backend);
    await expect(assertKeychainUsable()).resolves.toBeUndefined();
    expect([...store.keys()]).toEqual(["prod::https://auth.example.com"]);
  });

  it("refuses a keychain that cannot write, which a locked one can do while still reading", async () => {
    const { backend } = recording({
      set: () => {
        throw new KeychainUnavailableError();
      },
    });
    setBackendForTesting(backend);
    await expect(assertKeychainUsable()).rejects.toThrow(KEYCHAIN_REQUIRED_MESSAGE);
  });

  it("refuses a keychain that does not give back what it was given", async () => {
    const { backend } = recording({ get: () => null });
    setBackendForTesting(backend);
    await expect(assertKeychainUsable()).rejects.toThrow(KeychainUnavailableError);
  });

  it("refuses a keychain it cannot clean up", async () => {
    const { backend } = recording({
      delete: () => {
        throw new KeychainUnavailableError();
      },
    });
    setBackendForTesting(backend);
    await expect(assertKeychainUsable()).rejects.toThrow(KEYCHAIN_REQUIRED_MESSAGE);
  });

  it("says what to do, and does not offer SEAMLESS_REFRESH_TOKEN as something a sign-in can supply", () => {
    expect(KEYCHAIN_REQUIRED_MESSAGE).toMatch(/needs an OS keychain/);
    expect(KEYCHAIN_REQUIRED_MESSAGE).toMatch(/gnome-keyring/);
    expect(KEYCHAIN_REQUIRED_MESSAGE).toMatch(/from a machine with a keychain/);
    expect(KEYCHAIN_REQUIRED_MESSAGE).not.toContain("SEAMLESS_REFRESH_TOKEN");
  });
});

