import fs from "fs";
import {
  ImportUsersResponseSchema,
  USER_IMPORT_MAX_ROWS,
  UserImportRowSchema,
  UserImportSourceSchema,
  type ImportUsersResponse,
  type UserImportResult,
  type UserImportRow,
} from "@seamless-auth/types";
import { AdminApiError, PermissionError } from "./admin.js";
import type { AuthClient } from "./authClient.js";
import type { CsvRecord } from "./csv.js";
import { toCsv } from "./csv.js";

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
  overrides: { source?: string } = {},
): MigrationMapping {
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
    if (!FIELDS.includes(key as MappedField)) {
      throw new Error(
        `Unknown mapping column "${key}". Expected one of: ${FIELDS.join(", ")}.`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(`Mapping column "${key}" must name a CSV header.`);
    }
  }

  const source = overrides.source ?? (raw.source as string | undefined) ?? "csv";
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
    const email = cell(record, "email") ?? "";
    const externalId = cell(record, "externalId") || undefined;
    const phone = cell(record, "phone") || undefined;
    const roles = Array.from(
      new Set([...mapping.roles, ...split(cell(record, "roles"), mapping.separator)]),
    );
    const organizations = split(cell(record, "organizations"), mapping.separator).map(
      (ref) => ({
        ...(UUID.test(ref) ? { organizationId: ref } : { slug: ref }),
        ...(mapping.organizationRoles.length ? { roles: mapping.organizationRoles } : {}),
      }),
    );

    const candidate = {
      email,
      ...(externalId ? { externalId } : {}),
      ...(phone ? { phone } : {}),
      ...(roles.length ? { roles } : {}),
      ...(organizations.length ? { organizations } : {}),
    };

    const parsed = UserImportRowSchema.safeParse(candidate);
    if (parsed.success) {
      prepared.push({ row: record.row, user: parsed.data });
    } else {
      const issue = parsed.error.issues[0];
      invalid.push({
        row: record.row,
        email,
        ...(externalId ? { externalId } : {}),
        detail: `${issue.path.join(".") || "row"}: ${issue.message}`,
      });
    }
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
    const res = await client.request<ImportUsersResponse>("/admin/users/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, dryRun, users: batch.map((r) => r.user) }),
    });

    if (res.status === 403) throw new PermissionError();
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
  status: UserImportResult["status"] | "invalid";
  userId?: string;
  changes?: string[];
  reason?: string;
  detail?: string;
}

export function buildReport(
  outcomes: MigrationOutcome[],
  invalid: InvalidRow[],
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
  ];
  return rows.sort((a, b) => a.row - b.row);
}

export function summarize(report: ReportRow[]) {
  const summary = { created: 0, updated: 0, unchanged: 0, rejected: 0, invalid: 0 };
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
