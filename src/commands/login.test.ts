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

import { CANCEL, cancel, intro, outro, text } from "@clack/prompts";
import { loadConfig, savePortalSession, upsertProfile } from "../core/config.js";
import {
  KeychainUnavailableError,
  getTokens,
  setBackendForTesting,
  type KeychainBackend,
} from "../core/keychain.js";
import { runLogin } from "./login.js";

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

function mockRouter(routes: Record<string, Array<() => Response>>): Call[] {
  const calls: Call[] = [];
  const queues = new Map<string, Array<() => Response>>(Object.entries(routes));

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const key = Object.keys(routes).find((p) => url.endsWith(p));
      if (!key) throw new Error(`No route for ${url}`);
      const queue = queues.get(key)!;
      const responder = queue.length > 1 ? queue.shift()! : queue[0];
      return responder();
    }),
  );

  return calls;
}

const profile = { name: "default", instanceUrl: "https://auth.example.com" };

const PORTAL_URL = "https://portal.example.com";
const portalTarget = { name: "__portal__", instanceUrl: PORTAL_URL };

let configHome: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-login-"));
  process.env.XDG_CONFIG_HOME = configHome;
  delete process.env.SEAMLESS_PROFILE;
  delete process.env.SEAMLESS_REFRESH_TOKEN;
  process.env.SEAMLESS_PORTAL_AUTH_URL = PORTAL_URL;

  setBackendForTesting(fakeBackend());

  vi.mocked(text).mockReset();
  vi.mocked(intro).mockClear();
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
  delete process.env.SEAMLESS_PORTAL_AUTH_URL;
});

function logs(): string[] {
  return logSpy.mock.calls.map((c) => c[0] as string);
}

describe("runLogin: no configuration", () => {
  it("signs in to the portal without a profile", async () => {
    const calls = mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () =>
          json({
            message: "Success",
            token: "a",
            refreshToken: "r",
            email: "dev@example.com",
          }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("dev@example.com").mockResolvedValueOnce("123456");

    await runLogin([]);

    expect(loadConfig().profiles).toEqual({});
    expect(calls.every((c) => c.url.startsWith(PORTAL_URL))).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("runLogin: identifier prompt", () => {
  it("cancels when the identifier prompt is cancelled", async () => {
    vi.mocked(text).mockResolvedValueOnce(CANCEL);

    await runLogin([]);

    expect(cancel).toHaveBeenCalledWith("Cancelled.");
  });

  it("uses the --identifier flag without prompting", async () => {
    mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () =>
          json({
            message: "Success",
            token: "a",
            refreshToken: "r",
            sub: "user-1",
            email: "dev@example.com",
          }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("123456");

    await runLogin(["--identifier", "dev@example.com"]);

    // Only the code prompt should have run, not the identifier prompt.
    expect(vi.mocked(text)).toHaveBeenCalledTimes(1);
  });

  it("uses a positional identifier without prompting", async () => {
    mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () => json({ message: "Success", token: "a", refreshToken: "r" }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("123456");

    await runLogin(["dev@example.com"]);

    expect(vi.mocked(text)).toHaveBeenCalledTimes(1);
  });
});

describe("runLogin: prefill", () => {
  it("offers the previous portal email as the default identifier", async () => {
    savePortalSession({ instanceUrl: PORTAL_URL, email: "dev@example.com" });
    mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () => json({ message: "Success", token: "a", refreshToken: "r" }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("dev@example.com").mockResolvedValueOnce("123456");

    await runLogin([]);

    const idCall = vi.mocked(text).mock.calls[0][0] as {
      initialValue: string;
      placeholder: string;
    };
    expect(idCall.initialValue).toBe("dev@example.com");
    expect(idCall.placeholder).toBe("dev@example.com");
  });
});

describe("runLogin: success", () => {
  it("logs in, saves tokens, and records the portal session", async () => {
    mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () =>
          json({
            message: "Success",
            token: "access-1",
            refreshToken: "refresh-1",
            sub: "user-1",
            email: "dev@example.com",
          }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("dev@example.com").mockResolvedValueOnce("123456");

    await runLogin([]);

    const stored = await getTokens(portalTarget);
    expect(stored?.accessToken).toBe("access-1");
    expect(stored?.refreshToken).toBe("refresh-1");

    const portal = loadConfig().portal!;
    expect(portal.instanceUrl).toBe(PORTAL_URL);
    expect(portal.sub).toBe("user-1");
    expect(portal.email).toBe("dev@example.com");
    expect(portal.identifierType).toBe("email");

    // The portal session must not leak into the profile map, which means auth
    // instances the developer administers.
    expect(loadConfig().profiles).toEqual({});

    expect(outro).toHaveBeenCalledWith(
      expect.stringContaining("Signed in to the Seamless portal as dev@example.com."),
    );
  });

  it("falls back to the identifier in the outro message when the response omits email", async () => {
    mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () => json({ message: "Success", token: "a", refreshToken: "r" }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("dev@example.com").mockResolvedValueOnce("123456");

    await runLogin([]);

    expect(outro).toHaveBeenCalledWith(
      expect.stringContaining("Signed in to the Seamless portal as dev@example.com."),
    );
  });

  it("cancels when the code prompt is cancelled", async () => {
    mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
    });
    vi.mocked(text).mockResolvedValueOnce("dev@example.com").mockResolvedValueOnce(CANCEL);

    await runLogin([]);

    expect(cancel).toHaveBeenCalledWith("Cancelled.");
  });

  it("notifies on an incorrect code with correct pluralization, then succeeds", async () => {
    mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () => json({ error: "Not allowed" }, 401),
        () => json({ error: "Not allowed" }, 401),
        () => json({ message: "Success", token: "a", refreshToken: "r" }),
      ],
    });
    vi.mocked(text)
      .mockResolvedValueOnce("dev@example.com")
      .mockResolvedValueOnce("000000")
      .mockResolvedValueOnce("000000")
      .mockResolvedValueOnce("123456");

    await runLogin([]);

    const out = logs();
    expect(out.some((l) => l.includes("2 attempts left"))).toBe(true);
    expect(out.some((l) => l.includes("1 attempt left"))).toBe(true);
    expect(
      out.some((l) =>
        l.includes("If an account exists for dev@example.com, a code is on its way."),
      ),
    ).toBe(true);
  });

  it("hints the email code shape without rejecting another one", async () => {
    mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () => json({ message: "Success", token: "a", refreshToken: "r" }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("dev@example.com").mockResolvedValueOnce("ABCDEF");

    await runLogin([]);

    const codeCall = vi.mocked(text).mock.calls[1][0] as {
      placeholder: string;
      validate: (v: string) => string | undefined;
    };
    expect(codeCall.placeholder).toBe("ABCDEF");
    expect(codeCall.validate("A1B2C3")).toBeUndefined();
    expect(codeCall.validate("")).toBe("A code is required");
  });

  it("verifies with the email code exactly as it was typed", async () => {
    const calls = mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () => json({ message: "Success", token: "a", refreshToken: "r" }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("dev@example.com").mockResolvedValueOnce("abcdef");

    await runLogin([]);

    const verify = calls.find((c) => c.url.endsWith("/otp/verify-login-email-otp"))!;
    expect(verify.init.body).toBe(JSON.stringify({ verificationToken: "abcdef" }));
  });

  it("hints the phone code shape without rejecting another one", async () => {
    mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "phone",
            loginMethods: ["phone_otp"],
          }),
      ],
      "/otp/generate-login-phone-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-phone-otp": [
        () => json({ message: "Success", token: "a", refreshToken: "r" }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("+15555550100").mockResolvedValueOnce("123456");

    await runLogin([]);

    const codeCall = vi.mocked(text).mock.calls[1][0] as {
      placeholder: string;
      validate: (v: string) => string | undefined;
    };
    expect(codeCall.placeholder).toBe("123456");
    expect(codeCall.validate("12345678901")).toBeUndefined();
    expect(codeCall.validate("  ")).toBe("A code is required");
  });

  it("validates the identifier prompt input", async () => {
    mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () => json({ message: "Success", token: "a", refreshToken: "r" }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("dev@example.com").mockResolvedValueOnce("123456");

    await runLogin([]);

    const idCall = vi.mocked(text).mock.calls[0][0] as {
      validate: (v: string) => string | undefined;
    };
    expect(idCall.validate("")).toBe("An identifier is required");
    expect(idCall.validate("dev@example.com")).toBeUndefined();
  });

  it("notifies when the ephemeral code window expires and a new code is sent", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
        () =>
          json({
            message: "Success",
            token: "e2",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () => json({ message: "Success", token: "a", refreshToken: "r" }),
      ],
    });

    let askedCode = false;
    vi.mocked(text).mockImplementation(async (opts: unknown) => {
      const message = (opts as { message: string }).message;
      if (message === "Email or phone") return "dev@example.com";
      if (!askedCode) {
        askedCode = true;
        now += 6 * 60 * 1000;
        return "111111";
      }
      return "654321";
    });

    await runLogin([]);

    expect(logs().some((l) => l.includes("Your previous code expired"))).toBe(true);
  });
});

describe("runLogin: local delivery", () => {
  beforeEach(() => {
    process.env.SEAMLESS_PORTAL_AUTH_URL = "http://localhost:5312";
  });

  it("auto-fills the OTP from the response without prompting for a code", async () => {
    const calls = mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [
        () =>
          json({
            message: "sent",
            delivery: { kind: "otp_email", to: "dev@example.com", token: "ABCDEF" },
          }),
      ],
      "/otp/verify-login-email-otp": [
        () =>
          json({
            message: "Success",
            token: "a",
            refreshToken: "r",
            sub: "user-1",
            email: "dev@example.com",
          }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("dev@example.com");

    await runLogin(["--local"]);

    // Only the identifier prompt runs; the code is never prompted.
    expect(vi.mocked(text)).toHaveBeenCalledTimes(1);
    const stored = await getTokens({
      name: "__portal__",
      instanceUrl: "http://localhost:5312",
    });
    expect(stored?.accessToken).toBe("a");

    const generate = calls.find((c) =>
      c.url.endsWith("/otp/generate-login-email-otp"),
    )!;
    expect(
      (generate.init.headers as Record<string, string>)["x-seamless-auth-delivery-mode"],
    ).toBe("external");
  });

  it("rejects --local against a non-local portal", async () => {
    process.env.SEAMLESS_PORTAL_AUTH_URL = PORTAL_URL;

    await expect(runLogin(["--local"])).rejects.toThrow("exit:1");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--local only works against a local portal"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("runLogin: deprecated --profile shim", () => {
  it("routes to instance login and warns", async () => {
    upsertProfile(profile);
    const calls = mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () =>
          json({
            message: "Success",
            token: "a",
            refreshToken: "r",
            email: "dev@example.com",
          }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("dev@example.com").mockResolvedValueOnce("123456");

    await runLogin(["--profile", "default"]);

    expect(
      logs().some((l) => l.includes("seamless profile login default")),
    ).toBe(true);
    // The instance, not the portal, is the login target.
    expect(calls.every((c) => c.url.startsWith(profile.instanceUrl))).toBe(true);
    expect(await getTokens(profile)).not.toBeNull();
    expect(loadConfig().portal).toBeUndefined();
  });
});

describe("runLogin: failure handling", () => {
  it("exits 1 with a red message on a LoginError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    vi.mocked(text).mockResolvedValueOnce("dev@example.com");

    await expect(runLogin([])).rejects.toThrow("exit:1");
    expect(outro).toHaveBeenCalledWith(expect.stringContaining("Could not reach"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 with a red message when the keychain is unavailable", async () => {
    mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () => json({ message: "Success", token: "a", refreshToken: "r" }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("dev@example.com").mockResolvedValueOnce("123456");

    setBackendForTesting({
      get: () => null,
      set: () => {
        throw new KeychainUnavailableError();
      },
      delete: () => false,
    });

    await expect(runLogin([])).rejects.toThrow("exit:1");
    expect(outro).toHaveBeenCalledWith(expect.stringContaining("No OS keychain is available"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("propagates unexpected errors", async () => {
    mockRouter({
      "/login": [
        () =>
          json({
            message: "Success",
            token: "e1",
            identifierType: "email",
            loginMethods: ["email_otp"],
          }),
      ],
      "/otp/generate-login-email-otp": [() => json({ message: "sent" })],
      "/otp/verify-login-email-otp": [
        () => json({ message: "Success", token: "a", refreshToken: "r" }),
      ],
    });
    vi.mocked(text).mockResolvedValueOnce("dev@example.com").mockResolvedValueOnce("123456");

    setBackendForTesting({
      get: () => null,
      set: () => {
        throw new Error("disk on fire");
      },
      delete: () => false,
    });

    await expect(runLogin([])).rejects.toThrow("disk on fire");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("runLogin without a terminal", () => {
  it("refuses the identifier prompt, naming --identifier", async () => {
    process.stdin.isTTY = false;

    await expect(runLogin([])).rejects.toThrow(
      /"Email or phone" needs an interactive terminal[\s\S]*--identifier/,
    );
  });
});
