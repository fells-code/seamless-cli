import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, isCancel } from "@clack/prompts";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  AdminApiError,
  deleteLoginHook,
  listLoginHookInvocations,
  listLoginHooks,
  LOGIN_HOOKS_UNSUPPORTED_MESSAGE,
  rotateLoginHookSecret,
  setLoginHook,
  testLoginHook,
} from "../core/admin.js";
import { apiInvocation, apiLoginHook, SECRET } from "../core/admin.fixtures.js";
import { runHooks } from "./hooks.js";

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(),
}));

vi.mock("../core/tty.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/tty.js")>();
  return { ...actual, requireInteractive: vi.fn() };
});

vi.mock("../core/authClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/authClient.js")>();
  return { ...actual, createAuthClient: vi.fn() };
});

vi.mock("../core/admin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/admin.js")>();
  return {
    ...actual,
    listLoginHooks: vi.fn(),
    setLoginHook: vi.fn(),
    deleteLoginHook: vi.fn(),
    rotateLoginHookSecret: vi.fn(),
    testLoginHook: vi.fn(),
    listLoginHookInvocations: vi.fn(),
  };
});

class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

const fakeClient: AuthClient = {
  profile: { name: "default", instanceUrl: "https://auth.example.com" },
  get: vi.fn(),
  post: vi.fn(),
  request: vi.fn(),
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAuthClient).mockResolvedValue(fakeClient);
  vi.mocked(isCancel).mockReturnValue(false);
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(listLoginHooks).mockResolvedValue([]);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

function logs(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
}

function errors(): string {
  return errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
}

function lastJson(): unknown {
  return JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
}

async function exits(args: string[]): Promise<void> {
  await expect(runHooks(args)).rejects.toBeInstanceOf(ExitError);
}

describe("runHooks", () => {
  it("prints usage on an unknown or missing subcommand", async () => {
    await exits(["bogus"]);
    expect(errors()).toContain("Unknown hooks subcommand: bogus");
    expect(logs()).toContain("Usage: seamless hooks <list|");

    await exits([]);
    expect(errors()).toContain("(none)");
  });

  it("passes --profile to the client", async () => {
    await runHooks(["list", "--profile", "staging"]);
    expect(createAuthClient).toHaveBeenCalledWith({ profileFlag: "staging" });
  });

  it("says an instance before v0.23 has no login hooks, and exits 1", async () => {
    vi.mocked(listLoginHooks).mockRejectedValue(new AdminApiError(LOGIN_HOOKS_UNSUPPORTED_MESSAGE));
    await exits(["list"]);
    expect(errors()).toContain("Seamless Auth API v0.23 or later");
  });

  it("refuses an unknown trigger", async () => {
    await exits(["get", "on_logout"]);
    expect(errors()).toContain("The trigger is post_login or pre_token, not on_logout.");
    await exits(["get"]);
    expect(errors()).toContain("Usage: seamless hooks get");
  });
});

describe("hooks list and get", () => {
  it("lists hooks with their settings", async () => {
    vi.mocked(listLoginHooks).mockResolvedValue([
      apiLoginHook(),
      apiLoginHook({
        trigger: "pre_token",
        enabled: false,
        failureMode: "open",
        previousSecretExpiresAt: "2026-07-14T10:00:00.000Z",
      }),
    ]);
    await runHooks(["list"]);
    expect(logs()).toContain("post_login");
    expect(logs()).toContain("2000 ms, fails closed");
    expect(logs()).toContain("disabled");
    expect(logs()).toContain("fails open");
    expect(logs()).toContain("previous secret signs too until 2026-07-14");

    await runHooks(["list", "--json"]);
    expect(lastJson()).toHaveLength(2);
  });

  it("says so when there are none", async () => {
    await runHooks(["list"]);
    expect(logs()).toContain("No login hooks.");
  });

  it("gets one trigger's hook, or says none is set", async () => {
    vi.mocked(listLoginHooks).mockResolvedValue([apiLoginHook()]);
    await runHooks(["get", "post_login"]);
    expect(logs()).toContain("https://hooks.example.com/login");
    await runHooks(["get", "post_login", "--json"]);
    expect(lastJson()).toMatchObject({ trigger: "post_login" });

    await exits(["get", "pre_token"]);
    expect(errors()).toContain("No pre_token hook is set.");
  });
});

describe("hooks set", () => {
  it("creates a hook with defaults, prints the secret once, and warns that it fails closed", async () => {
    vi.mocked(setLoginHook).mockResolvedValue({ hook: apiLoginHook(), secret: SECRET });
    await runHooks(["set", "post_login", "--url", "https://hooks.example.com/login"]);
    expect(setLoginHook).toHaveBeenCalledWith(fakeClient, "post_login", {
      url: "https://hooks.example.com/login",
      timeoutMs: 2000,
      failureMode: "closed",
      enabled: true,
    });
    expect(logs()).toContain("Created the post_login hook.");
    expect(logs()).toContain("fails closed: while it is down");
    expect(logSpy.mock.calls.filter((c) => c[0] === SECRET)).toHaveLength(1);
  });

  it("changes only what a flag names on an existing hook, and prints no secret", async () => {
    vi.mocked(listLoginHooks).mockResolvedValue([
      apiLoginHook({ trigger: "pre_token", timeoutMs: 900, failureMode: "open" }),
    ]);
    vi.mocked(setLoginHook).mockResolvedValue({
      hook: apiLoginHook({ trigger: "pre_token", timeoutMs: 900, failureMode: "open", enabled: false }),
    });
    await runHooks(["set", "pre_token", "--disable"]);
    expect(setLoginHook).toHaveBeenCalledWith(fakeClient, "pre_token", {
      url: "https://hooks.example.com/login",
      timeoutMs: 900,
      failureMode: "open",
      enabled: false,
    });
    expect(logs()).toContain("Updated the pre_token hook.");
    expect(logs()).not.toContain("shown once");
    expect(logs()).not.toContain("fails closed: while");
  });

  it("warns when an existing hook is switched to fail closed, and prints JSON on request", async () => {
    vi.mocked(listLoginHooks).mockResolvedValue([apiLoginHook({ failureMode: "open" })]);
    vi.mocked(setLoginHook).mockResolvedValue({ hook: apiLoginHook() });
    await runHooks(["set", "post_login", "--failure-mode", "closed", "--timeout", "3000", "--enable"]);
    expect(setLoginHook).toHaveBeenCalledWith(
      fakeClient,
      "post_login",
      expect.objectContaining({ failureMode: "closed", timeoutMs: 3000, enabled: true }),
    );
    expect(logs()).toContain("fails closed: while");

    await runHooks(["set", "post_login", "--url", "https://hooks.example.com/v2", "--json"]);
    expect(lastJson()).toEqual({ hook: apiLoginHook() });
  });

  it("needs a url for a new hook and a change for an existing one", async () => {
    await exits(["set", "post_login"]);
    expect(errors()).toContain("No post_login hook is set yet. Pass --url to create one.");

    vi.mocked(listLoginHooks).mockResolvedValue([apiLoginHook()]);
    await exits(["set", "post_login"]);
    expect(errors()).toContain("Nothing to change.");
    expect(setLoginHook).not.toHaveBeenCalled();
  });

  it("refuses a bad timeout, failure mode or url before asking the API", async () => {
    for (const timeout of ["50", "6000", "fast"]) {
      await exits(["set", "post_login", "--url", "https://x.example", "--timeout", timeout]);
    }
    expect(errors()).toContain("--timeout is a whole number of milliseconds between 100 and 5000.");

    await exits(["set", "post_login", "--url", "https://x.example", "--failure-mode", "maybe"]);
    expect(errors()).toContain("--failure-mode is open or closed, not maybe.");

    await exits(["set", "post_login", "--url", "ftp://x.example"]);
    expect(errors()).toContain("url: must use https");
    expect(setLoginHook).not.toHaveBeenCalled();
  });
});

describe("hooks delete", () => {
  it("confirms, then deletes; --force skips the question; declining does nothing", async () => {
    await runHooks(["delete", "pre_token"]);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Delete the pre_token hook") }),
    );
    expect(deleteLoginHook).toHaveBeenCalledWith(fakeClient, "pre_token");
    expect(logs()).toContain("Deleted the pre_token hook.");

    vi.mocked(confirm).mockClear();
    await runHooks(["delete", "pre_token", "--force"]);
    expect(confirm).not.toHaveBeenCalled();

    vi.mocked(confirm).mockResolvedValue(false);
    await runHooks(["delete", "pre_token"]);
    expect(deleteLoginHook).toHaveBeenCalledTimes(2);
    expect(logs()).toContain("Cancelled.");
  });
});

describe("hooks rotate-secret", () => {
  const rotated = { secret: SECRET, previousSecretExpiresAt: "2026-07-14T10:00:00.000Z" };

  it("rotates without asking when no rotation is in progress", async () => {
    vi.mocked(listLoginHooks).mockResolvedValue([apiLoginHook()]);
    vi.mocked(rotateLoginHookSecret).mockResolvedValue(rotated);
    await runHooks(["rotate-secret", "post_login"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.filter((c) => c[0] === SECRET)).toHaveLength(1);
    expect(logs()).toContain("signs beside it until 2026-07-14T10:00:00.000Z");

    await runHooks(["rotate-secret", "post_login", "--json"]);
    expect(lastJson()).toEqual(rotated);
  });

  it("asks before cutting a rotation in progress short", async () => {
    vi.mocked(listLoginHooks).mockResolvedValue([
      apiLoginHook({ previousSecretExpiresAt: "2026-07-14T09:00:00.000Z" }),
    ]);
    vi.mocked(confirm).mockResolvedValue(false);
    await runHooks(["rotate-secret", "post_login"]);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("still rotating") }),
    );
    expect(rotateLoginHookSecret).not.toHaveBeenCalled();
    expect(logs()).toContain("Cancelled.");
  });

  it("says when there is no hook to rotate", async () => {
    await exits(["rotate-secret", "pre_token"]);
    expect(errors()).toContain("No pre_token hook is set.");
  });
});

describe("hooks test", () => {
  it("reports the result, and exits 1 on a failure", async () => {
    vi.mocked(testLoginHook).mockResolvedValue({
      ok: true,
      failure: null,
      statusCode: 200,
      durationMs: 40,
    });
    await runHooks(["test", "post_login"]);
    expect(testLoginHook).toHaveBeenCalledWith(fakeClient, "post_login");
    expect(logs()).toContain("Test call succeeded (200, 40 ms).");

    vi.mocked(testLoginHook).mockResolvedValue({
      ok: false,
      failure: "timed_out",
      statusCode: null,
      durationMs: 2000,
    });
    await exits(["test", "post_login"]);
    expect(errors()).toContain("Test call failed: timed_out, after 2000 ms.");
  });
});

describe("hooks invocations", () => {
  it("lists invocations with an outcome filter and limit", async () => {
    vi.mocked(listLoginHookInvocations).mockResolvedValue([
      apiInvocation(),
      apiInvocation({ outcome: "failed_open", failure: "timed_out", statusCode: null, userId: null }),
      apiInvocation({ outcome: "denied", statusCode: 200 }),
    ]);
    await runHooks(["invocations", "post_login", "--outcome", "denied", "--limit", "10"]);
    expect(listLoginHookInvocations).toHaveBeenCalledWith(fakeClient, "post_login", {
      limit: 10,
      outcome: "denied",
    });
    expect(logs()).toContain("allowed");
    expect(logs()).toContain("failed_open");
    expect(logs()).toContain("no user");
    expect(logs()).toContain("timed_out, 42 ms");

    await runHooks(["invocations", "post_login", "--json"]);
    expect(listLoginHookInvocations).toHaveBeenLastCalledWith(fakeClient, "post_login", {
      limit: 50,
      outcome: undefined,
    });
    expect(lastJson()).toHaveLength(3);
  });

  it("says so when there are none, and refuses an unknown outcome", async () => {
    vi.mocked(listLoginHookInvocations).mockResolvedValue([]);
    await runHooks(["invocations", "pre_token"]);
    expect(logs()).toContain("No pre_token invocations.");

    await exits(["invocations", "pre_token", "--outcome", "maybe"]);
    expect(errors()).toContain("--outcome is one of allowed, denied, failed_open, failed_closed");
  });
});
