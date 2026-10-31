import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, isCancel } from "@clack/prompts";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  createResource,
  deleteResource,
  getResource,
  listResources,
  updateResource,
} from "../core/admin.js";
import { apiResource, RESOURCE_ID } from "../core/admin.fixtures.js";
import { runResources } from "./resources.js";

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
    listResources: vi.fn(),
    getResource: vi.fn(),
    createResource: vi.fn(),
    updateResource: vi.fn(),
    deleteResource: vi.fn(),
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

async function exits(args: string[]): Promise<void> {
  await expect(runResources(args)).rejects.toBeInstanceOf(ExitError);
}

function lastJson(): unknown {
  return JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
}

describe("runResources", () => {
  it("prints usage on an unknown or missing subcommand", async () => {
    await exits(["bogus"]);
    expect(errors()).toContain("Unknown resources subcommand: bogus");
    expect(logs()).toContain("Usage: seamless resources <list|get|create|update|delete>");

    await exits([]);
    expect(errors()).toContain("(none)");
  });

  it("reports an API error and exits 1", async () => {
    vi.mocked(listResources).mockRejectedValue(new Error("boom"));
    await expect(runResources(["list"])).rejects.toThrow("boom");
  });
});

describe("resources list and get", () => {
  it("lists resources with their scopes", async () => {
    vi.mocked(listResources).mockResolvedValue([
      apiResource(),
      apiResource({ scopes: [], identifier: "urn:example:empty" }),
    ]);
    await runResources(["list"]);
    expect(logs()).toContain("https://orders.example.com");
    expect(logs()).toContain("orders:read orders:write");
    expect(logs()).toContain("(no scopes)");
  });

  it("says so when there are none, and prints JSON on request", async () => {
    vi.mocked(listResources).mockResolvedValue([]);
    await runResources(["list"]);
    expect(logs()).toContain("No resources.");

    vi.mocked(listResources).mockResolvedValue([apiResource()]);
    await runResources(["list", "--json"]);
    expect(lastJson()).toEqual([apiResource()]);
  });

  it("shows one resource", async () => {
    vi.mocked(getResource).mockResolvedValue(apiResource({ accessTokenTtlSeconds: 900 }));
    await runResources(["get", RESOURCE_ID]);
    expect(logs()).toContain("token TTL:   900s");

    vi.mocked(getResource).mockResolvedValue(apiResource({ scopes: [] }));
    await runResources(["get", RESOURCE_ID]);
    expect(logs()).toContain("token TTL:   default");
    expect(logs()).toContain("scopes:      none");

    await runResources(["get", RESOURCE_ID, "--json"]);
    expect(lastJson()).toMatchObject({ id: RESOURCE_ID });

    await exits(["get"]);
    expect(errors()).toContain("Usage: seamless resources get <id>");
  });
});

describe("resources create", () => {
  it("creates a resource with scopes and a TTL", async () => {
    vi.mocked(createResource).mockResolvedValue(apiResource());
    await runResources([
      "create",
      "https://orders.example.com",
      "--name",
      "Orders",
      "--scopes",
      "orders:read, orders:write",
      "--access-token-ttl",
      "900",
    ]);
    expect(createResource).toHaveBeenCalledWith(fakeClient, {
      identifier: "https://orders.example.com",
      name: "Orders",
      scopes: ["orders:read", "orders:write"],
      accessTokenTtlSeconds: 900,
    });
    expect(logs()).toContain(`Created resource ${RESOURCE_ID}.`);

    await runResources(["create", "urn:example:x", "--name", "X", "--json"]);
    expect(lastJson()).toMatchObject({ id: RESOURCE_ID });
  });

  it("refuses a reserved scope or a bad identifier before asking the API", async () => {
    await exits(["create", "https://orders.example.com", "--name", "Orders", "--scopes", "openid"]);
    expect(errors()).toContain("that scope is reserved by the provider");

    await exits(["create", "https://orders.example.com?x=1", "--name", "Orders"]);
    expect(errors()).toContain("identifier must not have a query or fragment");
    expect(createResource).not.toHaveBeenCalled();
  });

  it("needs an identifier and a name", async () => {
    await exits(["create", "https://orders.example.com"]);
    expect(errors()).toContain("Usage: seamless resources create <identifier> --name <name>");
  });

  it("refuses a TTL that is not a whole number", async () => {
    await exits(["create", "urn:x", "--name", "X", "--access-token-ttl", "1.5"]);
    expect(errors()).toContain("--access-token-ttl must be a whole number");
  });
});

describe("resources update", () => {
  it("sends only the settings given", async () => {
    vi.mocked(updateResource).mockResolvedValue(apiResource());
    await runResources([
      "update",
      RESOURCE_ID,
      "--scopes",
      "orders:read",
      "--access-token-ttl",
      "default",
    ]);
    expect(updateResource).toHaveBeenCalledWith(fakeClient, RESOURCE_ID, {
      scopes: ["orders:read"],
      accessTokenTtlSeconds: null,
    });
    expect(logs()).toContain(`Updated resource ${RESOURCE_ID}.`);

    await runResources(["update", RESOURCE_ID, "--name", "Orders v2", "--json"]);
    expect(lastJson()).toMatchObject({ id: RESOURCE_ID });
  });

  it("refuses an empty update, a missing id and a bad scope", async () => {
    await exits(["update", RESOURCE_ID]);
    expect(errors()).toContain("Nothing to update.");

    await exits(["update", "--name", "x"]);
    expect(errors()).toContain("Usage: seamless resources update <id>");

    await exits(["update", RESOURCE_ID, "--scopes", "profile"]);
    expect(errors()).toContain("that scope is reserved by the provider");
  });
});

describe("resources delete", () => {
  it("confirms, then deletes", async () => {
    vi.mocked(deleteResource).mockResolvedValue(undefined);
    await runResources(["delete", RESOURCE_ID]);
    expect(deleteResource).toHaveBeenCalledWith(fakeClient, RESOURCE_ID);
    expect(logs()).toContain(`Deleted resource ${RESOURCE_ID}.`);
  });

  it("does nothing when declined, and needs an id", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    await runResources(["delete", RESOURCE_ID]);
    expect(deleteResource).not.toHaveBeenCalled();
    expect(logs()).toContain("Cancelled.");

    await exits(["delete", "--force"]);
    expect(errors()).toContain("Usage: seamless resources delete <id>");
  });
});
