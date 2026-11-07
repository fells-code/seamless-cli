import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, isCancel } from "@clack/prompts";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  AdminApiError,
  createPermission,
  deletePermission,
  listPermissions,
  PERMISSIONS_UNSUPPORTED_MESSAGE,
  updatePermission,
} from "../core/admin.js";
import { apiPermission } from "../core/admin.fixtures.js";
import { runPermissions } from "./permissions.js";

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
    listPermissions: vi.fn(),
    createPermission: vi.fn(),
    updatePermission: vi.fn(),
    deletePermission: vi.fn(),
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
  await expect(runPermissions(args)).rejects.toBeInstanceOf(ExitError);
}

describe("runPermissions", () => {
  it("prints usage on an unknown or missing subcommand", async () => {
    await exits(["bogus"]);
    expect(errors()).toContain("Unknown permissions subcommand: bogus");
    expect(logs()).toContain("Usage: seamless permissions <list|create|update|delete>");

    await exits([]);
    expect(errors()).toContain("(none)");
  });

  it("passes --profile to the client", async () => {
    vi.mocked(listPermissions).mockResolvedValue({ permissions: [], total: 0 });
    await runPermissions(["list", "--profile", "staging"]);
    expect(createAuthClient).toHaveBeenCalledWith({ profileFlag: "staging" });
  });

  it("says an instance before v0.23 has no catalogue, and exits 1", async () => {
    vi.mocked(listPermissions).mockRejectedValue(
      new AdminApiError(PERMISSIONS_UNSUPPORTED_MESSAGE),
    );
    await exits(["list"]);
    expect(errors()).toContain("Seamless Auth API v0.23 or later");
  });
});

describe("permissions list", () => {
  it("lists names with their descriptions and the count", async () => {
    vi.mocked(listPermissions).mockResolvedValue({
      permissions: [
        apiPermission({ description: "Read invoices" }),
        apiPermission({ id: "p2", name: "invoices:write" }),
      ],
      total: 2,
    });
    await runPermissions(["list"]);
    expect(logs()).toContain("invoices:read");
    expect(logs()).toContain("Read invoices");
    expect(logs()).toContain("invoices:write");
    expect(logs()).toContain("2 permissions.");
  });

  it("says so when there are none, and prints JSON on request", async () => {
    vi.mocked(listPermissions).mockResolvedValue({ permissions: [], total: 0 });
    await runPermissions(["list"]);
    expect(logs()).toContain("No permissions.");

    vi.mocked(listPermissions).mockResolvedValue({
      permissions: [apiPermission()],
      total: 1,
    });
    await runPermissions(["list"]);
    expect(logs()).toContain("1 permission.");

    await runPermissions(["list", "--json"]);
    expect(lastJson()).toEqual([apiPermission()]);
  });
});

describe("permissions create", () => {
  it("creates a permission with a description", async () => {
    vi.mocked(createPermission).mockResolvedValue(apiPermission({ description: "Read" }));
    await runPermissions(["create", "invoices:read", "--description", "Read"]);
    expect(createPermission).toHaveBeenCalledWith(fakeClient, {
      name: "invoices:read",
      description: "Read",
    });
    expect(logs()).toContain("Created permission invoices:read.");

    await runPermissions(["create", "invoices:read", "--json"]);
    expect(createPermission).toHaveBeenLastCalledWith(fakeClient, { name: "invoices:read" });
    expect(lastJson()).toMatchObject({ name: "invoices:read" });
  });

  it("refuses a bad name or an empty description before asking the API", async () => {
    await exits(["create", "invoices read"]);
    expect(errors()).toContain("invoices read is not a valid permission name.");

    await exits(["create", "invoices:read", "--description", " "]);
    expect(errors()).toContain("description:");
    expect(createPermission).not.toHaveBeenCalled();
  });

  it("needs a name", async () => {
    await exits(["create"]);
    expect(errors()).toContain("Usage: seamless permissions create <name>");
  });
});

describe("permissions update", () => {
  it("sets or clears the description", async () => {
    vi.mocked(updatePermission).mockResolvedValue(apiPermission({ description: "New" }));
    await runPermissions(["update", "invoices:read", "--description", "New"]);
    expect(updatePermission).toHaveBeenCalledWith(fakeClient, "invoices:read", {
      description: "New",
    });
    expect(logs()).toContain("Updated permission invoices:read.");

    vi.mocked(updatePermission).mockResolvedValue(apiPermission());
    await runPermissions(["update", "invoices:read", "--no-description", "--json"]);
    expect(updatePermission).toHaveBeenLastCalledWith(fakeClient, "invoices:read", {
      description: null,
    });
    expect(lastJson()).toMatchObject({ description: null });
  });

  it("needs a name and exactly one change", async () => {
    await exits(["update"]);
    expect(errors()).toContain("Usage: seamless permissions update <name>");

    await exits(["update", "invoices:read"]);
    expect(errors()).toContain("Nothing to update.");

    await exits(["update", "invoices:read", "--description", "x", "--no-description"]);
    expect(errors()).toContain("not both");
    expect(updatePermission).not.toHaveBeenCalled();
  });
});

describe("permissions delete", () => {
  it("confirms, then deletes", async () => {
    await runPermissions(["delete", "invoices:read"]);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("invoices:read") }),
    );
    expect(deletePermission).toHaveBeenCalledWith(fakeClient, "invoices:read");
    expect(logs()).toContain("Deleted permission invoices:read.");
  });

  it("skips the question with --force", async () => {
    await runPermissions(["delete", "invoices:read", "--force"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(deletePermission).toHaveBeenCalled();
  });

  it("does nothing when declined", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    await runPermissions(["delete", "invoices:read"]);
    expect(deletePermission).not.toHaveBeenCalled();
    expect(logs()).toContain("Cancelled.");
  });

  it("needs a valid name", async () => {
    await exits(["delete"]);
    expect(errors()).toContain("Usage: seamless permissions delete <name>");

    await exits(["delete", "bad/name"]);
    expect(errors()).toContain("not a valid permission name");
  });
});
