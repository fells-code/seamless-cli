import fs from "fs";
import { gunzipSync } from "zlib";
import {
  ImportUsersResponseSchema,
  USER_IMPORT_MAX_ROWS,
  UserImportRowSchema,
  UserImportSourceSchema,
  type ImportUsersResponse,
  type UserImportResult,
  type UserImportRow,
} from "@seamless-auth/types";
import { AdminApiError } from "./admin.js";
import type { AuthClient } from "./authClient.js";
import type { CsvRecord } from "./csv.js";
import { toCsv } from "./csv.js";
import { errorMessage } from "./errors.js";
import type { ApiResponse } from "./http.js";
import { forbidden } from "./stepUp.js";

export type MappedField =
  | "externalId"
  | "email"
  | "phone"
  | "roles"
  | "organizations";

const FIELDS: MappedField[] = [
  "externalId",
  "email",
  "phone",
  "roles",
  "organizations",
];

// Header spellings recognised without a mapping file, compared case-insensitively
// with spaces, underscores and hyphens removed.
const DEFAULT_HEADERS: Record<MappedField, string[]> = {
  externalId: ["externalid", "id", "employeeid", "userid"],
  email: ["email", "emailaddress", "workemail", "mail"],
  phone: ["phone", "phonenumber", "mobile", "mobilephone"],
  roles: ["roles", "role"],
  organizations: ["organizations", "organization", "department", "departments"],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How a source's columns become import rows. Kept as a file beside the export so a
 * migration can be re-run with the same mapping after the source data is corrected.
 */
export interface MigrationMapping {
  source: string;
  columns: Partial<Record<MappedField, string>>;
  /** Splits multi-value cells (roles, organizations). Defaults to ";". */
  separator: string;
  /** Roles added to every row. */
  roles: string[];
  /** Membership roles for each organization a row names. The server defaults to member. */
  organizationRoles: string[];
}

function normalizeHeader(header: string) {
  return header.toLowerCase().replace(/[\s_-]/g, "");
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`Mapping field "${field}" must be a list of strings.`);
  }
  return value as string[];
}

export function loadMapping(
  path: string | undefined,
  overrides: {
    source?: string;
    /** The source when neither the flag nor the file names one. */
    defaultSource?: string;
    /** The fields this source lets a mapping set. */
    fields?: MappedField[];
  } = {},
): MigrationMapping {
  const allowed = overrides.fields ?? FIELDS;
  let raw: Record<string, unknown> = {};
  if (path) {
    try {
      raw = JSON.parse(fs.readFileSync(path, "utf-8"));
    } catch (err) {
      throw new Error(`Could not read the mapping file ${path}: ${(err as Error).message}`);
    }
  }

  const columns = (raw.columns ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(columns)) {
    if (!allowed.includes(key as MappedField)) {
      throw new Error(
        `Unknown mapping column "${key}". Expected one of: ${allowed.join(", ")}.`,
      );
    }
    if (typeof value !== "string" || !value) {
      throw new Error(
        `Mapping column "${key}" must name a ${overrides.fields ? "field" : "CSV header"}.`,
      );
    }
  }

  const source =
    overrides.source ??
    (raw.source as string | undefined) ??
    overrides.defaultSource ??
    "csv";
  const parsedSource = UserImportSourceSchema.safeParse(source);
  if (!parsedSource.success) {
    throw new Error(
      `Invalid source "${source}": use lowercase letters, digits and hyphens.`,
    );
  }

  return {
    source: parsedSource.data,
    columns: columns as Partial<Record<MappedField, string>>,
    separator: typeof raw.separator === "string" && raw.separator ? raw.separator : ";",
    roles: stringList(raw.roles, "roles"),
    organizationRoles: stringList(raw.organizationRoles, "organizationRoles"),
  };
}

/**
 * Which CSV header feeds each field: the mapping's choice where it has one, otherwise
 * the first header that matches a recognised spelling. Fails when there is no email
 * column or when the mapping names a header the file does not have.
 */
export function resolveColumns(
  headers: string[],
  mapping: MigrationMapping,
): Partial<Record<MappedField, string>> {
  const resolved: Partial<Record<MappedField, string>> = {};

  for (const field of FIELDS) {
    const chosen = mapping.columns[field];
    if (chosen) {
      if (!headers.includes(chosen)) {
        throw new Error(
          `The mapping sends "${chosen}" to ${field}, but the CSV has no such column.`,
        );
      }
      resolved[field] = chosen;
      continue;
    }
    const match = headers.find((h) =>
      DEFAULT_HEADERS[field].includes(normalizeHeader(h)),
    );
    if (match) resolved[field] = match;
  }

  if (!resolved.email) {
    throw new Error(
      `No email column found. Name one in the mapping file ("columns": { "email": "<header>" }).`,
    );
  }

  return resolved;
}

export interface PreparedRow {
  row: number;
  user: UserImportRow;
}

export interface InvalidRow {
  row: number;
  email: string;
  externalId?: string;
  detail: string;
}

function split(value: string | undefined, separator: string): string[] {
  if (!value) return [];
  return value
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * A vendor export as text. Vendors hand these out gzip-compressed (Auth0's export job
 * does), so a compressed file is read as it was downloaded.
 */
export function readExportFile(path: string): string {
  let data: Buffer;
  try {
    data = fs.readFileSync(path);
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try {
      data = gunzipSync(data);
    } catch {
      throw new Error(`${path} looks gzip-compressed but could not be decompressed.`);
    }
  }
  const text = data.toString("utf-8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The value at a dotted path such as "app_metadata.roles". */
export function valueAt(record: unknown, path: string): unknown {
  let value = record;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function organizationRefs(
  refs: string[],
  mapping: MigrationMapping,
): NonNullable<UserImportRow["organizations"]> {
  return refs.map((ref) => ({
    ...(UUID.test(ref) ? { organizationId: ref } : { slug: ref }),
    ...(mapping.organizationRoles.length ? { roles: mapping.organizationRoles } : {}),
  }));
}

/** A value read from a vendor export as a list: arrays as given, strings split. */
export function valueList(value: unknown, separator: string): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
      .map((v) => String(v).trim())
      .filter(Boolean);
  }
  if (typeof value === "string" || typeof value === "number") {
    return split(String(value), separator);
  }
  return [];
}

/** The import row a source built, or why the server would refuse it. */
export function checkRow(
  row: number,
  candidate: {
    email: string;
    externalId?: string;
    phone?: string;
    roles?: string[];
    organizations?: UserImportRow["organizations"];
  },
): { prepared: PreparedRow } | { invalid: InvalidRow } {
  const { email, externalId } = candidate;
  const parsed = UserImportRowSchema.safeParse({
    email,
    ...(externalId ? { externalId } : {}),
    ...(candidate.phone ? { phone: candidate.phone } : {}),
    ...(candidate.roles?.length ? { roles: candidate.roles } : {}),
    ...(candidate.organizations?.length ? { organizations: candidate.organizations } : {}),
  });
  if (parsed.success) return { prepared: { row, user: parsed.data } };
  const issue = parsed.error.issues[0];
  return {
    invalid: {
      row,
      email,
      ...(externalId ? { externalId } : {}),
      detail: `${issue.path.join(".") || "row"}: ${issue.message}`,
    },
  };
}

export function prepareRows(
  records: CsvRecord[],
  columns: Partial<Record<MappedField, string>>,
  mapping: MigrationMapping,
): { prepared: PreparedRow[]; invalid: InvalidRow[] } {
  const prepared: PreparedRow[] = [];
  const invalid: InvalidRow[] = [];
  const cell = (record: CsvRecord, field: MappedField) =>
    columns[field] ? record.values[columns[field]!] : undefined;

  for (const record of records) {
    const checked = checkRow(record.row, {
      email: cell(record, "email") ?? "",
      externalId: cell(record, "externalId") || undefined,
      phone: cell(record, "phone") || undefined,
      roles: Array.from(
        new Set([...mapping.roles, ...split(cell(record, "roles"), mapping.separator)]),
      ),
      organizations: organizationRefs(
        split(cell(record, "organizations"), mapping.separator),
        mapping,
      ),
    });
    if ("prepared" in checked) prepared.push(checked.prepared);
    else invalid.push(checked.invalid);
  }

  return { prepared, invalid };
}

export interface MigrationOutcome {
  row: number;
  result: UserImportResult;
}

/** A batch failed after earlier batches were applied. Carries what did complete. */
export class ImportBatchError extends AdminApiError {
  constructor(
    message: string,
    readonly outcomes: MigrationOutcome[],
  ) {
    super(message);
    this.name = "ImportBatchError";
  }
}

/**
 * Sends the prepared rows in batches the server accepts. Results come back indexed
 * within each batch, so they are mapped back onto the CSV row each one came from.
 */
export async function runImport(
  client: AuthClient,
  source: string,
  rows: PreparedRow[],
  dryRun: boolean,
  onBatch?: (done: number, total: number) => void,
): Promise<MigrationOutcome[]> {
  const outcomes: MigrationOutcome[] = [];

  for (let start = 0; start < rows.length; start += USER_IMPORT_MAX_ROWS) {
    const batch = rows.slice(start, start + USER_IMPORT_MAX_ROWS);
    // A step-up can lapse between batches, and one that fails part way through
    // must still leave a report of the rows that were applied.
    const stopped = (err: unknown): unknown =>
      outcomes.length === 0
        ? err
        : new ImportBatchError(
            `${errorMessage(err)} Stopped after ${outcomes.length} of ${rows.length} rows.`,
            outcomes,
          );

    let res: ApiResponse<ImportUsersResponse>;
    try {
      res = await client.request<ImportUsersResponse>("/admin/users/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, dryRun, users: batch.map((r) => r.user) }),
      });
    } catch (err) {
      throw stopped(err);
    }

    if (res.status === 403) throw stopped(forbidden(res));
    if (res.status === 404 && outcomes.length === 0) {
      throw new AdminApiError(
        "This instance does not support user import. Upgrade the auth server to a release with POST /admin/users/import.",
      );
    }
    if (!res.ok) {
      throw new ImportBatchError(
        `The import request failed (${res.status}) after ${outcomes.length} of ${rows.length} rows.`,
        outcomes,
      );
    }

    const parsed = ImportUsersResponseSchema.safeParse(res.data);
    if (!parsed.success) {
      throw new ImportBatchError(
        "The instance returned an import response this CLI cannot read.",
        outcomes,
      );
    }

    for (const result of parsed.data.results) {
      outcomes.push({ row: batch[result.index].row, result });
    }
    onBatch?.(Math.min(start + batch.length, rows.length), rows.length);
  }

  return outcomes;
}

export interface ReportRow {
  row: number;
  email: string;
  externalId?: string;
  // "skipped" rows are left out on purpose (a disabled directory account), so unlike
  // "invalid" they do not fail the run.
  status: UserImportResult["status"] | "invalid" | "skipped";
  userId?: string;
  changes?: string[];
  reason?: string;
  detail?: string;
}

export function buildReport(
  outcomes: MigrationOutcome[],
  invalid: InvalidRow[],
  skipped: InvalidRow[] = [],
): ReportRow[] {
  const rows: ReportRow[] = [
    ...outcomes.map(({ row, result }) => ({
      row,
      email: result.email,
      ...(result.externalId ? { externalId: result.externalId } : {}),
      status: result.status,
      ...(result.userId ? { userId: result.userId } : {}),
      ...(result.changes ? { changes: result.changes } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    })),
    ...invalid.map((r) => ({
      row: r.row,
      email: r.email,
      ...(r.externalId ? { externalId: r.externalId } : {}),
      status: "invalid" as const,
      detail: r.detail,
    })),
    ...skipped.map((r) => ({
      row: r.row,
      email: r.email,
      ...(r.externalId ? { externalId: r.externalId } : {}),
      status: "skipped" as const,
      detail: r.detail,
    })),
  ];
  return rows.sort((a, b) => a.row - b.row);
}

export function summarize(report: ReportRow[]) {
  const summary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    rejected: 0,
    invalid: 0,
    skipped: 0,
  };
  for (const row of report) summary[row.status] += 1;
  return summary;
}

// A cell starting with one of these is evaluated as a formula when the report is
// opened in a spreadsheet, and the values come from whatever system exported them.
function neutralizeFormula(value: string | undefined) {
  return value && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function writeReport(
  basePath: string,
  meta: { source: string; dryRun: boolean; input: string },
  report: ReportRow[],
): { json: string; csv: string } {
  const json = `${basePath}.json`;
  const csv = `${basePath}.csv`;

  fs.writeFileSync(
    json,
    JSON.stringify(
      {
        ...meta,
        generatedAt: new Date().toISOString(),
        summary: summarize(report),
        rows: report,
      },
      null,
      2,
    ) + "\n",
  );

  fs.writeFileSync(
    csv,
    toCsv([
      ["row", "email", "externalId", "status", "userId", "changes", "reason", "detail"],
      ...report.map((r) => [
        r.row,
        neutralizeFormula(r.email),
        neutralizeFormula(r.externalId),
        r.status,
        r.userId,
        r.changes?.join(";"),
        r.reason,
        neutralizeFormula(r.detail),
      ]),
    ]),
  );

  return { json, csv };
}
