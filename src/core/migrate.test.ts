import fs from "fs";
import os from "os";
import path from "path";
import { gzipSync } from "zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthClient } from "./authClient.js";
import { parseCsvRecords } from "./csv.js";
import {
  buildReport,
  ImportBatchError,
  loadMapping,
  prepareRows,
  readExportFile,
  resolveColumns,
  runImport,
  summarize,
  valueAt,
  valueList,
  writeReport,
  type PreparedRow,
} from "./migrate.js";
import { PermissionError } from "./permissionError.js";
import { STEP_UP_REQUIRED_MESSAGE, StepUpError } from "./stepUp.js";

const tmp: string[] = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-migrate-"));
  tmp.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const defaults = () => loadMapping(undefined);

describe("loadMapping", () => {
  it("defaults the source, separator and lists", () => {
    expect(defaults()).toEqual({
      source: "csv",
      columns: {},
      separator: ";",
      roles: [],
      organizationRoles: [],
    });
  });

  it("reads a mapping file and lets --source override it", () => {
    const file = path.join(tmpDir(), "map.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ source: "hr", columns: { email: "Work Email" }, roles: ["staff"] }),
    );
    expect(loadMapping(file)).toMatchObject({
      source: "hr",
      columns: { email: "Work Email" },
      roles: ["staff"],
    });
    expect(loadMapping(file, { source: "entra-id" }).source).toBe("entra-id");
  });

  it("refuses an unknown column, a bad source and unreadable JSON", () => {
    const dir = tmpDir();
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ columns: { password: "Password" } }));
    expect(() => loadMapping(bad)).toThrow(/Unknown mapping column "password"/);
    expect(() => loadMapping(undefined, { source: "HR Export" })).toThrow(/Invalid source/);
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{");
    expect(() => loadMapping(broken)).toThrow(/Could not read the mapping file/);
  });
});

describe("resolveColumns", () => {
  it("recognises common header spellings", () => {
    expect(
      resolveColumns(["Employee ID", "Work Email", "Mobile", "Department"], defaults()),
    ).toEqual({
      externalId: "Employee ID",
      email: "Work Email",
      phone: "Mobile",
      organizations: "Department",
    });
  });

  it("prefers the mapping and checks the header exists", () => {
    const mapping = { ...defaults(), columns: { email: "Primary" } };
    expect(resolveColumns(["email", "Primary"], mapping).email).toBe("Primary");
    expect(() =>
      resolveColumns(["email"], { ...defaults(), columns: { email: "Primary" } }),
    ).toThrow(/no such column/);
  });

  it("requires an email column", () => {
    expect(() => resolveColumns(["name"], defaults())).toThrow(/No email column/);
  });
});

describe("prepareRows", () => {
  const csv = [
    "id,email,phone,roles,department",
    "e1,ada@example.com,+14155552671,clerk;viewer,parks;2c0d53c2-a541-452b-b71b-54c7f15e5877",
    "e2,not-an-email,,,",
    "e3,grace@example.com,,,",
  ].join("\n");

  it("builds import rows and reports invalid ones with their row", () => {
    const { headers, records } = parseCsvRecords(csv);
    const mapping = { ...defaults(), roles: ["staff"], organizationRoles: ["member"] };
    const { prepared, invalid } = prepareRows(
      records,
      resolveColumns(headers, mapping),
      mapping,
    );

    expect(prepared[0]).toEqual({
      row: 2,
      user: {
        externalId: "e1",
        email: "ada@example.com",
        phone: "+14155552671",
        roles: ["staff", "clerk", "viewer"],
        organizations: [
          { slug: "parks", roles: ["member"] },
          { organizationId: "2c0d53c2-a541-452b-b71b-54c7f15e5877", roles: ["member"] },
        ],
      },
    });
    expect(prepared[1]).toEqual({
      row: 4,
      user: { externalId: "e3", email: "grace@example.com", roles: ["staff"] },
    });
    expect(invalid).toEqual([
      { row: 3, email: "not-an-email", externalId: "e2", detail: expect.stringMatching(/^email:/) },
    ]);
  });
});

function client(responses: { ok: boolean; status: number; data: unknown }[]) {
  const request = vi.fn();
  for (const r of responses) request.mockResolvedValueOnce({ ...r, headers: new Headers() });
  return {
    profile: { name: "default", instanceUrl: "https://auth.example.com" },
    get: vi.fn(),
    post: vi.fn(),
    request,
  } as unknown as AuthClient & { request: ReturnType<typeof vi.fn> };
}

const rowsOf = (n: number): PreparedRow[] =>
  Array.from({ length: n }, (_, i) => ({ row: i + 2, user: { email: `u${i}@example.com` } }));

const okBatch = (count: number) => ({
  ok: true,
  status: 200,
  data: {
    source: "csv",
    dryRun: true,
    summary: { created: count, updated: 0, unchanged: 0, rejected: 0 },
    results: Array.from({ length: count }, (_, index) => ({
      index,
      email: `x${index}@example.com`,
      status: "created",
    })),
  },
});

describe("runImport", () => {
  it("sends batches of 200 and maps results back to CSV rows", async () => {
    const c = client([okBatch(200), okBatch(50)]);
    const outcomes = await runImport(c, "csv", rowsOf(250), true);

    expect(c.request).toHaveBeenCalledTimes(2);
    const [, init] = c.request.mock.calls[1];
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ source: "csv", dryRun: true });
    expect(body.users).toHaveLength(50);
    expect(outcomes).toHaveLength(250);
    expect(outcomes[200].row).toBe(202);
  });

  it("explains an instance without the import route", async () => {
    const c = client([{ ok: false, status: 404, data: null }]);
    await expect(runImport(c, "csv", rowsOf(1), true)).rejects.toThrow(/does not support user import/);
  });

  it("keeps the outcomes of batches that finished before one failed", async () => {
    const c = client([okBatch(200), { ok: false, status: 500, data: null }]);
    const err = await runImport(c, "csv", rowsOf(250), false).catch((e) => e);

    expect(err).toBeInstanceOf(ImportBatchError);
    expect(err.outcomes).toHaveLength(200);
    expect(err.message).toMatch(/after 200 of 250 rows/);
  });

  const stepUpRequired = {
    ok: false,
    status: 403,
    data: { error: "step_up_required", fresh: false, maxAgeSeconds: 300 },
  };

  it("reports a missing step-up on the first batch as a StepUpError", async () => {
    const c = client([stepUpRequired]);
    const err = await runImport(c, "csv", rowsOf(10), true).catch((e) => e);

    expect(err).toBeInstanceOf(StepUpError);
    expect(err.message).toBe(STEP_UP_REQUIRED_MESSAGE);
  });

  it("keeps earlier batches when a later one still lacks a step-up", async () => {
    const c = client([okBatch(200), stepUpRequired]);
    const err = await runImport(c, "csv", rowsOf(250), false).catch((e) => e);

    expect(err).toBeInstanceOf(ImportBatchError);
    expect(err.outcomes).toHaveLength(200);
    expect(err.message).toBe(
      `${STEP_UP_REQUIRED_MESSAGE} Stopped after 200 of 250 rows.`,
    );
  });

  it("keeps earlier batches when the step-up for a later one fails", async () => {
    const c = client([okBatch(200)]);
    c.request.mockRejectedValueOnce(new StepUpError("Too many code attempts."));
    const err = await runImport(c, "csv", rowsOf(250), false).catch((e) => e);

    expect(err).toBeInstanceOf(ImportBatchError);
    expect(err.outcomes).toHaveLength(200);
    expect(err.message).toBe("Too many code attempts. Stopped after 200 of 250 rows.");
  });

  it("passes a failure on the first batch through unchanged", async () => {
    const c = client([]);
    const cause = new StepUpError("Too many code attempts.");
    c.request.mockRejectedValueOnce(cause);

    await expect(runImport(c, "csv", rowsOf(10), false)).rejects.toBe(cause);
  });

  it("maps a missing admin role to a PermissionError", async () => {
    const c = client([{ ok: false, status: 403, data: { error: "Forbidden" } }]);
    const err = await runImport(c, "csv", rowsOf(10), false).catch((e) => e);

    expect(err).toBeInstanceOf(PermissionError);
    expect(err).not.toBeInstanceOf(StepUpError);
  });
});

describe("reports", () => {
  it("merges results and invalid rows in row order and writes both files", () => {
    const report = buildReport(
      [
        { row: 4, result: { index: 1, email: "b@example.com", status: "rejected", reason: "phone_in_use" } },
        { row: 2, result: { index: 0, email: "=cmd@example.com", status: "created", changes: ["created"] } },
      ],
      [{ row: 3, email: "bad", detail: "email: Invalid email" }],
    );
    expect(report.map((r) => r.status)).toEqual(["created", "invalid", "rejected"]);
    expect(summarize(report)).toEqual({
      created: 1,
      updated: 0,
      unchanged: 0,
      rejected: 1,
      invalid: 1,
      skipped: 0,
    });

    const base = path.join(tmpDir(), "users.migrate-plan");
    const written = writeReport(base, { source: "csv", dryRun: true, input: "users.csv" }, report);

    const csv = fs.readFileSync(written.csv, "utf-8");
    expect(csv.split("\n")[0]).toBe("row,email,externalId,status,userId,changes,reason,detail");
    expect(csv).toContain("2,'=cmd@example.com,,created,,created,,");
    const json = JSON.parse(fs.readFileSync(written.json, "utf-8"));
    expect(json).toMatchObject({ source: "csv", dryRun: true, summary: { invalid: 1 } });
    expect(json.rows).toHaveLength(3);
  });
});

describe("vendor export helpers", () => {
  it("reads an export as downloaded, gzip-compressed or not, without a BOM", () => {
    const dir = tmpDir();
    const plain = path.join(dir, "users.json");
    const zipped = path.join(dir, "users.json.gz");
    fs.writeFileSync(plain, "\ufeff{}");
    fs.writeFileSync(zipped, gzipSync("{}"));

    expect(readExportFile(plain)).toBe("{}");
    expect(readExportFile(zipped)).toBe("{}");
  });

  it("explains a missing file and a damaged gzip file", () => {
    const dir = tmpDir();
    const broken = path.join(dir, "broken.gz");
    fs.writeFileSync(broken, Buffer.from([0x1f, 0x8b, 0, 1, 2]));

    expect(() => readExportFile(path.join(dir, "nope.json"))).toThrow(/Could not read/);
    expect(() => readExportFile(broken)).toThrow(/could not be decompressed/);
  });

  it("reads dotted paths and turns values into lists", () => {
    const user = { app_metadata: { roles: ["staff", 7, null, " "], org: "eng" } };
    expect(valueAt(user, "app_metadata.org")).toBe("eng");
    expect(valueAt(user, "app_metadata.org.deeper")).toBeUndefined();
    expect(valueAt(user, "user_metadata.org")).toBeUndefined();
    expect(valueList(valueAt(user, "app_metadata.roles"), ";")).toEqual(["staff", "7"]);
    expect(valueList("a; b", ";")).toEqual(["a", "b"]);
    expect(valueList({ nested: true }, ";")).toEqual([]);
  });

  it("limits a source's mapping fields and defaults its source name", () => {
    const dir = tmpDir();
    const file = path.join(dir, "map.json");
    fs.writeFileSync(file, JSON.stringify({ columns: { email: "x" } }));
    const opts = { defaultSource: "auth0", fields: ["roles" as const] };

    expect(loadMapping(undefined, opts).source).toBe("auth0");
    expect(() => loadMapping(file, opts)).toThrow(/Expected one of: roles\./);
    fs.writeFileSync(file, JSON.stringify({ columns: { roles: "" } }));
    expect(() => loadMapping(file, opts)).toThrow(/must name a field/);
  });
});
