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

  it("explains a CSV without an email column", async () => {
    const file = writeCsv(["name", "Ada"]);

    await expect(runMigrate(["csv", file])).rejects.toThrow("process.exit(1)");

    expect(vi.mocked(console.error).mock.calls[0][0]).toMatch(/No email column/);
  });
});
