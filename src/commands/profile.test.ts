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
import { loadConfig, upsertProfile } from "../core/config.js";
import { getTokens, saveTokens, setBackendForTesting, KeychainUnavailableError, type KeychainBackend } from "../core/keychain.js";
import { runProfile } from "./profile.js";

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

let configHome: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-profile-"));
  process.env.XDG_CONFIG_HOME = configHome;
  delete process.env.SEAMLESS_PROFILE;

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
  vi.restoreAllMocks();
  setBackendForTesting(null);
  fs.rmSync(configHome, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

function logs(): string[] {
  return logSpy.mock.calls.map((c) => c[0] as string);
}

describe("runProfile: unknown subcommand", () => {
  it("errors and exits 1 for an unrecognized subcommand", async () => {
    await expect(runProfile(["bogus"])).rejects.toThrow("exit:1");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown profile subcommand: bogus"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("errors and exits 1 when no subcommand is given", async () => {
    await expect(runProfile([])).rejects.toThrow("exit:1");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown profile subcommand: (none)"),
    );
  });
});

describe("runProfile list", () => {
  it("shows a hint when there are no profiles", async () => {
    await runProfile(["list"]);
    expect(logs().some((l) => l.includes("No profiles yet."))).toBe(true);
  });

  it("marks the active profile and shows the email when present", async () => {
    upsertProfile({ name: "prod", instanceUrl: "https://a.example.com", email: "dev@example.com" });
    upsertProfile({ name: "staging", instanceUrl: "https://b.example.com" });

    await runProfile(["list"]);

    const out = logs();
    expect(out.some((l) => l.includes("*") && l.includes("prod") && l.includes("dev@example.com"))).toBe(
      true,
    );
    expect(out.some((l) => l.includes("staging") && !l.includes("*"))).toBe(true);
  });
});

describe("runProfile add", () => {
  it("saves a profile from flags without prompting", async () => {
    await runProfile([
      "add",
      "prod",
      "--instance-url",
      "https://auth.example.com",
      "--identifier-type",
      "phone",
    ]);

    expect(text).not.toHaveBeenCalled();
    expect(loadConfig().profiles.prod).toMatchObject({
      name: "prod",
      instanceUrl: "https://auth.example.com",
      identifierType: "phone",
    });
    expect(outro).toHaveBeenCalledWith(
      expect.stringContaining('Profile "prod" saved (https://auth.example.com)'),
    );
  });

  it("defaults identifier type to email", async () => {
    await runProfile(["add", "prod", "--instance-url", "https://auth.example.com"]);
    expect(loadConfig().profiles.prod.identifierType).toBe("email");
  });

  it("rejects an invalid --identifier-type", async () => {
    await expect(
      runProfile(["add", "prod", "--instance-url", "https://a.example.com", "--identifier-type", "carrier-pigeon"]),
    ).rejects.toThrow("exit:1");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid --identifier-type "carrier-pigeon"'),
    );
  });

  it("prompts for a name when omitted, defaulting on empty answer", async () => {
    vi.mocked(text).mockResolvedValueOnce("").mockResolvedValueOnce("https://auth.example.com");

    await runProfile(["add"]);

    expect(loadConfig().profiles.default).toBeDefined();
  });

  it("prompts for a name and uses the given answer", async () => {
    vi.mocked(text).mockResolvedValueOnce("prod").mockResolvedValueOnce("https://auth.example.com");

    await runProfile(["add"]);

    expect(loadConfig().profiles.prod).toBeDefined();
  });

  it("cancels when the name prompt is cancelled", async () => {
    vi.mocked(text).mockResolvedValueOnce(CANCEL);

    await runProfile(["add"]);

    expect(cancel).toHaveBeenCalledWith("Cancelled.");
    expect(loadConfig().profiles).toEqual({});
  });

  it("prompts for the instance URL when omitted", async () => {
    vi.mocked(text).mockResolvedValueOnce("https://auth.example.com");

    await runProfile(["add", "prod"]);

    expect(loadConfig().profiles.prod.instanceUrl).toBe("https://auth.example.com");

    const call = vi.mocked(text).mock.calls[0][0] as { validate: (v: string) => string | undefined };
    expect(call.validate("")).toBe("Instance URL is required");
    expect(call.validate("not-a-url")).toMatch(/Invalid instance URL/);
    expect(call.validate("https://auth.example.com")).toBeUndefined();
  });

  it("cancels when the instance URL prompt is cancelled", async () => {
    vi.mocked(text).mockResolvedValueOnce(CANCEL);

    await runProfile(["add", "prod"]);

    expect(cancel).toHaveBeenCalledWith("Cancelled.");
    expect(loadConfig().profiles).toEqual({});
  });

  it("exits 1 when the flag-provided instance URL fails to normalize", async () => {
    await expect(
      runProfile(["add", "prod", "--instance-url", "not-a-url"]),
    ).rejects.toThrow("exit:1");
    expect(outro).toHaveBeenCalledWith(expect.stringContaining("Invalid instance URL"));
  });

  it("preserves the existing sub/email when updating a profile", async () => {
    upsertProfile({
      name: "prod",
      instanceUrl: "https://old.example.com",
      sub: "user-1",
      email: "dev@example.com",
    });

    await runProfile(["add", "prod", "--instance-url", "https://new.example.com"]);

    const updated = loadConfig().profiles.prod;
    expect(updated.sub).toBe("user-1");
    expect(updated.email).toBe("dev@example.com");
    expect(updated.instanceUrl).toBe("https://new.example.com");
  });
});

describe("runProfile use", () => {
  it("requires a name", async () => {
    await expect(runProfile(["use"])).rejects.toThrow("exit:1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: seamless profile use"));
  });

  it("errors when the profile does not exist", async () => {
    await expect(runProfile(["use", "ghost"])).rejects.toThrow("exit:1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
  });

  it("switches the active profile", async () => {
    upsertProfile({ name: "prod", instanceUrl: "https://a.example.com" });
    upsertProfile({ name: "staging", instanceUrl: "https://b.example.com" });

    await runProfile(["use", "staging"]);

    expect(loadConfig().activeProfile).toBe("staging");
    expect(logs().some((l) => l.includes('Active profile set to "staging".'))).toBe(true);
  });
});

describe("runProfile remove", () => {
  it("requires a name", async () => {
    await expect(runProfile(["remove"])).rejects.toThrow("exit:1");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: seamless profile remove"),
    );
  });

  it("errors when the profile does not exist", async () => {
    await expect(runProfile(["remove", "ghost"])).rejects.toThrow("exit:1");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
  });

  it("removes a profile and clears its stored tokens", async () => {
    const p = { name: "prod", instanceUrl: "https://a.example.com" };
    upsertProfile(p);
    await saveTokens(p, { accessToken: "a", refreshToken: "r" });

    await runProfile(["remove", "prod"]);

    expect(loadConfig().profiles.prod).toBeUndefined();
    expect(await getTokens(p)).toBeNull();
    expect(logs().some((l) => l.includes('Profile "prod" removed.'))).toBe(true);
  });

  it("reports when there is no keychain available", async () => {
    const p = { name: "prod", instanceUrl: "https://a.example.com" };
    upsertProfile(p);
    setBackendForTesting({
      get: () => null,
      set: () => {},
      delete: () => {
        throw new KeychainUnavailableError();
      },
    });

    await runProfile(["remove", "prod"]);

    expect(logs().some((l) => l.includes("No keychain available; no stored tokens to clear."))).toBe(
      true,
    );
    expect(logs().some((l) => l.includes('Profile "prod" removed.'))).toBe(true);
  });

  it("reports other errors clearing tokens without failing the removal", async () => {
    const p = { name: "prod", instanceUrl: "https://a.example.com" };
    upsertProfile(p);
    setBackendForTesting({
      get: () => null,
      set: () => {},
      delete: () => {
        throw new Error("keyring locked");
      },
    });

    await runProfile(["remove", "prod"]);

    expect(
      logs().some((l) => l.includes("Could not clear stored tokens: keyring locked")),
    ).toBe(true);
    expect(logs().some((l) => l.includes('Profile "prod" removed.'))).toBe(true);
  });
});

describe("profile add: reserved names", () => {
  it("rejects the name used for the portal session", async () => {
    await expect(
      runProfile([
        "add",
        "__portal__",
        "--instance-url",
        "https://auth.example.com",
      ]),
    ).rejects.toThrow("exit:1");

    expect(outro).toHaveBeenCalledWith(
      expect.stringContaining("reserved for the portal session"),
    );
    expect(loadConfig().profiles.__portal__).toBeUndefined();
  });
});

describe("profile login", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.endsWith("/login")
          ? {
              message: "Success",
              token: "e1",
              identifierType: "email",
              loginMethods: ["email_otp"],
            }
          : url.endsWith("/otp/generate-login-email-otp")
            ? { message: "sent" }
            : {
                message: "Success",
                token: "a",
                refreshToken: "r",
                email: "dev@example.com",
              };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs in to the named profile without changing the active one", async () => {
    upsertProfile({ name: "default", instanceUrl: "https://auth.example.com" });
    const prod = { name: "prod", instanceUrl: "https://prod.example.com" };
    upsertProfile(prod);
    vi.mocked(text).mockResolvedValueOnce("123456");

    await runProfile(["login", "prod", "dev@example.com"]);

    expect(await getTokens(prod)).not.toBeNull();
    expect(loadConfig().activeProfile).toBe("default");
    expect(loadConfig().portal).toBeUndefined();
  });

  it("accepts --identifier and falls back to the active profile", async () => {
    const active = { name: "default", instanceUrl: "https://auth.example.com" };
    upsertProfile(active);
    vi.mocked(text).mockResolvedValueOnce("123456");

    await runProfile(["login", "--identifier", "dev@example.com"]);

    expect(await getTokens(active)).not.toBeNull();
    // Only the code prompt ran; the identifier came from the flag.
    expect(vi.mocked(text)).toHaveBeenCalledTimes(1);
  });
});

describe("profile add without a terminal", () => {
  it("refuses the name prompt, pointing at the positional form", async () => {
    process.stdin.isTTY = false;

    await expect(runProfile(["add"])).rejects.toThrow(
      /"Profile name" needs an interactive terminal[\s\S]*seamless profile add <name>/,
    );
  });

  it("refuses the instance URL prompt, naming --instance-url", async () => {
    process.stdin.isTTY = false;

    await expect(runProfile(["add", "prod"])).rejects.toThrow(
      /"Instance URL" needs an interactive terminal[\s\S]*--instance-url/,
    );
  });
});
