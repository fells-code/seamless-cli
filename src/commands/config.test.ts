import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

import type { AuthClient } from "../core/authClient.js";
import type { ApiResponse } from "../core/http.js";
import { createAuthClient, ReauthRequiredError } from "../core/authClient.js";
import { runConfig } from "./config.js";

vi.mock("fs", () => {
  const fns = {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
  return { default: fns, ...fns };
});

vi.mock("../core/authClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/authClient.js")>();
  return { ...actual, createAuthClient: vi.fn() };
});

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: (value: unknown) => value === CANCEL_SYMBOL,
}));

import { confirm } from "@clack/prompts";

const CANCEL_SYMBOL = Symbol("cancel");

function response<T>(status: number, data: T | null): ApiResponse<T> {
  return { ok: status >= 200 && status < 300, status, data, headers: new Headers() };
}

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

function fakeClient(
  handler: (rec: Recorded) => ApiResponse<unknown>,
): { client: AuthClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const record = (method: string, path: string, init?: RequestInit): ApiResponse<unknown> => {
    const rec: Recorded = {
      method,
      path,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(rec);
    return handler(rec);
  };
  return {
    calls,
    client: {
      profile: { name: "default", instanceUrl: "https://auth.example.com" },
      get: async (path) => record("GET", path) as never,
      post: async (path, body) =>
        record("POST", path, { body: JSON.stringify(body) }) as never,
      request: async (path, init) =>
        record((init?.method ?? "GET").toUpperCase(), path, init) as never,
    },
  };
}

let logs: string[];
let errors: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logs = [];
  errors = [];
  vi.mocked(fs.existsSync).mockReset();
  vi.mocked(fs.readFileSync).mockReset();
  vi.mocked(createAuthClient).mockReset();
  vi.mocked(confirm).mockReset();

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

describe("runConfig — dispatch", () => {
  it("prints usage and exits 1 for an unknown subcommand", async () => {
    vi.mocked(createAuthClient).mockResolvedValue(fakeClient(() => response(200, {})).client);

    await expect(runConfig(["bogus"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Unknown config subcommand: bogus");
    expect(output()).toContain("Usage: seamless config");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prints (none) for a missing subcommand", async () => {
    vi.mocked(createAuthClient).mockResolvedValue(fakeClient(() => response(200, {})).client);
    await expect(runConfig([])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Unknown config subcommand: (none)");
  });

  it("prints a yellow message and exits 1 on ReauthRequiredError", async () => {
    vi.mocked(createAuthClient).mockRejectedValue(
      new ReauthRequiredError("No active profile is configured."),
    );
    await expect(runConfig(["get"])).rejects.toThrow("process.exit(1)");
    expect(output()).toContain("No active profile is configured.");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prints red message and exits 1 on PermissionError from a subcommand", async () => {
    const { client } = fakeClient(() => response(403, { error: "Forbidden" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    await expect(runConfig(["get"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain(
      "You do not have permission for this action. It requires an admin role on the instance.",
    );
  });

  it("prints red message and exits 1 on ConfigApiError from a subcommand", async () => {
    const { client } = fakeClient(() => response(500, null));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    await expect(runConfig(["get"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Could not read system config (500).");
  });

  it("rethrows unexpected errors", async () => {
    vi.mocked(createAuthClient).mockRejectedValue(new Error("boom"));
    await expect(runConfig(["get"])).rejects.toThrow("boom");
  });

  it("passes the --profile flag through to createAuthClient", async () => {
    const { client } = fakeClient(() => response(200, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    await runConfig(["get", "--profile", "staging", "--json"]);
    expect(createAuthClient).toHaveBeenCalledWith({ profileFlag: "staging" });
  });
});

describe("runConfig get", () => {
  it("prints the whole config as a table when no key or --json", async () => {
    const { client } = fakeClient(() =>
      response(200, { app_name: "Acme", rate_limit: 100 }),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["get"]);

    expect(output()).toContain("app_name");
    expect(output()).toContain("Acme");
    expect(output()).toContain("rate_limit");
    expect(output()).toContain("100");
  });

  it("prints the whole config as JSON with --json", async () => {
    const { client } = fakeClient(() => response(200, { app_name: "Acme" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["get", "--json"]);

    expect(output()).toContain(JSON.stringify({ app_name: "Acme" }, null, 2));
  });

  it("prints a string value raw when a key is given without --json", async () => {
    const { client } = fakeClient(() => response(200, { app_name: "Acme" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["get", "app_name"]);

    expect(output()).toBe("Acme");
  });

  it("prints a non-string value as JSON when a key is given without --json", async () => {
    const { client } = fakeClient(() => response(200, { rate_limit: 100 }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["get", "rate_limit"]);

    expect(output()).toBe("100");
  });

  it("prints a key's value as JSON with --json", async () => {
    const { client } = fakeClient(() => response(200, { app_name: "Acme" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["get", "app_name", "--json"]);

    expect(output()).toBe('"Acme"');
  });

  it("errors and exits 1 for an unknown key", async () => {
    const { client } = fakeClient(() => response(200, { app_name: "Acme" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(runConfig(["get", "nope"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("No such config key: nope");
  });
});

describe("runConfig set", () => {
  it("errors and exits 1 when the key is missing", async () => {
    const { client } = fakeClient(() => response(200, { updatedKeys: [] }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(runConfig(["set"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Usage: seamless config set <key> <value>");
  });

  it("errors and exits 1 when the value is missing", async () => {
    const { client } = fakeClient(() => response(200, { updatedKeys: [] }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(runConfig(["set", "app_name"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Usage: seamless config set <key> <value>");
  });

  it("patches the config and reports updated keys", async () => {
    const { client, calls } = fakeClient(() =>
      response(200, { success: true, updatedKeys: ["app_name"] }),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["set", "app_name", "My", "App"]);

    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/system-config/admin" });
    expect(calls[0].body).toEqual({ app_name: "My App" });
    expect(output()).toContain("Updated: app_name");
  });

  it("parses a JSON value before patching", async () => {
    const { client, calls } = fakeClient(() =>
      response(200, { success: true, updatedKeys: ["rate_limit"] }),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["set", "rate_limit", "100"]);

    expect(calls[0].body).toEqual({ rate_limit: 100 });
  });

  // Both arrived in auth API v0.17.0 (#221). They are booleans on the instance, so
  // the value has to reach it as one, not as the string "true".
  it.each(["prompt_passkey_enrollment", "phishing_resistant_only"])(
    "sets %s as a boolean",
    async (key) => {
      const { client, calls } = fakeClient(() =>
        response(200, { success: true, updatedKeys: [key] }),
      );
      vi.mocked(createAuthClient).mockResolvedValue(client);

      await runConfig(["set", key, "true"]);

      expect(calls[0].body).toEqual({ [key]: true });
      expect(output()).toContain(`Updated: ${key}`);
    },
  );

  it("prints 'No changes.' when nothing was updated", async () => {
    const { client } = fakeClient(() => response(200, { success: true, updatedKeys: [] }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["set", "app_name", "Same"]);

    expect(output()).toContain("No changes.");
  });

  // JSON-parsing a string-typed key sent the wrong type for a value that merely
  // looks like JSON.
  it.each([
    ["app_name", "123"],
    ["app_name", "true"],
    ["rpid", "true"],
    ["access_token_ttl", "900"],
  ])("sends %s=%s as a string", async (key, raw) => {
    const { client, calls } = fakeClient(() =>
      response(200, { success: true, updatedKeys: [key] }),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["set", key, raw]);

    expect(calls[0].body).toEqual({ [key]: raw });
  });

  it("rejects a key that is not writable, naming the ones that are", async () => {
    const { client, calls } = fakeClient(() => response(200, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(runConfig(["set", "frontend_url", "https://app.example.com"])).rejects.toThrow(
      "process.exit(1)",
    );

    expect(errOutput()).toContain('"frontend_url" is not a writable config key.');
    expect(errOutput()).toContain("app_name");
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown key before reaching the instance", async () => {
    const { client, calls } = fakeClient(() => response(200, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(runConfig(["set", "bogus", "1"])).rejects.toThrow("process.exit(1)");

    expect(calls).toHaveLength(0);
  });
});

describe("runConfig roles", () => {
  it("prints roles as JSON with --json", async () => {
    const { client } = fakeClient(() => response(200, { roles: ["admin", "user"] }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["roles", "--json"]);

    expect(output()).toContain(JSON.stringify(["admin", "user"], null, 2));
  });

  it("prints 'No roles.' when the list is empty", async () => {
    const { client } = fakeClient(() => response(200, { roles: [] }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["roles"]);

    expect(output()).toContain("No roles.");
  });

  it("prints each role indented", async () => {
    const { client } = fakeClient(() => response(200, { roles: ["admin", "user"] }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["roles"]);

    expect(output()).toContain("  admin");
    expect(output()).toContain("  user");
  });
});

describe("runConfig diff", () => {
  it("errors and exits 1 when no file is given", async () => {
    const { client } = fakeClient(() => response(200, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(runConfig(["diff"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Usage: seamless config diff <file>");
  });

  // A misspelt key otherwise shows up as a value the instance has not set.
  it("flags a key no config this CLI knows has", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ app_name: "Acme", acess_token_ttl: "15m" }),
    );
    const { client } = fakeClient(() => response(200, { app_name: "Acme" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["diff", "local.json"]);

    expect(output()).toContain("Not a config key this CLI knows: acess_token_ttl");
  });

  it("propagates a ConfigApiError and exits 1 when the file cannot be read", async () => {
    const { client } = fakeClient(() => response(200, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    await expect(runConfig(["diff", "missing.json"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Could not read file: missing.json");
  });

  it("propagates a ConfigApiError when the file is not valid JSON", async () => {
    const { client } = fakeClient(() => response(200, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(fs.readFileSync).mockReturnValue("{ not json");

    await expect(runConfig(["diff", "bad.json"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("bad.json is not valid JSON.");
  });

  it("propagates a ConfigApiError when the file is not a JSON object", async () => {
    const { client } = fakeClient(() => response(200, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(fs.readFileSync).mockReturnValue("[1, 2]");

    await expect(runConfig(["diff", "array.json"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("array.json must contain a JSON object.");
  });

  it("prints 'In sync' when there are no differences", async () => {
    const { client } = fakeClient(() => response(200, { app_name: "Acme" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ app_name: "Acme" }));

    await runConfig(["diff", "local.json"]);

    expect(output()).toContain("In sync. No differences.");
  });

  it("prints changes when local differs from remote", async () => {
    const { client } = fakeClient(() =>
      response(200, { app_name: "Acme", rate_limit: 100 }),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ app_name: "Acme", rate_limit: 250 }),
    );

    await runConfig(["diff", "local.json"]);

    expect(output()).toContain("rate_limit");
    expect(output()).toContain("- 100");
    expect(output()).toContain("+ 250");
  });
});

describe("runConfig apply", () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ app_name: "Acme", bogus: 1 }),
    );
  });

  it("errors and exits 1 when no file is given", async () => {
    const { client } = fakeClient(() => response(200, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(runConfig(["apply"])).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Usage: seamless config apply <file> [--dry-run]");
  });

  it("reports read-only and unknown keys separately", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        app_name: "Acme",
        frontend_url: "https://app.example.com",
        bogus: 1,
      }),
    );
    const { client } = fakeClient(() => response(200, { app_name: "Old" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(confirm).mockResolvedValue(true);

    await runConfig(["apply", "local.json"]);

    expect(output()).toContain("Ignoring read-only keys: frontend_url");
    expect(output()).toContain("Ignoring unknown keys: bogus");
  });

  it("prints 'Already in sync' when there is nothing to apply", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ app_name: "Acme" }));
    const { client } = fakeClient(() => response(200, { app_name: "Acme" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["apply", "local.json"]);

    expect(output()).toContain("Already in sync. Nothing to apply.");
  });

  it("prints changes and skips the patch on --dry-run", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ app_name: "New" }));
    const { client, calls } = fakeClient(() => response(200, { app_name: "Old" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["apply", "local.json", "--dry-run"]);

    expect(output()).toContain("app_name");
    expect(output()).toContain("Dry run: no changes applied.");
    expect(calls).toHaveLength(1); // only the GET for remote config, no PATCH
  });

  it("cancels when the user declines the confirm prompt", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ app_name: "New" }));
    const { client, calls } = fakeClient(() => response(200, { app_name: "Old" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(confirm).mockResolvedValue(false);

    await runConfig(["apply", "local.json"]);

    expect(output()).toContain("Cancelled.");
    expect(calls).toHaveLength(1);
  });

  it("cancels when the confirm prompt is aborted (isCancel)", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ app_name: "New" }));
    const { client } = fakeClient(() => response(200, { app_name: "Old" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(confirm).mockResolvedValue(CANCEL_SYMBOL as never);

    await runConfig(["apply", "local.json"]);

    expect(output()).toContain("Cancelled.");
  });

  it("applies the patch and reports updated keys on confirm", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ app_name: "New" }));
    const { client, calls } = fakeClient((rec) => {
      if (rec.method === "PATCH") {
        return response(200, { success: true, updatedKeys: ["app_name"] });
      }
      return response(200, { app_name: "Old" });
    });
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(confirm).mockResolvedValue(true);

    await runConfig(["apply", "local.json"]);

    expect(calls[1]).toMatchObject({ method: "PATCH", path: "/system-config/admin" });
    expect(calls[1].body).toEqual({ app_name: "New" });
    expect(output()).toContain("Applied. Updated: app_name");
  });

  it("reports '(none reported)' when the patch response has no updatedKeys", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ app_name: "New" }));
    const { client } = fakeClient((rec) => {
      if (rec.method === "PATCH") return response(200, { success: true });
      return response(200, { app_name: "Old" });
    });
    vi.mocked(createAuthClient).mockResolvedValue(client);
    vi.mocked(confirm).mockResolvedValue(true);

    await runConfig(["apply", "local.json"]);

    expect(output()).toContain("Applied. Updated: (none reported)");
  });
});

describe("runConfig oauth-providers", () => {
  it("lists providers with an enabled/disabled status", async () => {
    const { client } = fakeClient(() =>
      response(200, {
        providers: [
          { id: "google", name: "Google", enabled: true },
          { id: "github", name: "GitHub", enabled: false },
        ],
      }),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["oauth-providers", "list"]);

    expect(output()).toContain("google");
    expect(output()).toContain("enabled");
    expect(output()).toContain("github");
    expect(output()).toContain("disabled");
  });

  it("lists providers as JSON with --json", async () => {
    const { client } = fakeClient(() =>
      response(200, { providers: [{ id: "google" }] }),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["oauth-providers", "list", "--json"]);

    expect(output()).toContain(JSON.stringify([{ id: "google" }], null, 2));
  });

  it("adds a provider from an inline JSON object", async () => {
    const { client, calls } = fakeClient(() =>
      response(201, { provider: { id: "google" } }),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig([
      "oauth-providers",
      "add",
      '{"id":"google","name":"Google"}',
    ]);

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/system-config/oauth-providers",
      body: { id: "google", name: "Google" },
    });
    expect(output()).toContain("Added OAuth provider: google");
  });

  it("adds a provider from a --file JSON object", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ id: "github", name: "GitHub" }),
    );
    const { client, calls } = fakeClient(() =>
      response(201, { provider: { id: "github" } }),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["oauth-providers", "add", "--file", "github.json"]);

    expect(calls[0]?.body).toEqual({ id: "github", name: "GitHub" });
    expect(output()).toContain("Added OAuth provider: github");
  });

  it("rejects an add with no JSON and no --file", async () => {
    const { client } = fakeClient(() => response(201, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(runConfig(["oauth-providers", "add"])).rejects.toThrow(
      "process.exit(1)",
    );
    expect(errOutput()).toContain("Provide a JSON provider object");
  });

  it("updates a provider and strips any id in the body", async () => {
    const { client, calls } = fakeClient(() =>
      response(200, { provider: { id: "google", enabled: false } }),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig([
      "oauth-providers",
      "update",
      "google",
      '{"id":"google","enabled":false}',
    ]);

    expect(calls[0]).toEqual({
      method: "PATCH",
      path: "/system-config/oauth-providers/google",
      body: { enabled: false },
    });
    expect(output()).toContain("Updated OAuth provider: google");
  });

  it("requires an id for update", async () => {
    const { client } = fakeClient(() => response(200, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(
      runConfig(["oauth-providers", "update"]),
    ).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("update <id>");
  });

  it("removes a provider after confirmation", async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    const { client, calls } = fakeClient(() =>
      response(200, { success: true, id: "google" }),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["oauth-providers", "remove", "google"]);

    expect(calls[0]).toEqual({
      method: "DELETE",
      path: "/system-config/oauth-providers/google",
      body: undefined,
    });
    expect(output()).toContain("Removed OAuth provider: google");
  });

  it("does not remove a provider when confirmation is declined", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    const { client, calls } = fakeClient(() => response(200, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["oauth-providers", "remove", "google"]);

    expect(calls).toHaveLength(0);
    expect(output()).toContain("Cancelled.");
  });

  it("skips confirmation with --yes", async () => {
    const { client, calls } = fakeClient(() =>
      response(200, { success: true, id: "google" }),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["oauth-providers", "remove", "google", "--yes"]);

    expect(confirm).not.toHaveBeenCalled();
    expect(calls[0]?.method).toBe("DELETE");
  });

  it("prints usage for an unknown oauth-providers subcommand", async () => {
    const { client } = fakeClient(() => response(200, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(
      runConfig(["oauth-providers", "bogus"]),
    ).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain(
      "Unknown config oauth-providers subcommand: bogus",
    );
  });

  it("accepts the 'oauth' alias for the subcommand group", async () => {
    const { client } = fakeClient(() =>
      response(200, { providers: [{ id: "google", enabled: true }] }),
    );
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["oauth", "list"]);

    expect(output()).toContain("google");
  });

  it("prints an empty-state message when there are no providers", async () => {
    const { client } = fakeClient(() => response(200, { providers: [] }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["oauth-providers", "list"]);

    expect(output()).toContain("No OAuth providers configured.");
  });

  it("rejects an add with invalid JSON", async () => {
    const { client } = fakeClient(() => response(201, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(
      runConfig(["oauth-providers", "add", "{not json"]),
    ).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Provider input is not valid JSON.");
  });

  it("rejects an add whose JSON is not an object", async () => {
    const { client } = fakeClient(() => response(201, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(
      runConfig(["oauth-providers", "add", "[1,2,3]"]),
    ).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Provider input must be a JSON object.");
  });

  it("reports an unreadable --file", async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const { client } = fakeClient(() => response(201, {}));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(
      runConfig(["oauth-providers", "add", "--file", "missing.json"]),
    ).rejects.toThrow("process.exit(1)");
    expect(errOutput()).toContain("Could not read file: missing.json");
  });
});

describe("config --force", () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ app_name: "New" }),
    );
  });

  it.each(["--force", "--yes", "-y"])(
    "applies without confirming when given %s",
    async (flag) => {
      const { client } = fakeClient(() =>
        response(200, { app_name: "Old", updatedKeys: ["app_name"] }),
      );
      vi.mocked(createAuthClient).mockResolvedValue(client);

      await runConfig(["apply", "local.json", flag]);

      expect(vi.mocked(confirm)).not.toHaveBeenCalled();
      expect(output()).toContain("Applied.");
    },
  );

  // --dry-run means "show me, change nothing", which --force does not override.
  it("still applies nothing with --dry-run --force", async () => {
    const { client } = fakeClient(() => response(200, { app_name: "Old" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["apply", "local.json", "--dry-run", "--force"]);

    expect(output()).toContain("Dry run: no changes applied.");
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
  });

  it("refuses to ask without a terminal, naming --force", async () => {
    process.stdin.isTTY = false;
    const { client } = fakeClient(() => response(200, { app_name: "Old" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await expect(runConfig(["apply", "local.json"])).rejects.toThrow(
      /needs an interactive terminal[\s\S]*--force/,
    );
  });

  it("removes an OAuth provider without confirming when forced", async () => {
    const { client } = fakeClient(() => response(200, { message: "ok" }));
    vi.mocked(createAuthClient).mockResolvedValue(client);

    await runConfig(["oauth-providers", "remove", "google", "--force"]);

    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
    expect(output()).toContain("Removed OAuth provider: google");
  });
});
