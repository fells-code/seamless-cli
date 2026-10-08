import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, isCancel } from "@clack/prompts";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  deleteUser,
  getUserDetail,
  listUsers,
  prepareDeviceReplacement,
} from "../core/admin.js";
import {
  apiCredential,
  apiUser,
  apiUserDetail,
} from "../core/admin.fixtures.js";
import { runUsers } from "./users.js";

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(),
}));

vi.mock("../core/authClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/authClient.js")>();
  return { ...actual, createAuthClient: vi.fn() };
});

vi.mock("../core/admin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/admin.js")>();
  return {
    ...actual,
    listUsers: vi.fn(),
    deleteUser: vi.fn(),
    getUserDetail: vi.fn(),
    prepareDeviceReplacement: vi.fn(),
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

let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAuthClient).mockResolvedValue(fakeClient);
  vi.mocked(isCancel).mockReturnValue(false);
  vi.mocked(confirm).mockResolvedValue(true);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

function logs(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
}

describe("runUsers — top-level routing", () => {
  it("prints usage and exits 1 on an unknown subcommand", async () => {
    await expect(runUsers(["bogus"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown users subcommand: bogus"),
    );
    expect(logs()).toContain(
      "Usage: seamless users <list|delete|credentials|prepare-device-replacement>",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prints usage and exits 1 when no subcommand is given", async () => {
    await expect(runUsers([])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("(none)"));
  });

  it("reports a ReauthRequiredError from createAuthClient and exits 1", async () => {
    const { ReauthRequiredError } = await import("../core/authClient.js");
    vi.mocked(createAuthClient).mockRejectedValue(
      new ReauthRequiredError("No active profile is configured."),
    );
    await expect(runUsers(["list"])).rejects.toBeInstanceOf(ExitError);
    expect(logs()).toContain("No active profile is configured.");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rethrows unrecognized errors from createAuthClient", async () => {
    vi.mocked(createAuthClient).mockRejectedValue(new Error("boom"));
    await expect(runUsers(["list"])).rejects.toThrow("boom");
  });

  it("reports a PermissionError from an admin call and exits 1", async () => {
    const { PermissionError } = await import("../core/admin.js");
    vi.mocked(listUsers).mockRejectedValue(new PermissionError());
    await expect(runUsers(["list"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("reports an AdminApiError from an admin call and exits 1", async () => {
    const { AdminApiError } = await import("../core/admin.js");
    vi.mocked(listUsers).mockRejectedValue(new AdminApiError("nope"));
    await expect(runUsers(["list"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("nope"));
  });
});

describe("runUsers list", () => {
  it("asks the server for the default page", async () => {
    vi.mocked(listUsers).mockResolvedValue({ users: [apiUser({ id: "u1" })], total: 1 });
    await runUsers(["list"]);
    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(fakeClient, {
      limit: 50,
      offset: 0,
    });
  });

  it("prints the requested page as JSON, honouring the pagination flags", async () => {
    vi.mocked(listUsers).mockResolvedValue({ users: [apiUser({ id: "u2" })], total: 2 });
    await runUsers(["list", "--json", "--limit", "1", "--offset", "1"]);
    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(fakeClient, {
      limit: 1,
      offset: 1,
    });
    expect(logs()).toContain(JSON.stringify([apiUser({ id: "u2" })], null, 2));
  });

  it("prints an empty message when the page is empty", async () => {
    vi.mocked(listUsers).mockResolvedValue({ users: [], total: 0 });
    await runUsers(["list"]);
    expect(logs()).toContain("No users.");
  });

  it("prints user rows, roles, and revoked state, with a plural summary", async () => {
    vi.mocked(listUsers).mockResolvedValue({
      users: [
        apiUser({ email: "a@example.com", roles: ["admin"], revoked: true }),
        apiUser({ id: "u2", email: "b@example.com" }),
      ],
      total: 2,
    });
    await runUsers(["list"]);
    expect(logs()).toContain("a@example.com");
    expect(logs()).toContain("[admin]");
    expect(logs()).toContain("revoked");
    expect(logs()).toContain("b@example.com");
    expect(logs()).toContain("Showing 1-2 of 2 users.");
  });

  it("sends --limit and --offset to the server and reports the page position", async () => {
    vi.mocked(listUsers).mockResolvedValue({ users: [apiUser({ id: "u2" })], total: 3 });
    await runUsers(["list", "--limit", "1", "--offset", "1"]);
    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(fakeClient, {
      limit: 1,
      offset: 1,
    });
    expect(logs()).toContain("Showing 2-2 of 3 users.");
  });

  it("reports an offset past the end without inventing rows", async () => {
    vi.mocked(listUsers).mockResolvedValue({ users: [], total: 3 });
    await runUsers(["list", "--offset", "99"]);
    expect(logs()).toContain("No users.");
  });

  it.each([
    ["--limit", "abc"],
    ["--limit", "-1"],
    ["--offset", "1.5"],
    ["--offset", "-1"],
  ])("rejects %s %s", async (flag, value) => {
    await expect(runUsers(["list", flag, value])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("must be a whole number"),
    );
    expect(vi.mocked(listUsers)).not.toHaveBeenCalled();
  });

  // The two flags do not share a range, so the message has to name the one that
  // was wrong and the bound it broke.
  it.each(["0", "101"])(
    "rejects --limit %s outside the range the API accepts",
    async (value) => {
      await expect(runUsers(["list", "--limit", value])).rejects.toBeInstanceOf(ExitError);
      expect(errorSpy).toHaveBeenCalledWith(
        "--limit must be a whole number between 1 and 100.",
      );
      expect(vi.mocked(listUsers)).not.toHaveBeenCalled();
    },
  );

  it("still accepts an offset of zero", async () => {
    vi.mocked(listUsers).mockResolvedValue({ users: [apiUser({ id: "u1" })], total: 1 });
    await runUsers(["list", "--offset", "0"]);
    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(fakeClient, {
      limit: 50,
      offset: 0,
    });
  });

  it("accepts the largest window the API allows", async () => {
    vi.mocked(listUsers).mockResolvedValue({ users: [apiUser({ id: "u1" })], total: 1 });
    await runUsers(["list", "--limit", "100"]);
    expect(vi.mocked(listUsers)).toHaveBeenCalledWith(fakeClient, {
      limit: 100,
      offset: 0,
    });
  });
});

describe("runUsers delete", () => {
  it("prints usage and exits 1 when no id is given", async () => {
    await expect(runUsers(["delete"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: seamless users delete <id>"),
    );
  });

  it("cancels when the prompt is cancelled", async () => {
    vi.mocked(isCancel).mockReturnValue(true);
    await runUsers(["delete", "u1"]);
    expect(logs()).toContain("Cancelled.");
    expect(vi.mocked(deleteUser)).not.toHaveBeenCalled();
  });

  it("cancels when the user declines", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    await runUsers(["delete", "u1"]);
    expect(logs()).toContain("Cancelled.");
    expect(vi.mocked(deleteUser)).not.toHaveBeenCalled();
  });

  it("deletes the user on confirmation", async () => {
    vi.mocked(deleteUser).mockResolvedValue(undefined);
    await runUsers(["delete", "u1"]);
    expect(vi.mocked(confirm)).toHaveBeenCalledWith({
      message: "Permanently delete user u1? This cannot be undone.",
      initialValue: false,
    });
    expect(vi.mocked(deleteUser)).toHaveBeenCalledWith(fakeClient, "u1");
    expect(logs()).toContain("Deleted user u1.");
  });
});

describe("runUsers credentials", () => {
  it("prints usage and exits 1 when no id is given", async () => {
    await expect(runUsers(["credentials"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: seamless users credentials <id>"),
    );
  });

  it("prints JSON when --json is passed", async () => {
    const credential = apiCredential({ id: "c1" });
    vi.mocked(getUserDetail).mockResolvedValue(apiUserDetail([credential]));
    await runUsers(["credentials", "u1", "--json"]);
    expect(vi.mocked(getUserDetail)).toHaveBeenCalledWith(fakeClient, "u1");
    expect(logs()).toContain(JSON.stringify([credential], null, 2));
  });

  it("prints a singular header and the passkey's own name", async () => {
    vi.mocked(getUserDetail).mockResolvedValue(
      apiUserDetail([
        apiCredential({
          id: "c1",
          friendlyName: "Work laptop",
          deviceInfo: "MacBook Pro",
          createdAt: "2024-01-01T00:00:00.000Z",
        }),
      ]),
    );
    await runUsers(["credentials", "u1"]);
    expect(logs()).toContain("1 credential for user u1");
    expect(logs()).toContain("Work laptop");
    expect(logs()).not.toContain("MacBook Pro");
    expect(logs()).toContain("c1");
    expect(logs()).toContain("added 2024-01-01T00:00:00.000Z");
  });

  // The API records friendlyName, deviceInfo, platform and browser. The command
  // used to look for deviceName, name and type, which it never sends, so every
  // passkey printed as "credential".
  it("falls back from the passkey's name to what the API recorded about the device", async () => {
    vi.mocked(getUserDetail).mockResolvedValue(
      apiUserDetail([
        apiCredential({ id: "c1", friendlyName: "", deviceInfo: "Pixel 9" }),
        apiCredential({ id: "c2", platform: "macOS", browser: "Safari" }),
        apiCredential({ id: "c3", platform: "Windows", browser: null }),
        apiCredential({ id: "c4" }),
      ]),
    );
    await runUsers(["credentials", "u1"]);
    const lines = logs().split("\n");
    expect(lines[0]).toContain("4 credentials for user u1");
    expect(lines[1]).toContain("Pixel 9");
    expect(lines[2]).toContain("macOS Safari");
    expect(lines[3]).toContain("Windows");
    expect(lines[4]).toContain("passkey");
    expect(lines[4]).toContain("c4");
  });
});

describe("runUsers prepare-device-replacement", () => {
  it("prints usage and exits 1 when no id is given", async () => {
    await expect(
      runUsers(["prepare-device-replacement"]),
    ).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: seamless users prepare-device-replacement <id>"),
    );
  });

  it("cancels when the prompt is cancelled", async () => {
    vi.mocked(isCancel).mockReturnValue(true);
    await runUsers(["prepare-device-replacement", "u1"]);
    expect(logs()).toContain("Cancelled.");
    expect(vi.mocked(prepareDeviceReplacement)).not.toHaveBeenCalled();
  });

  it("cancels when the user declines", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    await runUsers(["prepare-device-replacement", "u1"]);
    expect(logs()).toContain("Cancelled.");
    expect(vi.mocked(prepareDeviceReplacement)).not.toHaveBeenCalled();
  });

  it("confirms with the default action list and reports stats on success", async () => {
    vi.mocked(prepareDeviceReplacement).mockResolvedValue({
      userId: "u1",
      revokedSessions: 2,
      removedCredentials: 1,
      disabledTotpCredentials: 1,
    });
    await runUsers(["prepare-device-replacement", "u1"]);
    expect(vi.mocked(confirm)).toHaveBeenCalledWith({
      message:
        "Prepare device replacement for u1? This will revoke all sessions, remove passkeys, disable TOTP.",
      initialValue: false,
    });
    expect(vi.mocked(prepareDeviceReplacement)).toHaveBeenCalledWith(fakeClient, "u1", {
      revokeSessions: true,
      removePasskeys: true,
      disableTotp: true,
    });
    expect(logs()).toContain("Prepared device replacement for u1.");
    expect(logs()).toContain("Revoked sessions: 2, removed credentials: 1, disabled TOTP: 1");
  });

  it("honors --keep-* flags", async () => {
    vi.mocked(prepareDeviceReplacement).mockResolvedValue({
      userId: "u1",
      revokedSessions: 0,
      removedCredentials: 0,
      disabledTotpCredentials: 0,
    });
    await runUsers([
      "prepare-device-replacement",
      "u1",
      "--keep-sessions",
      "--keep-passkeys",
      "--keep-totp",
    ]);
    expect(vi.mocked(confirm)).toHaveBeenCalledWith({
      message: "Prepare device replacement for u1? This will .",
      initialValue: false,
    });
    expect(vi.mocked(prepareDeviceReplacement)).toHaveBeenCalledWith(fakeClient, "u1", {
      revokeSessions: false,
      removePasskeys: false,
      disableTotp: false,
    });
    expect(logs()).toContain("Revoked sessions: 0, removed credentials: 0, disabled TOTP: 0");
  });
});

describe("users --force", () => {
  it.each(["--force", "--yes", "-y"])(
    "deletes without confirming when given %s",
    async (flag) => {
      vi.mocked(deleteUser).mockResolvedValue(undefined);

      await runUsers(["delete", "u1", flag]);

      expect(vi.mocked(confirm)).not.toHaveBeenCalled();
      expect(vi.mocked(deleteUser)).toHaveBeenCalledWith(expect.anything(), "u1");
    },
  );

  it("prepares a device replacement without confirming when forced", async () => {
    vi.mocked(prepareDeviceReplacement).mockResolvedValue({} as never);

    await runUsers(["prepare-device-replacement", "u1", "--force"]);

    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
    expect(vi.mocked(prepareDeviceReplacement)).toHaveBeenCalled();
  });

  it("refuses to ask without a terminal, naming --force", async () => {
    process.stdin.isTTY = false;

    await expect(runUsers(["delete", "u1"])).rejects.toThrow(
      /needs an interactive terminal.*--force/s,
    );
    expect(vi.mocked(deleteUser)).not.toHaveBeenCalled();
  });
});
