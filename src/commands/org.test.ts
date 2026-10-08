import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, isCancel } from "@clack/prompts";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  addMember,
  createOrg,
  getOrg,
  listMembers,
  listOrgs,
  removeMember,
  updateMember,
  updateOrg,
} from "../core/admin.js";
import { apiMembership, apiOrg } from "../core/admin.fixtures.js";
import { runOrg } from "./org.js";

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
    listOrgs: vi.fn(),
    createOrg: vi.fn(),
    getOrg: vi.fn(),
    updateOrg: vi.fn(),
    listMembers: vi.fn(),
    addMember: vi.fn(),
    updateMember: vi.fn(),
    removeMember: vi.fn(),
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

describe("runOrg — top-level routing", () => {
  it("prints usage and exits 1 on an unknown subcommand", async () => {
    await expect(runOrg(["bogus"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown org subcommand: bogus"));
    expect(logs()).toContain("Usage: seamless org <list|create|get|update|members>");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prints usage and exits 1 when no subcommand is given", async () => {
    await expect(runOrg([])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("(none)"));
  });

  it("reports a ReauthRequiredError from createAuthClient and exits 1", async () => {
    vi.mocked(createAuthClient).mockRejectedValue(
      Object.assign(new Error("No active profile"), { name: "ReauthRequiredError" }),
    );
    const { ReauthRequiredError } = await import("../core/authClient.js");
    vi.mocked(createAuthClient).mockRejectedValue(
      new ReauthRequiredError("No active profile is configured."),
    );

    await expect(runOrg(["list"])).rejects.toBeInstanceOf(ExitError);
    expect(logs()).toContain("No active profile is configured.");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rethrows unrecognized errors from createAuthClient", async () => {
    vi.mocked(createAuthClient).mockRejectedValue(new Error("boom"));
    await expect(runOrg(["list"])).rejects.toThrow("boom");
  });

  it("reports a PermissionError from an admin call and exits 1", async () => {
    const { PermissionError } = await import("../core/admin.js");
    vi.mocked(listOrgs).mockRejectedValue(new PermissionError());
    await expect(runOrg(["list"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("reports an AdminApiError from an admin call and exits 1", async () => {
    const { AdminApiError } = await import("../core/admin.js");
    vi.mocked(listOrgs).mockRejectedValue(new AdminApiError("nope"));
    await expect(runOrg(["list"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("nope"));
  });
});

describe("runOrg list", () => {
  it("prints JSON when --json is passed", async () => {
    vi.mocked(listOrgs).mockResolvedValue({
      organizations: [apiOrg()],
      total: 1,
    });
    await runOrg(["list", "--json"]);
    expect(vi.mocked(listOrgs)).toHaveBeenCalledWith(fakeClient, {
      limit: 50,
      offset: 0,
    });
    expect(logs()).toContain(JSON.stringify([apiOrg()], null, 2));
  });

  it("prints an empty message when there are no organizations", async () => {
    vi.mocked(listOrgs).mockResolvedValue({ organizations: [], total: 0 });
    await runOrg(["list"]);
    expect(logs()).toContain("No organizations.");
  });

  it("prints each org row and a singular summary for one organization", async () => {
    vi.mocked(listOrgs).mockResolvedValue({
      organizations: [apiOrg()],
      total: 1,
    });
    await runOrg(["list"]);
    expect(logs()).toContain("Acme");
    expect(logs()).toContain("o1");
    expect(logs()).toContain("(acme)");
    expect(logs()).toContain("1 organization.");
  });

  it("prints a plural summary for multiple organizations", async () => {
    vi.mocked(listOrgs).mockResolvedValue({
      organizations: [apiOrg(), apiOrg({ id: "o2", name: "Beta", slug: "" })],
      total: 2,
    });
    await runOrg(["list"]);
    expect(logs()).toContain("Beta  o2");
    expect(logs()).not.toContain("()");
    expect(logs()).toContain("2 organizations.");
  });

  // The endpoint returns one page and a count of every match, so printing the
  // count alone claimed rows that were never shown.
  it("reports where the page sits in the result set", async () => {
    vi.mocked(listOrgs).mockResolvedValue({
      organizations: [apiOrg()],
      total: 140,
    });
    await runOrg(["list", "--limit", "1", "--offset", "50"]);
    expect(vi.mocked(listOrgs)).toHaveBeenCalledWith(fakeClient, {
      limit: 1,
      offset: 50,
    });
    expect(logs()).toContain("Showing 51-51 of 140 organizations.");
  });

  it("sends a search term when one is given", async () => {
    vi.mocked(listOrgs).mockResolvedValue({
      organizations: [apiOrg()],
      total: 1,
    });
    await runOrg(["list", "--search", "acme"]);
    expect(vi.mocked(listOrgs)).toHaveBeenCalledWith(fakeClient, {
      limit: 50,
      offset: 0,
      search: "acme",
    });
  });

  it("rejects a window the API would refuse", async () => {
    await expect(runOrg(["list", "--limit", "0"])).rejects.toBeInstanceOf(ExitError);
    expect(vi.mocked(listOrgs)).not.toHaveBeenCalled();
  });
});

describe("runOrg create", () => {
  it("prints usage and exits 1 when no name is given", async () => {
    await expect(runOrg(["create"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: seamless org create"),
    );
  });

  it("creates an org from a positional name and --slug flag", async () => {
    vi.mocked(createOrg).mockResolvedValue(apiOrg());
    await runOrg(["create", "Acme", "--slug", "acme"]);
    expect(vi.mocked(createOrg)).toHaveBeenCalledWith(fakeClient, {
      name: "Acme",
      slug: "acme",
    });
    expect(logs()).toContain("Created organization o1.");
    expect(logs()).toContain("Acme");
  });

  it("creates an org from a --name flag without a slug", async () => {
    vi.mocked(createOrg).mockResolvedValue(apiOrg({ id: "o2", name: "Beta" }));
    await runOrg(["create", "--name", "Beta"]);
    expect(vi.mocked(createOrg)).toHaveBeenCalledWith(fakeClient, { name: "Beta" });
  });

  it("prints '(none)' for a blank slug", async () => {
    vi.mocked(createOrg).mockResolvedValue(apiOrg({ slug: "" }));
    await runOrg(["create", "Acme"]);
    expect(logs()).toContain("(none)");
  });
});

describe("runOrg get", () => {
  it("prints usage and exits 1 when no id is given", async () => {
    await expect(runOrg(["get"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: seamless org get <id>"),
    );
  });

  it("prints JSON when --json is passed", async () => {
    vi.mocked(getOrg).mockResolvedValue(apiOrg());
    await runOrg(["get", "o1", "--json"]);
    expect(vi.mocked(getOrg)).toHaveBeenCalledWith(fakeClient, "o1");
    expect(logs()).toContain(JSON.stringify(apiOrg(), null, 2));
  });

  it("prints the org details by default", async () => {
    vi.mocked(getOrg).mockResolvedValue(apiOrg());
    await runOrg(["get", "o1"]);
    expect(logs()).toContain("Acme");
    expect(logs()).toContain("acme");
  });
});

describe("runOrg update", () => {
  it("prints usage and exits 1 when no id is given", async () => {
    await expect(runOrg(["update"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: seamless org update"),
    );
  });

  it("errors when neither --name nor --slug is given", async () => {
    await expect(runOrg(["update", "o1"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Nothing to update"));
    expect(vi.mocked(updateOrg)).not.toHaveBeenCalled();
  });

  it("updates the org name and slug", async () => {
    vi.mocked(updateOrg).mockResolvedValue(apiOrg({ id: "o1", name: "New", slug: "new" }));
    await runOrg(["update", "o1", "--name", "New", "--slug", "new"]);
    expect(vi.mocked(updateOrg)).toHaveBeenCalledWith(fakeClient, "o1", {
      name: "New",
      slug: "new",
    });
    expect(logs()).toContain("Updated organization o1.");
  });
});

describe("runOrg members — routing", () => {
  it("prints usage and exits 1 on an unknown members subcommand", async () => {
    await expect(runOrg(["members", "bogus"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown org members subcommand: bogus"),
    );
    expect(logs()).toContain("Usage: seamless org members <list|add|update|remove>");
  });

  it("prints usage on no members subcommand", async () => {
    await expect(runOrg(["members"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("(none)"));
  });

  it("reports a ReauthRequiredError inside members routing", async () => {
    const { ReauthRequiredError } = await import("../core/authClient.js");
    vi.mocked(createAuthClient).mockRejectedValue(
      new ReauthRequiredError("No session."),
    );
    await expect(runOrg(["members", "list", "o1"])).rejects.toBeInstanceOf(ExitError);
    expect(logs()).toContain("No session.");
  });

  it("rethrows unrecognized errors inside members routing", async () => {
    vi.mocked(createAuthClient).mockRejectedValue(new Error("kaboom"));
    await expect(runOrg(["members", "list", "o1"])).rejects.toThrow("kaboom");
  });
});

describe("runOrg members list", () => {
  it("prints usage and exits 1 when no orgId is given", async () => {
    await expect(runOrg(["members", "list"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: seamless org members list <orgId>"),
    );
  });

  it("prints JSON when --json is passed", async () => {
    vi.mocked(listMembers).mockResolvedValue({ members: [apiMembership()], total: 1 });
    await runOrg(["members", "list", "o1", "--json"]);
    expect(vi.mocked(listMembers)).toHaveBeenCalledWith(fakeClient, "o1");
    expect(logs()).toContain(JSON.stringify([apiMembership()], null, 2));
  });

  it("prints an empty message when there are no members", async () => {
    vi.mocked(listMembers).mockResolvedValue({ members: [], total: 0 });
    await runOrg(["members", "list", "o1"]);
    expect(logs()).toContain("No members.");
  });

  it("prints member rows with roles and scopes and a plural summary", async () => {
    vi.mocked(listMembers).mockResolvedValue({
      members: [
        apiMembership({ roles: ["admin"], scopes: ["read", "write"] }),
        apiMembership({ id: "m2", userId: "u2" }),
      ],
      total: 2,
    });
    await runOrg(["members", "list", "o1"]);
    expect(logs()).toContain("u1");
    expect(logs()).toContain("roles: admin");
    expect(logs()).toContain("scopes: read, write");
    expect(logs()).toMatch(/^u2$/m);
    expect(logs()).toContain("2 members.");
  });

  it("prints a singular summary for one member", async () => {
    vi.mocked(listMembers).mockResolvedValue({ members: [apiMembership()], total: 1 });
    await runOrg(["members", "list", "o1"]);
    expect(logs()).toContain("1 member.");
  });
});

describe("runOrg members add", () => {
  it("prints usage and exits 1 when orgId is missing", async () => {
    await expect(
      runOrg(["members", "add", "--user", "u1"]),
    ).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: seamless org members add"));
  });

  it("prints usage and exits 1 when neither --user nor --email is given", async () => {
    await expect(runOrg(["members", "add", "o1"])).rejects.toBeInstanceOf(ExitError);
    expect(vi.mocked(addMember)).not.toHaveBeenCalled();
  });

  it("adds a member by --user with roles and scopes", async () => {
    vi.mocked(addMember).mockResolvedValue(apiMembership({ roles: ["admin"] }));
    await runOrg([
      "members",
      "add",
      "o1",
      "--user",
      "u1",
      "--roles",
      "admin, member",
      "--scopes",
      "read",
    ]);
    expect(vi.mocked(addMember)).toHaveBeenCalledWith(fakeClient, "o1", {
      userId: "u1",
      roles: ["admin", "member"],
      scopes: ["read"],
    });
    expect(logs()).toContain("Added member.");
  });

  it("adds a member by --email without roles or scopes", async () => {
    vi.mocked(addMember).mockResolvedValue(apiMembership({ userId: "u2" }));
    await runOrg(["members", "add", "o1", "--email", "x@example.com"]);
    expect(vi.mocked(addMember)).toHaveBeenCalledWith(fakeClient, "o1", {
      email: "x@example.com",
    });
  });
});

describe("runOrg members update", () => {
  it("prints usage and exits 1 when orgId or userId is missing", async () => {
    await expect(runOrg(["members", "update", "o1"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: seamless org members update"),
    );
  });

  it("errors when neither --roles nor --scopes is given", async () => {
    await expect(
      runOrg(["members", "update", "o1", "u1"]),
    ).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Nothing to update"));
  });

  it("updates a member's roles and scopes", async () => {
    vi.mocked(updateMember).mockResolvedValue(apiMembership({ roles: ["owner"] }));
    await runOrg(["members", "update", "o1", "u1", "--roles", "owner", "--scopes", "admin"]);
    expect(vi.mocked(updateMember)).toHaveBeenCalledWith(fakeClient, "o1", "u1", {
      roles: ["owner"],
      scopes: ["admin"],
    });
    expect(logs()).toContain("Updated member.");
  });
});

describe("runOrg members remove", () => {
  it("prints usage and exits 1 when orgId or userId is missing", async () => {
    await expect(runOrg(["members", "remove", "o1"])).rejects.toBeInstanceOf(ExitError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: seamless org members remove"),
    );
  });

  it("cancels when the prompt is cancelled", async () => {
    vi.mocked(isCancel).mockReturnValue(true);
    await runOrg(["members", "remove", "o1", "u1"]);
    expect(logs()).toContain("Cancelled.");
    expect(vi.mocked(removeMember)).not.toHaveBeenCalled();
  });

  it("cancels when the user declines", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    await runOrg(["members", "remove", "o1", "u1"]);
    expect(logs()).toContain("Cancelled.");
    expect(vi.mocked(removeMember)).not.toHaveBeenCalled();
  });

  it("removes the member on confirmation", async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(removeMember).mockResolvedValue(undefined);
    await runOrg(["members", "remove", "o1", "u1"]);
    expect(vi.mocked(confirm)).toHaveBeenCalledWith({
      message: "Remove user u1 from organization o1?",
      initialValue: false,
    });
    expect(vi.mocked(removeMember)).toHaveBeenCalledWith(fakeClient, "o1", "u1");
    expect(logs()).toContain("Removed user u1 from o1.");
  });
});

describe("org members remove --force", () => {
  it.each(["--force", "--yes", "-y"])(
    "removes without confirming when given %s",
    async (flag) => {
      vi.mocked(removeMember).mockResolvedValue(undefined as never);

      await runOrg(["members", "remove", "o1", "u1", flag]);

      expect(vi.mocked(confirm)).not.toHaveBeenCalled();
      expect(logs()).toContain("Removed user u1 from o1.");
    },
  );

  it("refuses to ask without a terminal, naming --force", async () => {
    process.stdin.isTTY = false;

    await expect(runOrg(["members", "remove", "o1", "u1"])).rejects.toThrow(
      /needs an interactive terminal[\s\S]*--force/,
    );
    expect(vi.mocked(removeMember)).not.toHaveBeenCalled();
  });
});
