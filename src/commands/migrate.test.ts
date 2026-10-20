import fs from "fs";
import os from "os";
import path from "path";
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
