import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, isCancel } from "@clack/prompts";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  AdminApiError,
  createApplication,
  deleteApplication,
  getApplication,
  listApplicationResources,
  listApplications,
  listResources,
  rotateApplicationSecret,
  setApplicationKeys,
  setApplicationResources,
  updateApplication,
} from "../core/admin.js";
import { apiApplication, apiResource, RESOURCE_ID } from "../core/admin.fixtures.js";
import { runClients } from "./clients.js";

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
    listApplications: vi.fn(),
    getApplication: vi.fn(),
    createApplication: vi.fn(),
    updateApplication: vi.fn(),
    deleteApplication: vi.fn(),
    rotateApplicationSecret: vi.fn(),
    setApplicationKeys: vi.fn(),
    listApplicationResources: vi.fn(),
    setApplicationResources: vi.fn(),
    listResources: vi.fn(),
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
  await expect(runClients(args)).rejects.toBeInstanceOf(ExitError);
}

async function tempFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clients-test-"));
  const path = join(dir, "jwks.json");
  await writeFile(path, contents);
  return path;
}

const JWKS = { keys: [{ kty: "EC", kid: "k1", alg: "ES256", crv: "P-256", x: "x", y: "y" }] };

describe("runClients routing", () => {
  it("prints usage on an unknown or missing subcommand", async () => {
    await exits(["bogus"]);
    expect(errors()).toContain("Unknown clients subcommand: bogus");
    expect(logs()).toContain("Usage: seamless clients <list|get|create");

    await exits([]);
    expect(errors()).toContain("(none)");
  });

  it("passes --profile to the auth client", async () => {
    vi.mocked(listApplications).mockResolvedValue([]);
    await runClients(["list", "--profile", "staging"]);
    expect(createAuthClient).toHaveBeenCalledWith({ profileFlag: "staging" });
  });

  it("reports an API error and exits 1", async () => {
    vi.mocked(listApplications).mockRejectedValue(new AdminApiError("Could not list (500)."));
    await exits(["list"]);
    expect(errors()).toContain("Could not list (500).");
  });
});

describe("clients list and get", () => {
  it("lists clients and marks shared secrets as weaker", async () => {
    vi.mocked(listApplications).mockResolvedValue([
      apiApplication(),
      apiApplication({
        id: "client_legacy",
        tokenEndpointAuthMethod: "client_secret_basic",
        disabled: true,
      }),
    ]);
    await runClients(["list"]);
    expect(logs()).toContain("client_docs");
    expect(logs()).toMatch(/client_secret_basic .*weaker/);
    expect(logs()).toContain("disabled");
  });

  it("says so when there are none, and prints JSON on request", async () => {
    vi.mocked(listApplications).mockResolvedValue([]);
    await runClients(["list"]);
    expect(logs()).toContain("No applications.");

    vi.mocked(listApplications).mockResolvedValue([apiApplication()]);
    await runClients(["list", "--json"]);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual([apiApplication()]);
  });

  it("shows a client's settings", async () => {
    vi.mocked(getApplication).mockResolvedValue(
      apiApplication({
        firstParty: true,
        deviceFlowEnabled: true,
        postLogoutRedirectUris: ["https://docs.example.com/bye"],
        backchannelLogoutUri: "https://docs.example.com/logout",
      }),
    );
    await runClients(["get", "client_docs"]);
    expect(getApplication).toHaveBeenCalledWith(fakeClient, "client_docs");
    expect(logs()).toContain("first-party");
    expect(logs()).toContain("device_code");
    expect(logs()).toContain("register keys before this client can get tokens");
    expect(logs()).toContain("https://docs.example.com/bye");
    expect(logs()).toContain("https://docs.example.com/logout");
  });

  it("shows registered keys or a JWKS URI", async () => {
    vi.mocked(getApplication).mockResolvedValue(apiApplication({ jwks: JWKS }));
    await runClients(["get", "client_docs"]);
    expect(logs()).toContain("1 key(s) registered");

    vi.mocked(getApplication).mockResolvedValue(
      apiApplication({ jwksUri: "https://docs.example.com/jwks.json" }),
    );
    await runClients(["get", "client_docs"]);
    expect(logs()).toContain("https://docs.example.com/jwks.json");
  });

  it("shows whether a shared secret is set, and prints JSON on request", async () => {
    vi.mocked(getApplication).mockResolvedValue(
      apiApplication({
        tokenEndpointAuthMethod: "client_secret_post",
        hasSecret: true,
        redirectUris: [],
        grantTypes: [],
        disabled: true,
      }),
    );
    await runClients(["get", "client_docs"]);
    expect(logs()).toContain("secret set:      yes");
    expect(logs()).toContain("redirect URIs:   none");

    await runClients(["get", "client_docs", "--json"]);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).hasSecret).toBe(true);
  });

  it("needs an id", async () => {
    await exits(["get"]);
    expect(errors()).toContain("Usage: seamless clients get <id>");
  });
});

describe("clients create", () => {
  it("creates a confidential private_key_jwt client by default", async () => {
    vi.mocked(createApplication).mockResolvedValue({ application: apiApplication() });
    const path = await tempFile(JSON.stringify(JWKS));

    await runClients([
      "create",
      "Docs",
      "--redirect-uri",
      "https://docs.example.com/callback",
      "--jwks-file",
      path,
    ]);

    expect(vi.mocked(createApplication).mock.calls[0][1]).toMatchObject({
      name: "Docs",
      clientType: "confidential",
      redirectUris: ["https://docs.example.com/callback"],
      grantTypes: ["authorization_code", "refresh_token"],
      jwks: JWKS,
    });
    expect(logs()).toContain("Created application client_docs.");
  });

  it("creates a public client with loopback and private-use redirects", async () => {
    vi.mocked(createApplication).mockResolvedValue({
      application: apiApplication({ clientType: "public", tokenEndpointAuthMethod: "none" }),
    });

    await runClients([
      "create",
      "--name",
      "Desk",
      "--public",
      "--redirect-uri=http://127.0.0.1/callback",
      "--redirect-uri",
      "com.example.desk:/callback",
      "--first-party",
      "--device-flow",
      "--notices",
      "--grants",
      "authorization_code,refresh_token",
      "--access-token-ttl",
      "600",
      "--id-token-ttl",
      "default",
    ]);

    expect(vi.mocked(createApplication).mock.calls[0][1]).toMatchObject({
      name: "Desk",
      clientType: "public",
      redirectUris: ["http://127.0.0.1/callback", "com.example.desk:/callback"],
      firstParty: true,
      deviceFlowEnabled: true,
      noticesEnabled: true,
      accessTokenTtlSeconds: 600,
      idTokenTtlSeconds: null,
    });
  });

  it("prints a shared secret once, with the weaker-secret note", async () => {
    vi.mocked(createApplication).mockResolvedValue({
      application: apiApplication({ tokenEndpointAuthMethod: "client_secret_basic" }),
      clientSecret: "shown-once",
    });

    await runClients([
      "create",
      "Billing",
      "--auth-method",
      "client_secret_basic",
      "--grants",
      "client_credentials",
      "--post-logout-uri",
      "https://billing.example.com/bye",
      "--backchannel-logout-uri",
      "https://billing.example.com/logout",
    ]);

    expect(logs()).toContain("shown-once");
    expect(logs()).toContain("Shared secrets are weaker than registered keys");
  });

  it("prints the whole response as JSON, secret included", async () => {
    vi.mocked(createApplication).mockResolvedValue({
      application: apiApplication(),
      clientSecret: "s",
    });
    const path = await tempFile(JSON.stringify(JWKS));
    await runClients(["create", "Docs", "--json", "--jwks-file", path, "--redirect-uri", "https://docs.example.com/cb"]);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).clientSecret).toBe("s");
  });

  it("accepts a JWKS URI", async () => {
    vi.mocked(createApplication).mockResolvedValue({ application: apiApplication() });
    await runClients([
      "create",
      "Docs",
      "--redirect-uri",
      "https://docs.example.com/cb",
      "--jwks-uri",
      "https://docs.example.com/jwks.json",
    ]);
    expect(vi.mocked(createApplication).mock.calls[0][1]).toMatchObject({
      jwksUri: "https://docs.example.com/jwks.json",
    });
  });

  it("refuses a localhost redirect before asking the API", async () => {
    await exits(["create", "Local", "--redirect-uri", "http://localhost:3000/cb"]);
    expect(errors()).toContain("localhost is not a redirect host");
    expect(createApplication).not.toHaveBeenCalled();
  });

  it("refuses cross-field rules the API would refuse", async () => {
    await exits(["create", "Pub", "--public", "--grants", "client_credentials"]);
    expect(errors()).toContain("public clients cannot use client_credentials");
  });

  it("refuses a TTL that is not a whole number", async () => {
    await exits(["create", "Docs", "--access-token-ttl", "soon"]);
    expect(errors()).toContain("--access-token-ttl must be a whole number");
  });

  it("refuses an unreadable or malformed key file", async () => {
    await exits(["create", "Docs", "--jwks-file", "/no/such/file.json"]);
    expect(errors()).toContain("Could not read /no/such/file.json.");

    const path = await tempFile("{");
    await exits(["create", "Docs", "--jwks-file", path]);
    expect(errors()).toContain("is not valid JSON");
  });

  it("needs a name", async () => {
    await exits(["create", "--public"]);
    expect(errors()).toContain("Usage: seamless clients create <name>");
  });
});

describe("clients update", () => {
  it("sends only the settings given", async () => {
    vi.mocked(updateApplication).mockResolvedValue(apiApplication({ disabled: true }));

    await runClients([
      "update",
      "client_docs",
      "--disable",
      "--third-party",
      "--no-device-flow",
      "--no-notices",
      "--backchannel-logout-uri",
      "none",
      "--refresh-token-ttl",
      "3600",
    ]);

    expect(updateApplication).toHaveBeenCalledWith(fakeClient, "client_docs", {
      disabled: true,
      firstParty: false,
      deviceFlowEnabled: false,
      noticesEnabled: false,
      backchannelLogoutUri: null,
      refreshTokenTtlSeconds: 3600,
    });
    expect(logs()).toContain("Updated application client_docs.");
  });

  it("re-enables a client and prints JSON on request", async () => {
    vi.mocked(updateApplication).mockResolvedValue(apiApplication());
    await runClients(["update", "client_docs", "--enable", "--json"]);
    expect(vi.mocked(updateApplication).mock.calls[0][2]).toEqual({ disabled: false });
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).id).toBe("client_docs");
  });

  it("refuses an empty update or a missing id", async () => {
    await exits(["update", "client_docs"]);
    expect(errors()).toContain("Nothing to update.");

    await exits(["update", "--name", "x"]);
    expect(errors()).toContain("Usage: seamless clients update <id>");
  });

  it("refuses a bad redirect before asking the API", async () => {
    await exits(["update", "client_docs", "--redirect-uri", "javascript:alert(1)"]);
    expect(errors()).toContain("reverse domain form");
    expect(updateApplication).not.toHaveBeenCalled();
  });
});

describe("clients rotate-secret", () => {
  it("confirms, then prints the new secret once", async () => {
    vi.mocked(rotateApplicationSecret).mockResolvedValue({
      application: apiApplication({ name: "Billing" }),
      clientSecret: "fresh",
    });
    await runClients(["rotate-secret", "client_docs"]);
    expect(confirm).toHaveBeenCalled();
    expect(logs()).toContain("Issued a new secret for Billing.");
    expect(logs()).toContain("fresh");
  });

  it("skips the confirmation with --force and prints JSON on request", async () => {
    vi.mocked(rotateApplicationSecret).mockResolvedValue({
      application: apiApplication(),
      clientSecret: "fresh",
    });
    await runClients(["rotate-secret", "client_docs", "--force", "--json"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).clientSecret).toBe("fresh");
  });

  it("does nothing when declined, and needs an id", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    await runClients(["rotate-secret", "client_docs"]);
    expect(rotateApplicationSecret).not.toHaveBeenCalled();
    expect(logs()).toContain("Cancelled.");

    await exits(["rotate-secret"]);
    expect(errors()).toContain("Usage: seamless clients rotate-secret <id>");
  });
});

describe("clients keys", () => {
  it("registers a key file or a JWKS URI", async () => {
    vi.mocked(setApplicationKeys).mockResolvedValue(apiApplication());
    const path = await tempFile(JSON.stringify(JWKS));

    await runClients(["keys", "client_docs", "--jwks-file", path]);
    expect(setApplicationKeys).toHaveBeenLastCalledWith(fakeClient, "client_docs", {
      jwks: JWKS,
    });

    await runClients(["keys", "client_docs", "--jwks-uri", "https://docs.example.com/jwks.json"]);
    expect(setApplicationKeys).toHaveBeenLastCalledWith(fakeClient, "client_docs", {
      jwksUri: "https://docs.example.com/jwks.json",
    });
    expect(logs()).toContain("Registered keys for Docs.");
  });

  it("refuses a private key", async () => {
    const path = await tempFile(
      JSON.stringify({ keys: [{ kty: "EC", kid: "k", alg: "ES256", d: "secret" }] }),
    );
    await exits(["keys", "client_docs", "--jwks-file", path]);
    expect(errors()).toContain("private key members");
    expect(setApplicationKeys).not.toHaveBeenCalled();
  });

  it("needs exactly one key source", async () => {
    await exits(["keys", "client_docs"]);
    await exits(["keys", "client_docs", "--jwks-file", "a", "--jwks-uri", "b"]);
    expect(errors()).toContain("Usage: seamless clients keys <id>");
  });
});

describe("clients resources", () => {
  const link = {
    resourceId: RESOURCE_ID,
    identifier: "https://orders.example.com",
    name: "Orders",
    scopes: ["orders:read"],
  };

  it("lists the resources a client may use", async () => {
    vi.mocked(listApplicationResources).mockResolvedValue([link]);
    await runClients(["resources", "client_docs"]);
    expect(logs()).toContain("https://orders.example.com");
    expect(logs()).toContain("orders:read");

    vi.mocked(listApplicationResources).mockResolvedValue([{ ...link, scopes: [] }]);
    await runClients(["resources", "client_docs", "--json"]);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual([{ ...link, scopes: [] }]);

    vi.mocked(listApplicationResources).mockResolvedValue([]);
    await runClients(["resources", "client_docs"]);
    expect(logs()).toContain("No resources allowed.");
  });

  it("replaces the set, resolving identifiers to ids", async () => {
    vi.mocked(listResources).mockResolvedValue([apiResource()]);
    vi.mocked(setApplicationResources).mockResolvedValue([{ ...link, scopes: [] }]);

    await runClients([
      "resources",
      "client_docs",
      "--set",
      "https://orders.example.com=orders:read,orders:write",
      "--set",
      RESOURCE_ID.replace("1", "2"),
    ]);

    expect(setApplicationResources).toHaveBeenCalledWith(fakeClient, "client_docs", [
      { resourceId: RESOURCE_ID, scopes: ["orders:read", "orders:write"] },
      { resourceId: RESOURCE_ID.replace("1", "2"), scopes: [] },
    ]);
    expect(logs()).toContain("Updated the resources application client_docs may use.");
    expect(logs()).toContain("(no scopes)");
  });

  it("looks resources up only when an identifier is given", async () => {
    vi.mocked(setApplicationResources).mockResolvedValue([link]);
    await runClients(["resources", "client_docs", "--set", `${RESOURCE_ID}=orders:read`, "--json"]);
    expect(listResources).not.toHaveBeenCalled();
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual([link]);
  });

  it("clears the set", async () => {
    vi.mocked(setApplicationResources).mockResolvedValue([]);
    await runClients(["resources", "client_docs", "--clear"]);
    expect(setApplicationResources).toHaveBeenCalledWith(fakeClient, "client_docs", []);
  });

  it("refuses an unknown identifier, --set with --clear, and a missing id", async () => {
    vi.mocked(listResources).mockResolvedValue([]);
    await exits(["resources", "client_docs", "--set", "https://nope.example.com"]);
    expect(errors()).toContain("No resource has the identifier https://nope.example.com.");

    await exits(["resources", "client_docs", "--clear", "--set", RESOURCE_ID]);
    expect(errors()).toContain("Pass --set or --clear, not both.");

    await exits(["resources"]);
    expect(errors()).toContain("Usage: seamless clients resources <id>");
  });
});

describe("clients delete", () => {
  it("confirms, then deletes", async () => {
    vi.mocked(deleteApplication).mockResolvedValue(undefined);
    await runClients(["delete", "client_docs"]);
    expect(deleteApplication).toHaveBeenCalledWith(fakeClient, "client_docs");
    expect(logs()).toContain("Deleted application client_docs.");
  });

  it("does nothing when declined, and needs an id", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    await runClients(["delete", "client_docs"]);
    expect(deleteApplication).not.toHaveBeenCalled();

    await exits(["delete", "-y"]);
    expect(errors()).toContain("Usage: seamless clients delete <id>");
  });
});
