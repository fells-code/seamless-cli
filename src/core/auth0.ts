import type { MappedField, MigrationMapping, InvalidRow, PreparedRow } from "./migrate.js";
import { checkRow, organizationRefs, valueAt, valueList } from "./migrate.js";

/** What an Auth0 mapping file may set. Identity fields always come from the export. */
export const AUTH0_MAPPED_FIELDS: MappedField[] = ["roles", "organizations"];
const METADATA_PATH = /^(app_metadata|user_metadata)\.[^.]+(\.[^.]+)*$/;

export interface Auth0User {
  /** Line of the export the user came from. */
  line: number;
  user_id?: string;
  email?: string | null;
  email_verified?: boolean | null;
  phone_number?: string | null;
  blocked?: boolean | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
}

/**
 * The NDJSON an Auth0 user export job produces, one user per line. A JSON array of
 * users is read too, since that is what a Management API `GET /users` loop writes.
 */
export function parseAuth0Export(text: string, file: string): Auth0User[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${file} is empty.`);

  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
    }
    return (parsed as unknown[]).map((value, i) => auth0User(value, i + 1, file, "item"));
  }

  const users: Auth0User[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(
        `${file} line ${i + 1} is not JSON. Request the export with "format": "json", which writes one user per line.`,
      );
    }
    users.push(auth0User(value, i + 1, file, "line"));
  });
  return users;
}

function auth0User(value: unknown, line: number, file: string, unit: string): Auth0User {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file} ${unit} ${line} is not an Auth0 user object.`);
  }
  return { ...(value as Omit<Auth0User, "line">), line };
}

export function assertAuth0Mapping(mapping: MigrationMapping): void {
  for (const [field, path] of Object.entries(mapping.columns)) {
    if (!METADATA_PATH.test(path!)) {
      throw new Error(
        `The mapping sends "${path}" to ${field}. Auth0 fields are read from app_metadata or user_metadata, for example "app_metadata.${field}".`,
      );
    }
  }
}

export interface Auth0RowOptions {
  /** Import users whose export says email_verified: false. */
  allowUnverified: boolean;
}

/**
 * Auth0 users as import rows, numbered by their line in the export. Matches the
 * conversion in the Auth0 migration guide: user_id is the external id, blocked users
 * and users with no email are left out, and roles and organizations come only from
 * the metadata paths the mapping names.
 */
export function auth0ImportRows(
  users: Auth0User[],
  mapping: MigrationMapping,
  opts: Auth0RowOptions,
): { prepared: PreparedRow[]; invalid: InvalidRow[]; skipped: InvalidRow[] } {
  const prepared: PreparedRow[] = [];
  const invalid: InvalidRow[] = [];
  const skipped: InvalidRow[] = [];

  for (const user of users) {
    const row = user.line;
    const email = typeof user.email === "string" ? user.email.trim() : "";
    const externalId = typeof user.user_id === "string" ? user.user_id.trim() : "";
    const ref = { row, email, ...(externalId ? { externalId } : {}) };

    if (user.blocked === true) {
      skipped.push({ ...ref, detail: "blocked in Auth0" });
      continue;
    }
    if (!email) {
      invalid.push({
        ...ref,
        detail: user.phone_number
          ? "no email address (a phone-only user; add an email in Auth0 before exporting)"
          : "no email address",
      });
      continue;
    }
    if (!externalId) {
      invalid.push({ ...ref, detail: "no user_id (include it in the export fields)" });
      continue;
    }
    if (user.email_verified === false && !opts.allowUnverified) {
      skipped.push({
        ...ref,
        detail: "email not verified in Auth0 (pass --allow-unverified to import it)",
      });
      continue;
    }

    const field = (name: MappedField) =>
      mapping.columns[name] ? valueAt(user, mapping.columns[name]!) : undefined;
    const phone = typeof user.phone_number === "string" ? user.phone_number.trim() : "";
    const checked = checkRow(row, {
      email,
      externalId,
      ...(phone ? { phone } : {}),
      roles: Array.from(
        new Set([...mapping.roles, ...valueList(field("roles"), mapping.separator)]),
      ),
      organizations: organizationRefs(
        valueList(field("organizations"), mapping.separator),
        mapping,
      ),
    });
    if ("prepared" in checked) prepared.push(checked.prepared);
    else invalid.push(checked.invalid);
  }

  return { prepared, invalid, skipped };
}
