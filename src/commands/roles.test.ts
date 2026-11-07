import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, isCancel } from "@clack/prompts";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  createOrganizationRole,
  deleteOrganizationRole,
  listRoles,
  setRolePermissions,
  updateOrganizationRole,
} from "../core/admin.js";
import { apiRole } from "../core/admin.fixtures.js";
import { runRoles } from "./roles.js";

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
    listRoles: vi.fn(),
    setRolePermissions: vi.fn(),
    createOrganizationRole: vi.fn(),
    updateOrganizationRole: vi.fn(),
    deleteOrganizationRole: vi.fn(),
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
  await expect(runRoles(args)).rejects.toBeInstanceOf(ExitError);
}

const ROLES = [
  apiRole({ name: "admin", kind: "instance", permissions: ["invoices:read"] }),
  apiRole({ name: "owner", builtIn: true, description: "Runs the organization" }),
  apiRole({ permissions: ["invoices:read", "invoices:write"] }),
];

describe("runRoles", () => {
  it("prints usage on an unknown or missing subcommand", async () => {
    await exits(["bogus"]);
    expect(errors()).toContain("Unknown roles subcommand: bogus");
    expect(logs()).toContain("Usage: seamless roles <list|set|create|update|delete>");

    await exits([]);
    expect(errors()).toContain("(none)");
  });
});

describe("roles list", () => {
  it("groups roles by kind with what they grant", async () => {
    vi.mocked(listRoles).mockResolvedValue(ROLES);
    await runRoles(["list"]);
    const out = logs();
    expect(out.indexOf("Instance roles")).toBeLessThan(out.indexOf("Organization roles"));
    expect(out).toContain("(built in)");
    expect(out).toContain("Runs the organization");
    expect(out).toContain("invoices:read, invoices:write");
    expect(out).toContain("none");
  });

  it("filters by kind, and prints JSON on request", async () => {
    vi.mocked(listRoles).mockResolvedValue(ROLES);
    await runRoles(["list", "--kind", "instance", "--json"]);
    expect(lastJson()).toEqual([ROLES[0]]);

    await runRoles(["list", "--kind", "organization"]);
    expect(logs()).not.toContain("Instance roles");
  });

  it("says so when there are none", async () => {
    vi.mocked(listRoles).mockResolvedValue([]);
    await runRoles(["list"]);
    expect(logs()).toContain("No roles.");
  });

  it("refuses an unknown kind", async () => {
    await exits(["list", "--kind", "team"]);
    expect(errors()).toContain("instance or organization, not team");
  });
});

describe("roles set", () => {
  it("adds permissions without asking", async () => {
    vi.mocked(listRoles).mockResolvedValue(ROLES);
    vi.mocked(setRolePermissions).mockResolvedValue(ROLES[2]);
    await runRoles([
      "set",
      "organization",
      "billing",
      "invoices:read,invoices:write",
      "invoices:read",
    ]);
    expect(confirm).not.toHaveBeenCalled();
    expect(setRolePermissions).toHaveBeenCalledWith(
      fakeClient,
      "organization",
      "billing",
      ["invoices:read", "invoices:write"],
    );
    expect(logs()).toContain("Set the permissions of the organization role billing.");
  });

  it("asks before taking a permission away", async () => {
    vi.mocked(listRoles).mockResolvedValue(ROLES);
    vi.mocked(setRolePermissions).mockResolvedValue(apiRole({ permissions: ["invoices:read"] }));
    await runRoles(["set", "organization", "billing", "invoices:read", "--json"]);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Take invoices:write away from the organization role billing"),
      }),
    );
    expect(lastJson()).toMatchObject({ permissions: ["invoices:read"] });
  });

  it("clears with --none, and stops when declined", async () => {
    vi.mocked(listRoles).mockResolvedValue(ROLES);
    vi.mocked(confirm).mockResolvedValue(false);
    await runRoles(["set", "organization", "billing", "--none"]);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("lose them") }),
    );
    expect(setRolePermissions).not.toHaveBeenCalled();
    expect(logs()).toContain("Cancelled.");
  });

  it("skips the question with --force", async () => {
    vi.mocked(listRoles).mockResolvedValue(ROLES);
    vi.mocked(setRolePermissions).mockResolvedValue(apiRole({ kind: "instance", name: "admin" }));
    await runRoles(["set", "instance", "admin", "--none", "--force"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(setRolePermissions).toHaveBeenCalledWith(fakeClient, "instance", "admin", []);
  });

  it("leaves a role it cannot find to the API to refuse", async () => {
    vi.mocked(listRoles).mockResolvedValue(ROLES);
    vi.mocked(setRolePermissions).mockResolvedValue(apiRole({ name: "ghost" }));
    await runRoles(["set", "organization", "ghost", "--none"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(setRolePermissions).toHaveBeenCalled();
  });

  it("needs a kind, a role, and permissions or --none", async () => {
    await exits(["set"]);
    expect(errors()).toContain("Usage: seamless roles set <instance|organization> <role>");

    await exits(["set", "team", "billing", "a"]);
    expect(errors()).toContain("not team");

    await exits(["set", "organization"]);
    expect(errors()).toContain("Usage: seamless roles set");

    await exits(["set", "organization", "billing"]);
    expect(errors()).toContain("or pass --none to grant nothing");

    await exits(["set", "organization", "billing", "a", "--none"]);
    expect(errors()).toContain("not both");

    await exits(["set", "organization", "billing", "bad name"]);
    expect(errors()).toContain("bad name is not a valid permission name.");
    expect(listRoles).not.toHaveBeenCalled();
  });
});

describe("roles create", () => {
  it("creates an organization role with permissions", async () => {
    vi.mocked(createOrganizationRole).mockResolvedValue(apiRole({ permissions: ["a"] }));
    await runRoles([
      "create",
      "billing",
      "--description",
      "Pays",
      "--permissions",
      "a, a",
    ]);
    expect(createOrganizationRole).toHaveBeenCalledWith(fakeClient, {
      name: "billing",
      description: "Pays",
      permissions: ["a"],
    });
    expect(logs()).toContain("Created organization role billing.");

    await runRoles(["create", "billing", "--json"]);
    expect(createOrganizationRole).toHaveBeenLastCalledWith(fakeClient, { name: "billing" });
    expect(lastJson()).toMatchObject({ name: "billing" });
  });

  it("checks names before asking the API", async () => {
    await exits(["create"]);
    expect(errors()).toContain("Usage: seamless roles create <name>");

    await exits(["create", "bad role"]);
    expect(errors()).toContain("bad role is not a valid role name.");

    await exits(["create", "billing", "--permissions", "ok,not ok"]);
    expect(errors()).toContain("not ok is not a valid permission name.");
    expect(createOrganizationRole).not.toHaveBeenCalled();
  });
});

describe("roles update", () => {
  it("sets or clears the description", async () => {
    vi.mocked(updateOrganizationRole).mockResolvedValue(apiRole({ description: "Pays" }));
    await runRoles(["update", "billing", "--description", "Pays"]);
    expect(updateOrganizationRole).toHaveBeenCalledWith(fakeClient, "billing", {
      description: "Pays",
    });
    expect(logs()).toContain("Updated organization role billing.");

    await runRoles(["update", "billing", "--no-description", "--json"]);
    expect(updateOrganizationRole).toHaveBeenLastCalledWith(fakeClient, "billing", {
      description: null,
    });
  });

  it("needs a name and exactly one change", async () => {
    await exits(["update"]);
    expect(errors()).toContain("Usage: seamless roles update <name>");

    await exits(["update", "billing"]);
    expect(errors()).toContain("Nothing to update.");

    await exits(["update", "billing", "--description", "x", "--no-description"]);
    expect(errors()).toContain("not both");
  });
});

describe("roles delete", () => {
  it("confirms, then deletes", async () => {
    await runRoles(["delete", "billing"]);
    expect(confirm).toHaveBeenCalled();
    expect(deleteOrganizationRole).toHaveBeenCalledWith(fakeClient, "billing");
    expect(logs()).toContain("Deleted organization role billing.");
  });

  it("skips the question with --force, and stops when declined", async () => {
    await runRoles(["delete", "billing", "-y"]);
    expect(confirm).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(confirm).mockResolvedValue(false);
    await runRoles(["delete", "billing"]);
    expect(deleteOrganizationRole).not.toHaveBeenCalled();
    expect(logs()).toContain("Cancelled.");
  });

  it("needs a name", async () => {
    await exits(["delete"]);
    expect(errors()).toContain("Usage: seamless roles delete <name>");
  });
});
