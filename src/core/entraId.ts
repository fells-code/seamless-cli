import fs from "fs";
import { UserImportRowSchema } from "@seamless-auth/types";
import type { InvalidRow, PreparedRow } from "./migrate.js";

export const GRAPH_ORIGIN = "https://graph.microsoft.com";
const LOGIN_ORIGIN = "https://login.microsoftonline.com";
const USER_FIELDS = "id,mail,userPrincipalName,mobilePhone,accountEnabled,userType";
const PAGE_SIZE = 999;
const MAX_RETRIES = 4;
const MAX_RETRY_WAIT_MS = 60_000;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ENTRA_ENV = {
  tenantId: "ENTRA_TENANT_ID",
  clientId: "ENTRA_CLIENT_ID",
  clientSecret: "ENTRA_CLIENT_SECRET",
} as const;

export class EntraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntraError";
  }
}

export interface EntraCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface EntraUser {
  id: string;
  mail?: string | null;
  userPrincipalName?: string | null;
  mobilePhone?: string | null;
  accountEnabled?: boolean | null;
  userType?: string | null;
}

export interface GraphOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The app registration's credentials, from the environment only. A flag would put the
 * secret in shell history, and it is never written to the report.
 */
export function entraCredentialsFromEnv(
  env: Record<string, string | undefined> = process.env,
): EntraCredentials {
  const value = (name: string) => env[name]?.trim() || undefined;
  const missing = Object.values(ENTRA_ENV).filter((name) => !value(name));
  if (missing.length) {
    throw new EntraError(
      `Set ${missing.join(", ")} for the Entra ID app registration. They are read from the environment only, so the secret stays out of shell history.`,
    );
  }

  const tenantId = value(ENTRA_ENV.tenantId)!;
  // It becomes a path segment of the sign-in URL: a tenant id or a verified domain.
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(tenantId)) {
    throw new EntraError(
      `${ENTRA_ENV.tenantId} must be the directory (tenant) id or a verified domain.`,
    );
  }

  return {
    tenantId,
    clientId: value(ENTRA_ENV.clientId)!,
    clientSecret: value(ENTRA_ENV.clientSecret)!,
  };
}

function firstLine(text: unknown): string | undefined {
  return typeof text === "string" ? text.split(/\r?\n/)[0].trim() || undefined : undefined;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** An app-only Graph token through the client credentials grant. */
export async function getGraphToken(
  creds: EntraCredentials,
  opts: GraphOptions = {},
): Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(
      `${LOGIN_ORIGIN}/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          scope: `${GRAPH_ORIGIN}/.default`,
          grant_type: "client_credentials",
        }).toString(),
      },
    );
  } catch {
    throw new EntraError("Could not reach Microsoft sign-in. Check your connection.");
  }

  const body = await readJson(res);
  if (!res.ok || typeof body?.access_token !== "string") {
    // error_description names the problem (wrong secret, unknown tenant) and never
    // echoes the secret back.
    const detail = firstLine(body?.error_description) ?? `status ${res.status}`;
    throw new EntraError(`Microsoft sign-in for the app registration failed: ${detail}`);
  }
  return body.access_token;
}

function retryDelayMs(res: Response, attempt: number): number {
  const header = Number(res.headers.get("retry-after"));
  const ms = Number.isFinite(header) && header > 0 ? header * 1000 : 2 ** attempt * 1000;
  return Math.min(ms, MAX_RETRY_WAIT_MS);
}

async function graphGet(
  url: string,
  token: string,
  opts: GraphOptions,
): Promise<Record<string, unknown>> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      throw new EntraError("Could not reach Microsoft Graph. Check your connection.");
    }

    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(res, attempt));
      continue;
    }

    const body = await readJson(res);
    if (res.ok && body) return body;

    const graphMessage = firstLine(
      (body?.error as Record<string, unknown> | undefined)?.message,
    );
    if (res.status === 401 || res.status === 403) {
      throw new EntraError(
        `Microsoft Graph refused the request (${res.status}). The app registration needs the application permissions User.Read.All, and GroupMember.Read.All for groups, with admin consent granted.${graphMessage ? ` Graph said: ${graphMessage}` : ""}`,
      );
    }
    throw new EntraError(
      `Microsoft Graph request failed (${res.status}).${graphMessage ? ` ${graphMessage}` : ""}`,
    );
  }
}

/**
 * Every item across Graph's pages. The next-page link is followed only on Graph itself,
 * since the token goes with it.
 */
async function listAll<T>(url: string, token: string, opts: GraphOptions): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = url;

  while (next) {
    if (new URL(next).origin !== GRAPH_ORIGIN) {
      throw new EntraError(`Microsoft Graph returned a next page outside ${GRAPH_ORIGIN}.`);
    }
    const page = await graphGet(next, token, opts);
    items.push(...((page.value as T[] | undefined) ?? []));
    next = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
  }

  return items;
}

export function assertGroupId(id: string): string {
  if (!GUID.test(id)) {
    throw new EntraError(`"${id}" is not an Entra ID group object id.`);
  }
  return id;
}

/** Every user in the directory, or only the users in a group, nested groups included. */
export async function listEntraUsers(
  token: string,
  groupId: string | undefined,
  opts: GraphOptions = {},
): Promise<EntraUser[]> {
  const path = groupId
    ? `/v1.0/groups/${assertGroupId(groupId)}/transitiveMembers/microsoft.graph.user`
    : "/v1.0/users";
  return listAll<EntraUser>(
    `${GRAPH_ORIGIN}${path}?$select=${USER_FIELDS}&$top=${PAGE_SIZE}`,
    token,
    opts,
  );
}

/** What membership of one Entra group grants on import. */
export interface GroupGrant {
  id: string;
  /** An organization slug or id, which must already exist. */
  organization?: string;
  /** Membership roles in that organization. The server defaults to member. */
  organizationRoles?: string[];
  /** Instance roles. Admin roles are refused by the server. */
  roles?: string[];
}

function optionalStrings(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new EntraError(`${where} must be a list of strings.`);
  }
  return value as string[];
}

export function loadGroupMapping(path: string): GroupGrant[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  } catch (err) {
    throw new EntraError(`Could not read the group mapping ${path}: ${(err as Error).message}`);
  }

  const groups = (raw as { groups?: unknown })?.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new EntraError(`The group mapping ${path} needs a non-empty "groups" list.`);
  }

  return groups.map((entry, i) => {
    const where = `groups[${i}]`;
    const g = entry as Record<string, unknown>;
    if (typeof g?.id !== "string") throw new EntraError(`${where}.id must be a group object id.`);
    if (g.organization !== undefined && typeof g.organization !== "string") {
      throw new EntraError(`${where}.organization must be an organization slug or id.`);
    }
    const grant: GroupGrant = {
      id: assertGroupId(g.id),
      ...(g.organization ? { organization: g.organization as string } : {}),
      ...(optionalStrings(g.organizationRoles, `${where}.organizationRoles`)
        ? { organizationRoles: g.organizationRoles as string[] }
        : {}),
      ...(optionalStrings(g.roles, `${where}.roles`) ? { roles: g.roles as string[] } : {}),
    };
    if (!grant.organization && !grant.roles?.length) {
      throw new EntraError(`${where} grants nothing: give it an organization or roles.`);
    }
    return grant;
  });
}

export interface UserGrants {
  roles: string[];
  organizations: { organizationId?: string; slug?: string; roles?: string[] }[];
}

/** For each user in a mapped group, the roles and organizations its groups grant. */
export async function resolveGroupGrants(
  token: string,
  grants: GroupGrant[],
  opts: GraphOptions = {},
): Promise<Map<string, UserGrants>> {
  const byUser = new Map<string, UserGrants>();

  for (const grant of grants) {
    const members = await listAll<{ id: string }>(
      `${GRAPH_ORIGIN}/v1.0/groups/${grant.id}/transitiveMembers/microsoft.graph.user?$select=id&$top=${PAGE_SIZE}`,
      token,
      opts,
    );
    for (const { id } of members) {
      const entry = byUser.get(id) ?? { roles: [], organizations: [] };
      for (const role of grant.roles ?? []) {
        if (!entry.roles.includes(role)) entry.roles.push(role);
      }
      if (grant.organization) {
        entry.organizations.push({
          ...(GUID.test(grant.organization)
            ? { organizationId: grant.organization }
            : { slug: grant.organization }),
          ...(grant.organizationRoles?.length ? { roles: grant.organizationRoles } : {}),
        });
      }
      byUser.set(id, entry);
    }
  }

  return byUser;
}

// Entra stores the number as typed ("+1 (425) 555-0100"); the server wants it compact.
function compactPhone(value: string | null | undefined): string | undefined {
  const compact = value?.replace(/[\s().-]/g, "");
  return compact || undefined;
}

export interface EntraRowOptions {
  /** Use userPrincipalName when a user has no mail. A UPN is not always a mailbox. */
  allowUpn: boolean;
  includeGuests: boolean;
}

/**
 * Entra users as import rows, numbered in the order Graph listed them. Disabled
 * accounts, and guests unless asked for, are skipped and reported rather than sent.
 */
export function toImportRows(
  users: EntraUser[],
  grants: Map<string, UserGrants>,
  opts: EntraRowOptions,
): { prepared: PreparedRow[]; invalid: InvalidRow[]; skipped: InvalidRow[] } {
  const prepared: PreparedRow[] = [];
  const invalid: InvalidRow[] = [];
  const skipped: InvalidRow[] = [];

  users.forEach((user, i) => {
    const row = i + 1;
    const label = user.mail || user.userPrincipalName || "";

    if (user.accountEnabled === false) {
      skipped.push({ row, email: label, externalId: user.id, detail: "disabled in Entra ID" });
      return;
    }
    if (user.userType === "Guest" && !opts.includeGuests) {
      skipped.push({
        row,
        email: label,
        externalId: user.id,
        detail: "guest account (pass --include-guests to import guests)",
      });
      return;
    }

    const email = user.mail || (opts.allowUpn ? user.userPrincipalName : undefined);
    if (!email) {
      invalid.push({
        row,
        email: label,
        externalId: user.id,
        detail: "no mail address (pass --allow-upn to use the userPrincipalName)",
      });
      return;
    }

    const grant = grants.get(user.id);
    const phone = compactPhone(user.mobilePhone);
    const candidate = {
      externalId: user.id,
      email,
      ...(phone ? { phone } : {}),
      ...(grant?.roles.length ? { roles: grant.roles } : {}),
      ...(grant?.organizations.length ? { organizations: grant.organizations } : {}),
    };

    const parsed = UserImportRowSchema.safeParse(candidate);
    if (parsed.success) {
      prepared.push({ row, user: parsed.data });
    } else {
      const issue = parsed.error.issues[0];
      invalid.push({
        row,
        email,
        externalId: user.id,
        detail: `${issue.path.join(".") || "row"}: ${issue.message}`,
      });
    }
  });

  return { prepared, invalid, skipped };
}
