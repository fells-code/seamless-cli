import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthClient } from "../core/authClient.js";
import type { ApiResponse } from "../core/http.js";
import { createAuthClient, ReauthRequiredError } from "../core/authClient.js";
import { clearLocalSession } from "../core/session.js";
import { runSessions } from "./sessions.js";

vi.mock("../core/authClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/authClient.js")>();
  return { ...actual, createAuthClient: vi.fn() };
});

vi.mock("../core/session.js", () => ({
  clearLocalSession: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: (value: unknown) => value === CANCEL_SYMBOL,
}));

import { confirm } from "@clack/prompts";
import type { Session } from "@seamless-auth/types";

const CANCEL_SYMBOL = Symbol("cancel");

function response<T>(status: number, data: T | null): ApiResponse<T> {
  return { ok: status >= 200 && status < 300, status, data, headers: new Headers() };
}

// A /sessions body as the API sends it, filling the fields every row carries so a
// test only spells out the ones it is about.
function sessionList(rows: Array<Partial<Session> & { id: string }>) {
  return {
    total: rows.length,
    sessions: rows.map((row) => ({
      lastUsedAt: "2026-07-13T09:00:00.000Z",
      expiresAt: "2026-07-20T09:00:00.000Z",
      current: false,
      ...row,
    })),
  };
}

function fakeClient(
  handler: (method: string, path: string) => ApiResponse<unknown>,
): AuthClient {
  return {
    profile: { name: "default", instanceUrl: "https://auth.example.com" },
    get: async (path) => handler("GET", path) as never,
    post: async (path) => handler("POST", path) as never,
    request: async (path, init) =>
      handler((init?.method ?? "GET").toUpperCase(), path) as never,
  };
}

let logs: string[];
let errors: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logs = [];
  errors = [];
  vi.mocked(createAuthClient).mockReset();
  vi.mocked(confirm).mockReset();
  vi.mocked(clearLocalSession).mockReset();
  vi.mocked(clearLocalSession).mockResolvedValue(undefined);

  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    logs.push(String(msg ?? ""));
  });
  vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
    errors.push(String(msg ?? ""));
  });
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function output(): string {
  return logs.join("\n");
}

function errOutput(): string {
  return errors.join("\n");
}

describe("runSessions — dispatch", () => {
  it("prints a yellow message and exits 1 on ReauthRequiredError", async () => {
    vi.mocked(createAuthClient).mockRejectedValue(
      new ReauthRequiredError("No active profile is configured."),
    );
    await expect(runSessions([])).rejects.toThrow("process.exit(1)");
    expect(output()).toContain("No active profile is configured.");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prints a red message and exits 1 on any other error", async () => {
    const client = fakeClient(() => response(500, null));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    await expect(runSessions(["revoke"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Usage: seamless sessions revoke");
  });

  it("passes the --profile flag through to createAuthClient", async () => {
    const client = fakeClient(() => response(200, sessionList([])));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    await runSessions(["list", "--profile", "staging"]);
    expect(createAuthClient).toHaveBeenCalledWith({ profileFlag: "staging" });
  });

  it("defaults to list for an unrecognized subcommand", async () => {
    const client = fakeClient(() => response(200, sessionList([])));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    await runSessions(["bogus"]);
    expect(output()).toContain("No active sessions.");
  });
});

describe("runSessions list", () => {
  it("prints 'No active sessions.' for an empty list", async () => {
    const client = fakeClient(() => response(200, sessionList([])));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runSessions(["list"]);

    expect(output()).toContain("No active sessions.");
  });

  it("prints the sessions as JSON with --json", async () => {
    const rows = [
      { id: "s1", deviceName: "MacBook", ipAddress: "203.0.113.4", current: true },
      { id: "s2", current: false },
    ];
    const client = fakeClient(() => response(200, sessionList(rows)));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runSessions(["list", "--json"]);

    const parsed = JSON.parse(output());
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ id: "s1", deviceName: "MacBook", current: true });
    expect(parsed[1]).toMatchObject({ id: "s2", current: false });
  });

  // A script piping to jq wants valid JSON for the empty case too, not prose.
  it("prints an empty array rather than a message when --json finds nothing", async () => {
    const client = fakeClient(() => response(200, sessionList([])));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runSessions(["list", "--json"]);

    expect(JSON.parse(output())).toEqual([]);
    expect(output()).not.toContain("No active sessions.");
  });

  it("still lists when --json is combined with --profile", async () => {
    const client = fakeClient(() => response(200, sessionList([{ id: "s1" }])));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runSessions(["list", "--profile", "staging", "--json"]);

    expect(createAuthClient).toHaveBeenCalledWith({ profileFlag: "staging" });
    expect(JSON.parse(output())[0]).toMatchObject({ id: "s1" });
  });

  it("prints each session with device, ip, and last-used details", async () => {
    const client = fakeClient(() =>
      response(
        200,
        sessionList([
          {
            id: "s1",
            deviceName: "MacBook",
            ipAddress: "203.0.113.4",
            lastUsedAt: "2026-07-13T10:00:00.000Z",
            current: true,
          },
          { id: "s2", current: false },
        ]),
      ),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runSessions(["list"]);

    const out = output();
    expect(out).toContain("s1");
    expect(out).toContain("MacBook");
    expect(out).toContain("203.0.113.4");
    expect(out).toContain("2026-07-13 10:00 UTC");
    expect(out).toContain("(current)");
    expect(out).toContain("s2");
    expect(out).toContain("unknown device");
    expect(out).toContain("unknown ip");
  });

  it("falls back to a shortened user agent when deviceName is absent", async () => {
    const longUA =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Something Long";
    const client = fakeClient(() =>
      response(200, sessionList([{ id: "s3", userAgent: longUA, current: false }])),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runSessions(["list"]);

    expect(output()).toContain(`${longUA.slice(0, 45)}...`);
  });

  // The parser this replaced treated an empty string as missing; keep that.
  it("falls back to the user agent when deviceName is blank or null", async () => {
    const client = fakeClient(() =>
      response(
        200,
        sessionList([
          { id: "s6", deviceName: "", userAgent: "curl/8", ipAddress: "" },
          { id: "s7", deviceName: null, userAgent: null, ipAddress: null },
        ]),
      ),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runSessions(["list"]);

    const out = output();
    expect(out).toContain("curl/8");
    expect(out).toContain("unknown device");
    expect(out.match(/unknown ip/g)).toHaveLength(2);
  });

  it("uses the full user agent when it is short", async () => {
    const client = fakeClient(() =>
      response(200, sessionList([{ id: "s4", userAgent: "curl/8", current: false }])),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runSessions(["list"]);

    expect(output()).toContain("curl/8");
  });

  it("prints the raw ISO string when lastUsedAt is not a valid date", async () => {
    const client = fakeClient(() =>
      response(200, sessionList([{ id: "s5", lastUsedAt: "not-a-date", current: false }])),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runSessions(["list"]);

    expect(output()).toContain("not-a-date");
  });
});

describe("runSessions revoke --all", () => {
  it("cancels when the user declines", async () => {
    const client = fakeClient(() => response(200, { message: "ok" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(confirm).mockResolvedValue(false);

    await runSessions(["revoke", "--all"]);

    expect(output()).toContain("Cancelled.");
    expect(clearLocalSession).not.toHaveBeenCalled();
  });

  it("cancels when the prompt is aborted", async () => {
    const client = fakeClient(() => response(200, { message: "ok" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(confirm).mockResolvedValue(CANCEL_SYMBOL as never);

    await runSessions(["revoke", "--all"]);

    expect(output()).toContain("Cancelled.");
  });

  it("errors and exits 1 when revocation fails", async () => {
    const client = fakeClient(() => response(500, null));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(confirm).mockResolvedValue(true);

    await expect(runSessions(["revoke", "--all"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Could not revoke sessions (500).");
    expect(clearLocalSession).not.toHaveBeenCalled();
  });

  it("clears local tokens and reports success", async () => {
    const client = fakeClient(() => response(200, { message: "ok" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(confirm).mockResolvedValue(true);

    await runSessions(["revoke", "--all"]);

    expect(clearLocalSession).toHaveBeenCalledWith(client.profile);
    expect(output()).toContain("Revoked all sessions.");
    expect(output()).toContain("Run seamless login to sign in again.");
  });
});

describe("runSessions revoke <id>", () => {
  it("errors and exits 1 when neither an id nor --all is given", async () => {
    const client = fakeClient(() => response(200, sessionList([])));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(runSessions(["revoke"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain(
      "Usage: seamless sessions revoke <id> | seamless sessions revoke --all",
    );
  });

  it("revokes a non-current session without prompting", async () => {
    const calls: string[] = [];
    const client = fakeClient((method, path) => {
      calls.push(`${method} ${path}`);
      if (method === "GET") return response(200, sessionList([{ id: "s1", current: false }]));
      return response(200, { message: "ok" });
    });
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runSessions(["revoke", "s1"]);

    expect(confirm).not.toHaveBeenCalled();
    expect(calls).toContain("DELETE /sessions/s1");
    expect(output()).toContain("Revoked session s1.");
    expect(clearLocalSession).not.toHaveBeenCalled();
  });

  it("reports an unknown session as already revoked on 404", async () => {
    const client = fakeClient((method) => {
      if (method === "GET") return response(200, sessionList([]));
      return response(404, { error: "Session not found" });
    });
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runSessions(["revoke", "gone"]);

    expect(output()).toContain("No active session gone. It may already be revoked.");
  });

  it("errors and exits 1 when revocation fails for a non-404 reason", async () => {
    const client = fakeClient((method) => {
      if (method === "GET") return response(200, sessionList([]));
      return response(500, null);
    });
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(runSessions(["revoke", "s1"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Could not revoke session s1 (500).");
  });

  it("prompts before revoking the current session and cancels on decline", async () => {
    const client = fakeClient((method) => {
      if (method === "GET") return response(200, sessionList([{ id: "s1", current: true }]));
      return response(200, { message: "ok" });
    });
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(confirm).mockResolvedValue(false);

    await runSessions(["revoke", "s1"]);

    expect(output()).toContain("Cancelled.");
  });

  it("prompts before revoking the current session and cancels on abort", async () => {
    const client = fakeClient((method) => {
      if (method === "GET") return response(200, sessionList([{ id: "s1", current: true }]));
      return response(200, { message: "ok" });
    });
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(confirm).mockResolvedValue(CANCEL_SYMBOL as never);

    await runSessions(["revoke", "s1"]);

    expect(output()).toContain("Cancelled.");
  });

  it("revokes the current session, clears local tokens, and reports success", async () => {
    const client = fakeClient((method) => {
      if (method === "GET") return response(200, sessionList([{ id: "s1", current: true }]));
      return response(200, { message: "ok" });
    });
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(confirm).mockResolvedValue(true);

    await runSessions(["revoke", "s1"]);

    expect(output()).toContain("Revoked session s1.");
    expect(clearLocalSession).toHaveBeenCalledWith(client.profile);
    expect(output()).toContain("Run seamless login to sign in again.");
  });
});

describe("sessions --force", () => {
  it.each(["--force", "--yes", "-y"])(
    "revokes every session without confirming when given %s",
    async (flag) => {
      const client = fakeClient(() => response(200, { message: "ok" }));
      vi.mocked(createAuthClient).mockResolvedValue(client);

      await runSessions(["revoke", "--all", flag]);

      expect(confirm).not.toHaveBeenCalled();
      expect(clearLocalSession).toHaveBeenCalledWith(client.profile);
      expect(output()).toContain("Revoked all sessions.");
    },
  );

  it("refuses to ask without a terminal, naming --force", async () => {
    process.stdin.isTTY = false;
    const client = fakeClient(() => response(200, { message: "ok" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(runSessions(["revoke", "--all"])).rejects.toThrow(
      "process.exit(1)",
    );
    expect(errOutput()).toMatch(/needs an interactive terminal[\s\S]*--force/);
    expect(clearLocalSession).not.toHaveBeenCalled();
  });
});
