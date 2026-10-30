import fs from "fs";
import type { InvalidRow, MappedField, MigrationMapping, PreparedRow } from "./migrate.js";
import { checkRow, organizationRefs, valueList } from "./migrate.js";

/** What a Cognito mapping file may set: attribute names such as "custom:tenant". */
export const COGNITO_MAPPED_FIELDS: MappedField[] = ["roles", "organizations"];

// Cognito creates a group per federated identity provider, named
// "<user pool id>_<provider name>". It records how a user signed in, not a role.
const PROVIDER_GROUP = /^[a-z]{2}(-[a-z]+)+-\d+_[A-Za-z0-9]+_/;

export interface CognitoAttribute {
  Name: string;
  Value?: string;
}

export interface CognitoUser {
  Username?: string;
  Attributes?: CognitoAttribute[];
  Enabled?: boolean;
  UserStatus?: string;
}

/**
 * Every top-level JSON value in the text. Concatenated `list-users` pages
 * (`cat users-*.json`) are several objects back to back, which JSON.parse refuses.
 */
export function parseJsonValues(text: string, file: string): unknown[] {
  try {
    return [JSON.parse(text)];
  } catch {
    // Not a single value; scan for several below.
  }
  const values: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        values.push(parseValue(text.slice(start, i + 1), file));
      } else if (depth < 0) {
        throw new Error(`${file} is not valid JSON: unexpected "${ch}".`);
      }
    } else if (depth === 0 && !/\s/.test(ch)) {
      throw new Error(`${file} is not valid JSON: unexpected "${ch}" outside an object.`);
    }
  }
  if (depth !== 0 || inString) throw new Error(`${file} is not valid JSON: it ends early.`);
  return values;
}

function parseValue(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

function isPage(value: unknown): value is { Users: unknown[] } {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { Users?: unknown }).Users)
  );
}

function isUser(value: unknown): value is CognitoUser {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Array.isArray((value as CognitoUser).Attributes) ||
      typeof (value as CognitoUser).Username === "string")
  );
}

/**
 * Users from `aws cognito-idp list-users` output in any of the shapes the Cognito
 * migration guide produces: one response (`{"Users": [...]}`), the users array
 * (`jq '.Users'`, or the chunked loop's `jq -s '[.[].Users[]]'`), an array of
 * responses (`jq -s .`), or responses concatenated (`cat users-*.json`).
 */
export function parseCognitoExport(text: string, file: string): CognitoUser[] {
  const values = parseJsonValues(text, file);
  if (values.length === 0) throw new Error(`${file} is empty.`);

  const users: CognitoUser[] = [];
  const take = (value: unknown) => {
    if (isPage(value)) {
      for (const user of value.Users) take(user);
    } else if (isUser(value)) {
      users.push(value);
    } else {
      throw new Error(
        `${file} is not aws cognito-idp list-users output: expected users with "Attributes", or pages with "Users".`,
      );
    }
  };
  for (const value of values) {
    if (Array.isArray(value)) value.forEach(take);
    else take(value);
  }
  return users;
}

/** The username-to-groups map the guide's list-users-in-group loop writes. */
export function loadCognitoGroups(path: string): Map<string, string[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`Could not read the groups file ${path}: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `The groups file ${path} must map each username to its groups, for example {"ada": ["staff"]}.`,
    );
  }

  const groups = new Map<string, string[]>();
  for (const [username, list] of Object.entries(raw)) {
    if (!Array.isArray(list) || list.some((g) => typeof g !== "string")) {
      throw new Error(`The groups file ${path} lists "${username}" with something other than group names.`);
    }
    groups.set(
      username,
      (list as string[]).filter((g) => !PROVIDER_GROUP.test(g)),
    );
  }
  return groups;
}

export function cognitoAttributes(user: CognitoUser): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const attr of user.Attributes ?? []) {
    if (attr && typeof attr.Name === "string" && typeof attr.Value === "string") {
      attributes[attr.Name] = attr.Value;
    }
  }
  return attributes;
}

export interface CognitoRowOptions {
  /** Import users whose email_verified attribute is "false". */
  allowUnverified: boolean;
  /** Import users who signed up and never confirmed (UNCONFIRMED). */
  includeUnconfirmed: boolean;
}

/**
 * Cognito users as import rows, numbered in the order the export listed them.
 * Matches the conversion in the Cognito migration guide: the sub attribute is the
 * external id, groups become roles, and disabled and unconfirmed users and users
 * with no email are left out.
 */
export function cognitoImportRows(
  users: CognitoUser[],
  groups: Map<string, string[]>,
  mapping: MigrationMapping,
  opts: CognitoRowOptions,
): { prepared: PreparedRow[]; invalid: InvalidRow[]; skipped: InvalidRow[] } {
  const prepared: PreparedRow[] = [];
  const invalid: InvalidRow[] = [];
  const skipped: InvalidRow[] = [];

  users.forEach((user, i) => {
    const row = i + 1;
    const attrs = cognitoAttributes(user);
    const email = attrs.email?.trim() ?? "";
    const externalId = attrs.sub?.trim() ?? "";
    const ref = { row, email, ...(externalId ? { externalId } : {}) };

    if (user.Enabled === false) {
      skipped.push({ ...ref, detail: "disabled in Cognito" });
      return;
    }
    if (user.UserStatus === "UNCONFIRMED" && !opts.includeUnconfirmed) {
      skipped.push({
        ...ref,
        detail: "sign-up never confirmed (pass --include-unconfirmed to import it)",
      });
      return;
    }
    if (!email) {
      invalid.push({
        ...ref,
        detail: attrs.phone_number
          ? "no email address (a phone-only user; add an email in Cognito before exporting)"
          : "no email address",
      });
      return;
    }
    if (!externalId) {
      invalid.push({ ...ref, detail: "no sub attribute" });
      return;
    }
    if (attrs.email_verified === "false" && !opts.allowUnverified) {
      skipped.push({
        ...ref,
        detail: "email not verified in Cognito (pass --allow-unverified to import it)",
      });
      return;
    }

    const attribute = (name: MappedField) =>
      mapping.columns[name] ? attrs[mapping.columns[name]!] : undefined;
    const phone = attrs.phone_number?.trim();
    const checked = checkRow(row, {
      email,
      externalId,
      ...(phone ? { phone } : {}),
      roles: Array.from(
        new Set([
          ...mapping.roles,
          ...(user.Username ? (groups.get(user.Username) ?? []) : []),
          ...valueList(attribute("roles"), mapping.separator),
        ]),
      ),
      organizations: organizationRefs(
        valueList(attribute("organizations"), mapping.separator),
        mapping,
      ),
    });
    if ("prepared" in checked) prepared.push(checked.prepared);
    else invalid.push(checked.invalid);
  });

  return { prepared, invalid, skipped };
}
