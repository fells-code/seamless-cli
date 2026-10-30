import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { gzipSync } from "zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import { runMigrate } from "./migrate.js";

vi.mock("../core/authClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/authClient.js")>();
  return { ...actual, createAuthClient: vi.fn() };
});

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const request = vi.fn();
const fakeClient = {
  profile: { name: "default", instanceUrl: "https://auth.example.com" },
  get: vi.fn(),
  post: vi.fn(),
  request,
} as unknown as AuthClient;

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

function writeCsv(lines: string[]) {
  const file = path.join(dir, "users.csv");
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

function respond(results: unknown[], dryRun: boolean) {
  request.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: new Headers(),
    data: {
      source: "csv",
      dryRun,
      summary: { created: 0, updated: 0, unchanged: 0, rejected: 0 },
      results,
    },
  });
}

const output = () => logSpy.mock.calls.map((c) => String(c[0])).join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-migrate-cmd-"));
  vi.mocked(createAuthClient).mockResolvedValue(fakeClient);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("seamless migrate csv", () => {
  it("is a dry run by default and writes a plan report beside the input", async () => {
    const file = writeCsv(["email", "ada@example.com"]);
    respond([{ index: 0, email: "ada@example.com", status: "created", changes: ["created"] }], true);

    await runMigrate(["csv", file]);

    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body).toEqual({ source: "csv", dryRun: true, users: [{ email: "ada@example.com" }] });
    expect(fs.existsSync(path.join(dir, "users.migrate-plan.csv"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "users.migrate-plan.json"))).toBe(true);
    expect(output()).toMatch(/Dry run: nothing was written/);
  });

  it("writes with --apply and names the report as a result", async () => {
    const file = writeCsv(["email", "ada@example.com"]);
    respond([{ index: 0, email: "ada@example.com", status: "created", userId: "u1" }], false);

    await runMigrate(["csv", file, "--apply", "--source", "hr-export"]);

    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
      source: "hr-export",
      dryRun: false,
    });
    expect(fs.existsSync(path.join(dir, "users.migrate-result.json"))).toBe(true);
  });

  it("exits 1 when a row is rejected or invalid, after writing the report", async () => {
    const file = writeCsv(["email,roles", "ada@example.com,admin", "nope,"]);
    respond(
      [{ index: 0, email: "ada@example.com", status: "rejected", reason: "admin_role_not_allowed" }],
      true,
    );

    await expect(runMigrate(["csv", file, "--report", path.join(dir, "out")])).rejects.toThrow(
      "process.exit(1)",
    );

    const report = JSON.parse(fs.readFileSync(path.join(dir, "out.json"), "utf-8"));
    expect(report.summary).toMatchObject({ rejected: 1, invalid: 1 });
    expect(output()).toMatch(/row 2.*admin_role_not_allowed/s);
  });

  it("writes what finished when a later batch fails", async () => {
    const lines = ["email", ...Array.from({ length: 201 }, (_, i) => `u${i}@example.com`)];
    const file = writeCsv(lines);
    respond(
      Array.from({ length: 200 }, (_, index) => ({
        index,
        email: `u${index}@example.com`,
        status: "created",
      })),
      false,
    );
    request.mockResolvedValueOnce({ ok: false, status: 500, data: null, headers: new Headers() });

    await expect(runMigrate(["csv", file, "--apply"])).rejects.toThrow("process.exit(1)");

    const report = JSON.parse(
      fs.readFileSync(path.join(dir, "users.migrate-result.json"), "utf-8"),
    );
    expect(report.rows).toHaveLength(200);
  });

  it("does not contact the instance when every row is invalid", async () => {
    const file = writeCsv(["email", "nope"]);

    await expect(runMigrate(["csv", file])).rejects.toThrow("process.exit(1)");

    expect(createAuthClient).not.toHaveBeenCalled();
  });

  it("prints JSON with --json", async () => {
    const file = writeCsv(["email", "ada@example.com"]);
    respond([{ index: 0, email: "ada@example.com", status: "unchanged" }], true);

    await runMigrate(["csv", file, "--json"]);

    const printed = JSON.parse(String(logSpy.mock.calls.at(-1)![0]));
    expect(printed.summary).toMatchObject({ unchanged: 1 });
  });

  it("rejects an unknown source and a missing file argument", async () => {
    await expect(runMigrate(["okta"])).rejects.toThrow("process.exit(1)");
    await expect(runMigrate(["csv"])).rejects.toThrow("process.exit(1)");
  });

  it("explains a CSV with no data rows", async () => {
    const file = writeCsv(["email"]);

    await expect(runMigrate(["csv", file])).rejects.toThrow("process.exit(1)");

    expect(vi.mocked(console.error).mock.calls[0][0]).toMatch(/has no data rows/);
  });

  it("explains a CSV without an email column", async () => {
    const file = writeCsv(["name", "Ada"]);

    await expect(runMigrate(["csv", file])).rejects.toThrow("process.exit(1)");

    expect(vi.mocked(console.error).mock.calls[0][0]).toMatch(/No email column/);
  });
});

describe("seamless migrate entra-id", () => {
  const ENTRA_ENV = {
    ENTRA_TENANT_ID: "contoso.onmicrosoft.com",
    ENTRA_CLIENT_ID: "client",
    ENTRA_CLIENT_SECRET: "graph-s3cret",
  };
  const GROUP = "11111111-1111-1111-1111-111111111111";

  const directory = [
    { id: "oid-ada", mail: "ada@contoso.com", accountEnabled: true },
    { id: "oid-off", mail: "off@contoso.com", accountEnabled: false },
    { id: "oid-grace", mail: "grace@contoso.com", mobilePhone: "+1 425 555 0100", accountEnabled: true },
  ];

  // Microsoft sign-in, then Graph, answered by URL.
  function fakeMicrosoft(groupMembers: string[] = []) {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      const reply = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.startsWith("https://login.microsoftonline.com/")) {
        return reply({ access_token: "graph-token" });
      }
      if (url.includes(`/groups/${GROUP}/transitiveMembers`)) {
        return reply({ value: groupMembers.map((id) => directory.find((u) => u.id === id)) });
      }
      if (url.startsWith("https://graph.microsoft.com/v1.0/users")) {
        return reply({ value: directory });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    for (const [key, value] of Object.entries(ENTRA_ENV)) vi.stubEnv(key, value);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("dry-runs every enabled user with their object id, and lists the disabled one as skipped", async () => {
    fakeMicrosoft();
    respond(
      [
        { index: 0, email: "ada@contoso.com", externalId: "oid-ada", status: "created" },
        { index: 1, email: "grace@contoso.com", externalId: "oid-grace", status: "created" },
      ],
      true,
    );
    const base = path.join(dir, "plan");

    await runMigrate(["entra-id", "--report", base]);

    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body).toEqual({
      source: "entra-id",
      dryRun: true,
      users: [
        { externalId: "oid-ada", email: "ada@contoso.com" },
        { externalId: "oid-grace", email: "grace@contoso.com", phone: "+14255550100" },
      ],
    });

    const report = JSON.parse(fs.readFileSync(`${base}.json`, "utf-8"));
    expect(report.input).toBe("entra-id:contoso.onmicrosoft.com");
    expect(report.summary).toMatchObject({ created: 2, skipped: 1, invalid: 0 });
    expect(report.rows.find((r: { status: string }) => r.status === "skipped")).toMatchObject({
      externalId: "oid-off",
      detail: "disabled in Entra ID",
    });
    expect(output()).toMatch(/Dry run: nothing was written/);
  });

  it("reports a re-run as unchanged and exits 0 with only skipped rows", async () => {
    fakeMicrosoft();
    respond(
      [
        { index: 0, email: "ada@contoso.com", externalId: "oid-ada", status: "unchanged" },
        { index: 1, email: "grace@contoso.com", externalId: "oid-grace", status: "unchanged" },
      ],
      false,
    );

    await runMigrate(["entra-id", "--apply", "--json", "--report", path.join(dir, "result")]);

    expect(JSON.parse(request.mock.calls[0][1].body).dryRun).toBe(false);
    const printed = JSON.parse(String(logSpy.mock.calls.at(-1)![0]));
    expect(printed.summary).toMatchObject({ unchanged: 2, skipped: 1 });
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("imports one group's members with --group", async () => {
    const fetchMock = fakeMicrosoft(["oid-grace"]);
    respond([{ index: 0, email: "grace@contoso.com", status: "created" }], true);

    await runMigrate(["entra-id", "--group", GROUP, "--report", path.join(dir, "plan")]);

    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/v1.0/users?"))).toBe(false);
    expect(JSON.parse(request.mock.calls[0][1].body).users).toEqual([
      { externalId: "oid-grace", email: "grace@contoso.com", phone: "+14255550100" },
    ]);
  });

  it("maps groups to organizations and roles", async () => {
    fakeMicrosoft(["oid-ada"]);
    const groups = path.join(dir, "groups.json");
    fs.writeFileSync(
      groups,
      JSON.stringify({ groups: [{ id: GROUP, organization: "engineering", roles: ["staff"] }] }),
    );
    respond([], true);

    await runMigrate(["entra-id", "--groups", groups, "--report", path.join(dir, "plan")]);

    const [ada, grace] = JSON.parse(request.mock.calls[0][1].body).users;
    expect(ada).toMatchObject({ roles: ["staff"], organizations: [{ slug: "engineering" }] });
    expect(grace).not.toHaveProperty("organizations");
  });

  it("asks for the credentials before contacting anything", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("ENTRA_TENANT_ID", "");
    vi.stubEnv("ENTRA_CLIENT_ID", "");
    vi.stubEnv("ENTRA_CLIENT_SECRET", "");
    const fetchMock = fakeMicrosoft();

    await expect(runMigrate(["entra-id"])).rejects.toThrow("process.exit(1)");

    expect(vi.mocked(console.error).mock.calls[0][0]).toMatch(/ENTRA_TENANT_ID/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createAuthClient).not.toHaveBeenCalled();
  });

  it("refuses an invalid source and an empty group", async () => {
    fakeMicrosoft([]);

    await expect(runMigrate(["entra-id", "--source", "Entra ID"])).rejects.toThrow(
      "process.exit(1)",
    );
    expect(vi.mocked(console.error).mock.calls[0][0]).toMatch(/Invalid source/);

    await expect(runMigrate(["entra-id", "--group", GROUP])).rejects.toThrow("process.exit(1)");
    expect(vi.mocked(console.error).mock.calls[1][0]).toMatch(/has no users/);
    expect(createAuthClient).not.toHaveBeenCalled();
  });

  it("never writes the client secret to the report or the output", async () => {
    fakeMicrosoft();
    respond([], true);
    const base = path.join(dir, "plan");

    await runMigrate(["entra-id", "--report", base]);

    expect(fs.readFileSync(`${base}.json`, "utf-8")).not.toContain("graph-s3cret");
    expect(fs.readFileSync(`${base}.csv`, "utf-8")).not.toContain("graph-s3cret");
    expect(output()).not.toContain("graph-s3cret");
  });
});

const FIXTURES = path.join(import.meta.dirname, "..", "core", "fixtures", "migrate");
const fixture = (name: string) => path.join(FIXTURES, name);

describe("seamless migrate auth0", () => {
  it("dry-runs the export as source auth0, reports problem rows, and exits 1 for the invalid ones", async () => {
    const file = path.join(dir, "auth0-users.json");
    fs.copyFileSync(fixture("auth0-export.ndjson"), file);
    respond([], true);

    await expect(
      runMigrate(["auth0", file, "--map", fixture("auth0-map.json")]),
    ).rejects.toThrow("process.exit(1)");

    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body.source).toBe("auth0");
    expect(body.dryRun).toBe(true);
    expect(body.users.map((u: { externalId: string }) => u.externalId)).toEqual([
      "auth0|65f1a2b3c4d5e6f7a8b9c0d1",
      "google-oauth2|104857600123456789012",
      "sms|65f1a2b3c4d5e6f7a8b9c0d9",
      "samlp|acme|kai@acme.example",
      "auth0|65f1a2b3c4d5e6f7a8b9c0e4",
    ]);

    const report = JSON.parse(
      fs.readFileSync(path.join(dir, "auth0-users.migrate-plan.json"), "utf-8"),
    );
    expect(report.summary).toMatchObject({ invalid: 2, skipped: 2 });
    expect(output()).toMatch(/app_metadata\.roles/);
  });

  it("reads the gzip file Auth0 hands out, and imports unverified users with --allow-unverified", async () => {
    const file = path.join(dir, "export.json.gz");
    const lines = fs.readFileSync(fixture("auth0-export.ndjson"), "utf-8").split("\n");
    fs.writeFileSync(file, gzipSync(lines[5]));
    respond([{ index: 0, email: "unverified@example.com", status: "created" }], false);

    await runMigrate(["auth0", file, "--allow-unverified", "--apply", "--source", "auth0-eu"]);

    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
      source: "auth0-eu",
      dryRun: false,
      users: [{ email: "unverified@example.com" }],
    });
    expect(fs.existsSync(path.join(dir, "export.json.migrate-result.json"))).toBe(true);
  });

  it("refuses a missing file argument, an empty export and a mapping outside metadata", async () => {
    const empty = path.join(dir, "empty.ndjson");
    fs.writeFileSync(empty, "\n");
    const badMap = path.join(dir, "map.json");
    fs.writeFileSync(badMap, JSON.stringify({ columns: { roles: "email" } }));

    await expect(runMigrate(["auth0"])).rejects.toThrow("process.exit(1)");
    await expect(runMigrate(["auth0", empty])).rejects.toThrow("process.exit(1)");
    await expect(
      runMigrate(["auth0", fixture("auth0-export.ndjson"), "--map", badMap]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(errors[0]).toMatch(/Name the Auth0 export/);
    expect(errors[1]).toMatch(/is empty/);
    expect(errors[2]).toMatch(/app_metadata or user_metadata/);
    expect(createAuthClient).not.toHaveBeenCalled();
  });

  it("explains an export with no users", async () => {
    const file = path.join(dir, "none.json");
    fs.writeFileSync(file, "[]");

    await expect(runMigrate(["auth0", file])).rejects.toThrow("process.exit(1)");

    expect(vi.mocked(console.error).mock.calls[0][0]).toMatch(/has no users/);
  });
});

describe("seamless migrate cognito", () => {
  it("reads each chunk file in order, maps groups to roles, and writes the report in the current directory", async () => {
    const cwd = process.cwd();
    process.chdir(dir);
    respond([], true);
    try {
      await expect(
        runMigrate([
          "cognito",
          fixture("cognito-users-0.json"),
          fixture("cognito-users-1.json"),
          "--groups",
          fixture("cognito-groups.json"),
          "--map",
          fixture("cognito-map.json"),
        ]),
      ).rejects.toThrow("process.exit(1)");
    } finally {
      process.chdir(cwd);
    }

    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({
      source: "cognito",
      dryRun: true,
      users: [
        { email: "ada@example.com", externalId: "11111111-aaaa-4bbb-8ccc-000000000001", roles: ["staff"] },
        {
          email: "grace@example.com",
          externalId: "11111111-aaaa-4bbb-8ccc-000000000002",
          roles: ["staff", "manager"],
        },
        {
          email: "lin@example.com",
          externalId: "11111111-aaaa-4bbb-8ccc-000000000003",
          phone: "+15555550101",
          roles: ["staff"],
          organizations: [{ slug: "platform" }],
        },
      ],
    });
    const report = JSON.parse(fs.readFileSync(path.join(dir, "cognito.migrate-plan.json"), "utf-8"));
    expect(report.summary).toMatchObject({ invalid: 2, skipped: 3 });
    expect(output()).toMatch(/roles\s+<- groups/);
  });

  it("reads one concatenated file, writes the report beside it, and includes unconfirmed users when asked", async () => {
    const file = path.join(dir, "cognito-users.json");
    fs.writeFileSync(
      file,
      fs.readFileSync(fixture("cognito-users-0.json"), "utf-8") +
        fs.readFileSync(fixture("cognito-users-1.json"), "utf-8"),
    );
    respond([], true);

    await expect(
      runMigrate(["cognito", file, "--include-unconfirmed", "--allow-unverified", "--json"]),
    ).rejects.toThrow("process.exit(1)");

    const users = JSON.parse(request.mock.calls[0][1].body).users;
    expect(users.map((u: { email: string }) => u.email)).toEqual([
      "ada@example.com",
      "grace@example.com",
      "lin@example.com",
      "unconfirmed@example.com",
      "unverified@example.com",
      "kai@example.com",
    ]);
    expect(fs.existsSync(path.join(dir, "cognito-users.migrate-plan.json"))).toBe(true);
  });

  it("refuses a missing file argument and an export with no users", async () => {
    const file = path.join(dir, "empty.json");
    fs.writeFileSync(file, '{"Users": []}');

    await expect(runMigrate(["cognito"])).rejects.toThrow("process.exit(1)");
    await expect(runMigrate(["cognito", file])).rejects.toThrow("process.exit(1)");

    const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(errors[0]).toMatch(/Name the list-users output/);
    expect(errors[1]).toMatch(/has no users/);
  });
});

describe("seamless migrate assess", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let connectSpy: ReturnType<typeof vi.spyOn>;

  // Any network use at all fails the test: fetch, and every socket http, https or a
  // client library would open.
  beforeEach(() => {
    fetchMock = vi.fn(async (input: string | URL) => {
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    connectSpy = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("unexpected socket connect");
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    connectSpy.mockRestore();
  });

  function expectNoInstanceContact() {
    expect(createAuthClient).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  }

  it("assesses an Auth0 export without touching the network, and writes Markdown beside it", async () => {
    const file = path.join(dir, "auth0-users.json");
    fs.copyFileSync(fixture("auth0-export.ndjson"), file);

    await runMigrate(["assess", "auth0", file, "--map", fixture("auth0-map.json")]);

    expectNoInstanceContact();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    const report = fs.readFileSync(path.join(dir, "auth0-users.migrate-assess.md"), "utf-8");
    expect(report).toMatch(/^# Migration readiness: auth0/);
    expect(report).not.toMatch(/@example\.com/);
    expect(fs.readdirSync(dir).sort()).toEqual(["auth0-users.json", "auth0-users.migrate-assess.md"]);
    expect(output()).toMatch(/9 found.*4 would import.*5 would not/s);
    expect(output()).toContain("https://docs.seamlessauth.com/compare/cost?mau=9&vendor=auth0");
  });

  it("assesses Cognito chunk files and prints JSON with --json", async () => {
    const base = path.join(dir, "readiness");

    await runMigrate([
      "assess",
      "cognito",
      fixture("cognito-users-0.json"),
      fixture("cognito-users-1.json"),
      "--groups",
      fixture("cognito-groups.json"),
      "--report",
      base,
      "--json",
    ]);

    expectNoInstanceContact();
    expect(fetchMock).not.toHaveBeenCalled();
    const printed = JSON.parse(String(logSpy.mock.calls.at(-1)![0]));
    expect(printed).toMatchObject({
      source: "cognito",
      users: { found: 8, wouldImport: 3, notImported: 5 },
      costCalculator: "https://docs.seamlessauth.com/compare/cost?mau=8&vendor=cognito",
      report: `${base}.md`,
    });
    expect(JSON.stringify(printed)).not.toMatch(/@example\.com|11111111-aaaa/);
    expect(fs.existsSync(`${base}.md`)).toBe(true);
  });

  it("assesses a CSV", async () => {
    const file = writeCsv(["email,name", "ada@example.com,Ada", "nope,Bad"]);

    await runMigrate(["assess", "csv", file]);

    expectNoInstanceContact();
    expect(fetchMock).not.toHaveBeenCalled();
    const report = fs.readFileSync(path.join(dir, "users.migrate-assess.md"), "utf-8");
    expect(report).toContain("| Would import | 1 (50%) |");
    expect(report).toContain("| name | 2 |");
    expect(report).toContain("(https://docs.seamlessauth.com/compare/cost?mau=2)");
  });

  it("assesses Entra ID by reading Microsoft Graph only, never the instance", async () => {
    vi.stubEnv("ENTRA_TENANT_ID", "contoso.onmicrosoft.com");
    vi.stubEnv("ENTRA_CLIENT_ID", "client");
    vi.stubEnv("ENTRA_CLIENT_SECRET", "graph-s3cret");
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.startsWith("https://login.microsoftonline.com/")) return reply({ access_token: "t" });
      if (url.startsWith("https://graph.microsoft.com/v1.0/users")) {
        return reply({ value: [{ id: "oid-ada", mail: "ada@contoso.com", accountEnabled: true }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const base = path.join(dir, "entra");

    await runMigrate(["assess", "entra-id", "--report", base]);

    expectNoInstanceContact();
    expect(
      fetchMock.mock.calls.every(([u]) =>
        /^https:\/\/(login\.microsoftonline|graph\.microsoft)\.com\//.test(String(u)),
      ),
    ).toBe(true);
    const report = fs.readFileSync(`${base}.md`, "utf-8");
    expect(report).toContain("| Verified email | 1 (100%) |");
    expect(report).not.toContain("graph-s3cret");
  });

  it("refuses --apply, an unknown source and a missing file", async () => {
    await expect(runMigrate(["assess", "auth0", fixture("auth0-export.ndjson"), "--apply"])).rejects.toThrow(
      "process.exit(1)",
    );
    await expect(runMigrate(["assess", "okta"])).rejects.toThrow("process.exit(1)");
    await expect(runMigrate(["assess", "cognito"])).rejects.toThrow("process.exit(1)");

    const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(errors[0]).toMatch(/never writes to an instance/);
    expect(errors[1]).toMatch(/Unknown migrate source: okta[\s\S]*migrate assess/);
    expect(errors[2]).toMatch(/Name the list-users output/);
    expectNoInstanceContact();
  });
});
