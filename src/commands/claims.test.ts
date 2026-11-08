import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, isCancel } from "@clack/prompts";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  AdminApiError,
  CUSTOM_CLAIMS_UNSUPPORTED_MESSAGE,
  deleteCustomClaims,
  getCustomClaims,
  listCustomClaims,
  setCustomClaims,
} from "../core/admin.js";
import { apiClaimSource } from "../core/admin.fixtures.js";
import { runClaims } from "./claims.js";

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
    listCustomClaims: vi.fn(),
    getCustomClaims: vi.fn(),
    setCustomClaims: vi.fn(),
    deleteCustomClaims: vi.fn(),
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
  vi.mocked(getCustomClaims).mockResolvedValue(undefined);
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
  await expect(runClaims(args)).rejects.toBeInstanceOf(ExitError);
}

const LISTED = {
  sources: [apiClaimSource()],
  reservedNames: ["sub"],
  reservedPrefixes: ["seamless_"],
  budgetBytes: 1024,
};

describe("runClaims", () => {
  it("prints usage on an unknown or missing subcommand", async () => {
    await exits(["bogus"]);
    expect(errors()).toContain("Unknown claims subcommand: bogus");
    expect(logs()).toContain("Usage: seamless claims <list|get|set|delete>");

    await exits([]);
    expect(errors()).toContain("(none)");
  });

  it("passes --profile to the client", async () => {
    vi.mocked(listCustomClaims).mockResolvedValue(LISTED);
    await runClaims(["list", "--profile", "staging"]);
    expect(createAuthClient).toHaveBeenCalledWith({ profileFlag: "staging" });
  });

  it("says an instance before v0.23 has no custom claims, and exits 1", async () => {
    vi.mocked(listCustomClaims).mockRejectedValue(
      new AdminApiError(CUSTOM_CLAIMS_UNSUPPORTED_MESSAGE),
    );
    await exits(["list"]);
    expect(errors()).toContain("Seamless Auth API v0.23 or later");
  });

  it("needs a known source kind and a name", async () => {
    await exits(["get", "group", "billing"]);
    expect(errors()).toContain(
      "The source kind is one of instance_role, organization_role, oidc_client, not group.",
    );
    await exits(["get", "instance_role"]);
    expect(errors()).toContain("Usage: seamless claims get <instance_role|organization_role|oidc_client> <name>");
  });
});

describe("claims list and get", () => {
  it("lists every source and the budget", async () => {
    vi.mocked(listCustomClaims).mockResolvedValue(LISTED);
    await runClaims(["list"]);
    expect(logs()).toContain("organization_role billing");
    expect(logs()).toContain('tier: "gold"');
    expect(logs()).toContain("Token budget: 1024 bytes");

    await runClaims(["list", "--json"]);
    expect(lastJson()).toEqual(LISTED);
  });

  it("says so when there are none", async () => {
    vi.mocked(listCustomClaims).mockResolvedValue({ ...LISTED, sources: [] });
    await runClaims(["list"]);
    expect(logs()).toContain("No custom claims.");
  });

  it("gets one source, or says it has none", async () => {
    vi.mocked(getCustomClaims).mockResolvedValue(apiClaimSource());
    await runClaims(["get", "organization_role", "billing"]);
    expect(getCustomClaims).toHaveBeenCalledWith(fakeClient, "organization_role", "billing");
    expect(logs()).toContain('tier: "gold"');
    await runClaims(["get", "organization_role", "billing", "--json"]);
    expect(lastJson()).toEqual(apiClaimSource());

    vi.mocked(getCustomClaims).mockResolvedValue(undefined);
    await exits(["get", "oidc_client", "app1"]);
    expect(errors()).toContain("No custom claims are set for oidc_client app1.");
  });
});

describe("claims set", () => {
  it("sets claims from an argument without asking when nothing is removed", async () => {
    vi.mocked(getCustomClaims).mockResolvedValue(apiClaimSource());
    vi.mocked(setCustomClaims).mockResolvedValue(
      apiClaimSource({ claims: { tier: "gold", region: ["eu"] } }),
    );
    await runClaims(["set", "organization_role", "billing", '{"tier":"gold","region":["eu"]}']);
    expect(confirm).not.toHaveBeenCalled();
    expect(setCustomClaims).toHaveBeenCalledWith(fakeClient, "organization_role", "billing", {
      tier: "gold",
      region: ["eu"],
    });
    expect(logs()).toContain("Set the custom claims of organization_role billing.");
  });

  it("reads claims from a file and prints JSON on request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claims-"));
    const file = join(dir, "claims.json");
    writeFileSync(file, '{"plan":"pro"}');
    vi.mocked(setCustomClaims).mockResolvedValue(apiClaimSource({ claims: { plan: "pro" } }));
    await runClaims(["set", "instance_role", "support", "--file", file, "--json"]);
    expect(setCustomClaims).toHaveBeenCalledWith(fakeClient, "instance_role", "support", {
      plan: "pro",
    });
    expect(lastJson()).toMatchObject({ claims: { plan: "pro" } });

    await exits(["set", "instance_role", "support", "--file", join(dir, "missing.json")]);
    expect(errors()).toContain("Could not read");

    writeFileSync(file, "{not json");
    await exits(["set", "instance_role", "support", "--file", file]);
    expect(errors()).toContain(`${file} is not valid JSON.`);
  });

  it("asks before removing a claim, and stops when declined", async () => {
    vi.mocked(getCustomClaims).mockResolvedValue(
      apiClaimSource({ claims: { tier: "gold", region: "eu" } }),
    );
    vi.mocked(confirm).mockResolvedValue(false);
    await runClaims(["set", "organization_role", "billing", '{"tier":"gold"}']);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Remove region from organization_role billing? Holders lose it"),
      }),
    );
    expect(setCustomClaims).not.toHaveBeenCalled();
    expect(logs()).toContain("Cancelled.");

    vi.mocked(confirm).mockClear();
    vi.mocked(getCustomClaims).mockResolvedValue(
      apiClaimSource({ claims: { a: 1, b: 2 } }),
    );
    vi.mocked(setCustomClaims).mockResolvedValue(apiClaimSource({ claims: {} }));
    await runClaims(["set", "organization_role", "billing", "{}", "--force"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(setCustomClaims).toHaveBeenCalledWith(fakeClient, "organization_role", "billing", {});
  });

  it("refuses reserved names, bad names, deep values and an oversized set before asking the API", async () => {
    await exits(["set", "instance_role", "a", '{"email":"x@example.com"}']);
    expect(errors()).toContain("email is a reserved claim name.");

    await exits(["set", "instance_role", "a", '{"seamless_tier":1}']);
    expect(errors()).toContain("seamless_tier is a reserved claim name.");

    await exits(["set", "instance_role", "a", '{"Tier":1}']);
    expect(errors()).toContain("Tier is not a valid claim name.");

    await exits(["set", "instance_role", "a", '{"deep":{"a":{"b":{"c":{"d":1}}}}}']);
    expect(errors()).toContain("must not nest deeper than 3 levels");

    await exits(["set", "instance_role", "a", JSON.stringify({ big: "x".repeat(1100) })]);
    expect(errors()).toContain("must fit in 1024 bytes serialized");

    await exits(["set", "instance_role", "a", "[1]"]);
    expect(errors()).toContain("Claims are a JSON object");

    await exits(["set", "instance_role", "a", "{nope"]);
    expect(errors()).toContain("the claims argument is not valid JSON.");

    expect(setCustomClaims).not.toHaveBeenCalled();
    expect(getCustomClaims).not.toHaveBeenCalled();
  });

  it("needs the claims inline or from a file, not both or neither", async () => {
    await exits(["set", "instance_role", "a"]);
    expect(errors()).toContain("Give the claims inline or with --file, not both.");
    await exits(["set", "instance_role", "a", "{}", "--file", "x.json"]);
    expect(errors()).toContain("not both");
  });
});

describe("claims delete", () => {
  it("confirms, then deletes; --force skips the question; declining does nothing", async () => {
    await runClaims(["delete", "organization_role", "billing"]);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Delete every custom claim") }),
    );
    expect(deleteCustomClaims).toHaveBeenCalledWith(fakeClient, "organization_role", "billing");
    expect(logs()).toContain("Deleted the custom claims of organization_role billing.");

    vi.mocked(confirm).mockClear();
    await runClaims(["delete", "organization_role", "billing", "--force"]);
    expect(confirm).not.toHaveBeenCalled();

    vi.mocked(confirm).mockResolvedValue(false);
    await runClaims(["delete", "organization_role", "billing"]);
    expect(deleteCustomClaims).toHaveBeenCalledTimes(2);
    expect(logs()).toContain("Cancelled.");
  });
});
