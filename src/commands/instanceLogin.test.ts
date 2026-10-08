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
  };
});

import { CANCEL, cancel, outro, text } from "@clack/prompts";
import { loadConfig, upsertProfile } from "../core/config.js";
import {
  KeychainUnavailableError,
  getTokens,
  setBackendForTesting,
  type KeychainBackend,
} from "../core/keychain.js";
import { loginToInstance } from "./instanceLogin.js";

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

function mockOtpRoutes(verify: () => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/login")) {
        return json({
          message: "Success",
          token: "e1",
          identifierType: "email",
          loginMethods: ["email_otp"],
        });
      }
      if (url.endsWith("/otp/generate-login-email-otp")) {
        return json({ message: "sent" });
      }
      return verify();
    }),
  );
}

const profile = { name: "default", instanceUrl: "https://auth.example.com" };

let configHome: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-instance-login-"));
  process.env.XDG_CONFIG_HOME = configHome;
  delete process.env.SEAMLESS_PROFILE;
  delete process.env.SEAMLESS_REFRESH_TOKEN;

  setBackendForTesting(fakeBackend());

  vi.mocked(text).mockReset();
  vi.mocked(outro).mockClear();
  vi.mocked(cancel).mockClear();

  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setBackendForTesting(null);
  fs.rmSync(configHome, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

describe("loginToInstance", () => {
  it("errors and exits 1 when no profile is configured", async () => {
    await expect(loginToInstance()).rejects.toThrow("exit:1");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("No active profile is configured."),
    );
    expect(
      logSpy.mock.calls.some((c) =>
        (c[0] as string).includes("seamless profile add"),
      ),
    ).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects --local against a non-local instance", async () => {
    upsertProfile(profile);

    await expect(loginToInstance({ local: true })).rejects.toThrow("exit:1");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--local only works against a local instance"),
    );
  });

  it("saves tokens and updates the profile on success", async () => {
    upsertProfile(profile);
    mockOtpRoutes(() =>
      json({
        message: "Success",
        token: "access-1",
        refreshToken: "refresh-1",
        sub: "user-1",
        email: "dev@example.com",
      }),
    );
    vi.mocked(text).mockResolvedValueOnce("123456");

    await loginToInstance({ identifier: "dev@example.com" });

    const stored = await getTokens(profile);
    expect(stored?.refreshToken).toBe("refresh-1");

    const updated = loadConfig().profiles.default;
    expect(updated.sub).toBe("user-1");
    expect(updated.email).toBe("dev@example.com");

    // Signing in to an instance must not create a portal session.
    expect(loadConfig().portal).toBeUndefined();
    expect(outro).toHaveBeenCalledWith(
      expect.stringContaining("Logged in to default as dev@example.com."),
    );
  });

  it("targets a named profile without switching the active one", async () => {
    upsertProfile(profile);
    const other = { name: "other", instanceUrl: "https://other.example.com" };
    upsertProfile(other);
    mockOtpRoutes(() => json({ message: "Success", token: "a", refreshToken: "r" }));
    vi.mocked(text).mockResolvedValueOnce("123456");

    await loginToInstance({
      profileName: "other",
      identifier: "dev@example.com",
    });

    expect(await getTokens(other)).not.toBeNull();
    expect(await getTokens(profile)).toBeNull();
    expect(loadConfig().activeProfile).toBe("default");
  });

  it("announces local delivery and reads the code from the response", async () => {
    const local = { name: "default", instanceUrl: "http://localhost:5312" };
    upsertProfile(local);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/login")) {
          return json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          });
        }
        if (url.endsWith("/otp/generate-login-email-otp")) {
          return json({
            message: "sent",
            delivery: { kind: "otp_email", to: "dev@example.com", token: "ABCDEF" },
          });
        }
        return json({ message: "Success", token: "a", refreshToken: "r" });
      }),
    );

    await loginToInstance({ identifier: "dev@example.com", local: true });

    expect(vi.mocked(text)).not.toHaveBeenCalled();
    expect(
      logSpy.mock.calls.some((c) =>
        (c[0] as string).includes("Local delivery on"),
      ),
    ).toBe(true);
  });

  it("cancels when a prompt is cancelled", async () => {
    upsertProfile(profile);
    vi.mocked(text).mockResolvedValueOnce(CANCEL);

    await loginToInstance();

    expect(cancel).toHaveBeenCalledWith("Cancelled.");
  });

  it("exits 1 with a red message on a LoginError", async () => {
    upsertProfile(profile);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(
      loginToInstance({ identifier: "dev@example.com" }),
    ).rejects.toThrow("exit:1");
    expect(outro).toHaveBeenCalledWith(
      expect.stringContaining("Could not reach"),
    );
  });

  it("exits 1 when the keychain is unavailable", async () => {
    upsertProfile(profile);
    mockOtpRoutes(() => json({ message: "Success", token: "a", refreshToken: "r" }));
    vi.mocked(text).mockResolvedValueOnce("123456");
    setBackendForTesting({
      get: () => null,
      set: () => {
        throw new KeychainUnavailableError();
      },
      delete: () => false,
    });

    await expect(
      loginToInstance({ identifier: "dev@example.com" }),
    ).rejects.toThrow("exit:1");
    expect(outro).toHaveBeenCalledWith(
      expect.stringContaining("No OS keychain is available"),
    );
  });

  it("propagates unexpected errors", async () => {
    upsertProfile(profile);
    mockOtpRoutes(() => json({ message: "Success", token: "a", refreshToken: "r" }));
    vi.mocked(text).mockResolvedValueOnce("123456");
    setBackendForTesting({
      get: () => null,
      set: () => {
        throw new Error("disk on fire");
      },
      delete: () => false,
    });

    await expect(
      loginToInstance({ identifier: "dev@example.com" }),
    ).rejects.toThrow("disk on fire");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
