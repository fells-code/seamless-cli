import fs from "fs";
import type { Auth0User } from "./auth0.js";
import type { CognitoUser } from "./cognito.js";
import { cognitoAttributes } from "./cognito.js";
import type { EntraUser } from "./entraId.js";
import type { CsvRecord } from "./csv.js";
import type { InvalidRow, MappedField, MigrationMapping, PreparedRow } from "./migrate.js";

export const DOCS_ORIGIN = "https://docs.seamlessauth.com";
const MIGRATE_USERS_GUIDE = `${DOCS_ORIGIN}/operate/migrate-users`;
const GIVE_UP_ANCHOR = "#what-you-give-up-or-must-plan-for";

/** A source user's ways of being reached, which is what the enrollment campaign needs. */
export interface Contact {
  email: boolean;
  /** Undefined when the source does not say. */
  emailVerified?: boolean;
  phone: boolean;
}

export interface FeatureNote {
  feature: string;
  users: number;
  note: string;
}

export interface FieldCount {
  name: string;
  users: number;
}

/** What assess knows about a source beyond the import rows it produced. */
export interface SourceProfile {
  /** The cost calculator's vendor id, when it prices this source. */
  vendor?: "auth0" | "cognito";
  /** The guide whose "what you give up" section covers this source. */
  guide: string;
  contacts: Contact[];
  /** Fields the export carries that the import leaves behind. */
  dropped: FieldCount[];
  features: FeatureNote[];
  /** Things the source may do that no export shows, to check by hand. */
  notInExport: string[];
}

function countBy(names: Iterable<string>): FieldCount[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, users]) => ({ name, users }))
    .sort((a, b) => b.users - a.users || a.name.localeCompare(b.name));
}

function present(value: unknown) {
  return typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null;
}

function auth0Guide() {
  return `${DOCS_ORIGIN}/operate/migrate-from-auth0${GIVE_UP_ANCHOR}`;
}

function cognitoGuide() {
  return `${DOCS_ORIGIN}/operate/migrate-from-cognito${GIVE_UP_ANCHOR}`;
}

// Connection strategies, the prefix of an Auth0 user_id.
const AUTH0_ENTERPRISE = new Set([
  "samlp",
  "waad",
  "adfs",
  "ad",
  "auth0-adldap",
  "oidc",
  "okta",
  "google-apps",
  "pingfederate",
  "ip",
  "office365",
]);
const AUTH0_PASSWORDLESS = new Set(["sms", "email"]);
// Social connections the CLI has a provider preset for.
const PRESET_SOCIAL = new Set(["google-oauth2", "github", "windowslive", "gitlab"]);
const AUTH0_USED = new Set(["line", "user_id", "email", "email_verified", "phone_number", "blocked"]);

export function profileAuth0(users: Auth0User[], mapping: MigrationMapping): SourceProfile {
  const mapped = new Set(Object.values(mapping.columns));
  const dropped: string[] = [];
  const enterprise: string[] = [];
  const social: string[] = [];
  let database = 0;
  let mfa = 0;

  for (const user of users) {
    const record = user as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (AUTH0_USED.has(key) || !present(value)) continue;
      if ((key === "app_metadata" || key === "user_metadata") && typeof value === "object") {
        for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
          if (present(innerValue) && !mapped.has(`${key}.${inner}`)) dropped.push(`${key}.${inner}`);
        }
        continue;
      }
      if (key === "multifactor" && Array.isArray(value) && value.length) mfa++;
      dropped.push(key);
    }

    const strategy = typeof user.user_id === "string" ? user.user_id.split("|")[0] : "";
    if (AUTH0_ENTERPRISE.has(strategy)) enterprise.push(strategy);
    else if (strategy === "auth0") database++;
    else if (strategy && !AUTH0_PASSWORDLESS.has(strategy) && !PRESET_SOCIAL.has(strategy)) {
      social.push(strategy);
    }
  }

  const features: FeatureNote[] = [];
  if (database) {
    features.push({
      feature: "Password sign-in (database connection)",
      users: database,
      note: "Seamless Auth has no passwords. These users prove their email once and enroll a passkey.",
    });
  }
  if (enterprise.length) {
    features.push({
      feature: `Enterprise connections (${countBy(enterprise).map((c) => c.name).join(", ")})`,
      users: enterprise.length,
      note: "Seamless Auth has no SAML and configures OpenID Connect providers instance-wide, not per customer organization.",
    });
  }
  if (social.length) {
    features.push({
      feature: `Social connections without a CLI preset (${countBy(social).map((c) => c.name).join(", ")})`,
      users: social.length,
      note: "These can be configured by hand as OAuth providers if they report a verified email.",
    });
  }
  if (mfa) {
    features.push({
      feature: "MFA enrollments",
      users: mfa,
      note: "MFA factors are not carried across. Every user enrolls a new passkey.",
    });
  }

  return {
    vendor: "auth0",
    guide: auth0Guide(),
    contacts: users.map((u) => ({
      email: present(u.email),
      ...(typeof u.email_verified === "boolean" ? { emailVerified: u.email_verified } : {}),
      phone: present(u.phone_number),
    })),
    dropped: countBy(dropped),
    features,
    notInExport: [
      "Actions that run during login or add custom token claims",
      "Auth0 RBAC role assignments, which the user export does not include",
      "Applications that use Auth0 as their OAuth 2.0 authorization server, and machine-to-machine tokens",
      "Organizations with per-customer enterprise connections",
    ],
  };
}

const COGNITO_USED = new Set(["sub", "email", "email_verified", "phone_number", "phone_number_verified"]);
const COGNITO_FEDERATED_OK = new Set(["Google", "OIDC", "SignInWithApple", "Facebook", "LoginWithAmazon"]);

function identityProviders(attrs: Record<string, string>): string[] {
  if (!attrs.identities) return [];
  try {
    const parsed = JSON.parse(attrs.identities) as { providerType?: unknown }[];
    return Array.isArray(parsed)
      ? parsed.map((i) => (typeof i?.providerType === "string" ? i.providerType : "")).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

export function profileCognito(users: CognitoUser[], mapping: MigrationMapping): SourceProfile {
  const mapped = new Set(Object.values(mapping.columns));
  const dropped: string[] = [];
  const saml: string[] = [];
  const federated: string[] = [];
  let passwords = 0;
  let mfa = 0;

  for (const user of users) {
    const attrs = cognitoAttributes(user);
    for (const name of Object.keys(attrs)) {
      if (!COGNITO_USED.has(name) && !mapped.has(name)) dropped.push(name);
    }
    const providers = identityProviders(attrs);
    for (const provider of providers) {
      if (provider === "SAML") saml.push(provider);
      else if (!COGNITO_FEDERATED_OK.has(provider)) federated.push(provider);
    }
    if (user.UserStatus !== "EXTERNAL_PROVIDER" && providers.length === 0) passwords++;
    const record = user as Record<string, unknown>;
    if (Array.isArray(record.MFAOptions) && record.MFAOptions.length) mfa++;
  }

  const features: FeatureNote[] = [];
  if (passwords) {
    features.push({
      feature: "Password sign-in (user pool directory)",
      users: passwords,
      note: "Seamless Auth has no passwords, and Cognito cannot export them. These users prove their email once and enroll a passkey.",
    });
  }
  if (saml.length) {
    features.push({
      feature: "SAML identity providers",
      users: saml.length,
      note: "Seamless Auth has no SAML. A customer that requires SAML SSO into your app is not served today.",
    });
  }
  if (federated.length) {
    features.push({
      feature: `Other federated providers (${countBy(federated).map((c) => c.name).join(", ")})`,
      users: federated.length,
      note: "These need an OpenID Connect or OAuth provider configured in Seamless Auth that reports a verified email.",
    });
  }
  if (mfa) {
    features.push({
      feature: "SMS MFA settings",
      users: mfa,
      note: "MFA settings are not carried across. Every user enrolls a new passkey.",
    });
  }

  return {
    vendor: "cognito",
    guide: cognitoGuide(),
    contacts: users.map((u) => {
      const attrs = cognitoAttributes(u);
      return {
        email: present(attrs.email),
        ...(attrs.email_verified === "true" || attrs.email_verified === "false"
          ? { emailVerified: attrs.email_verified === "true" }
          : {}),
        phone: present(attrs.phone_number),
      };
    }),
    dropped: countBy(dropped),
    features,
    notInExport: [
      "Identity pools that exchange a sign-in for temporary AWS credentials",
      "Groups mapped to IAM roles (cognito:roles and cognito:preferred_role claims)",
      "API Gateway Cognito authorizers, Application Load Balancer authentication and Amplify Auth",
      "Lambda triggers (pre sign-up, pre token generation, custom auth challenges, user migration)",
      "App clients that use the pool as an OAuth 2.0 authorization server, with resource servers and machine-to-machine tokens",
    ],
  };
}

export function profileCsv(
  headers: string[],
  columns: Partial<Record<MappedField, string>>,
  records: CsvRecord[],
): SourceProfile {
  const used = new Set(Object.values(columns));
  const value = (record: CsvRecord, field: MappedField) =>
    columns[field] ? record.values[columns[field]!] : undefined;
  return {
    guide: MIGRATE_USERS_GUIDE,
    contacts: records.map((r) => ({
      email: present(value(r, "email")),
      phone: present(value(r, "phone")),
    })),
    dropped: countBy(
      records.flatMap((r) => headers.filter((h) => !used.has(h) && present(r.values[h]))),
    ),
    features: [],
    notInExport: [],
  };
}

export function profileEntraId(users: EntraUser[], opts: { allowUpn: boolean }): SourceProfile {
  return {
    guide: MIGRATE_USERS_GUIDE,
    contacts: users.map((u) => {
      const email = present(u.mail) || (opts.allowUpn && present(u.userPrincipalName));
      return {
        email,
        // mail is set by the directory, not by the user, so it is a known mailbox.
        ...(present(u.mail) ? { emailVerified: true } : {}),
        phone: present(u.mobilePhone),
      };
    }),
    dropped: [],
    features: [],
    notInExport: [
      "Conditional Access policies",
      "Applications that use Entra ID for single sign-on through SAML",
      "Provisioning (SCIM) into other applications",
    ],
  };
}

export interface Assessment {
  source: string;
  input: string;
  generatedAt: string;
  users: {
    found: number;
    wouldImport: number;
    notImported: number;
    duplicateEmails: { addresses: number; users: number };
  };
  notImported: FieldCount[];
  contacts: {
    verifiedEmail: number;
    unverifiedEmail: number;
    unknownEmail: number;
    phoneOnly: number;
    neither: number;
  };
  roles: FieldCount[];
  organizations: FieldCount[];
  dropped: FieldCount[];
  features: FeatureNote[];
  notInExport: string[];
  guide: string;
  costCalculator: string;
}

/**
 * A row's problem as a reason shared by every row it applies to: list indexes are
 * dropped, and a schema pattern is described instead of printed.
 */
export function reasonOf(detail: string): string {
  const generic = detail.replace(/\.\d+(?=[.:])/g, "");
  const [field] = generic.split(":");
  if (/must match pattern/.test(generic)) {
    return field === "roles"
      ? "roles: a group or role name that is not a valid role (letters, digits and hyphens, with optional : segments)"
      : `${field}: not in the format the import accepts`;
  }
  return generic;
}

export const DUPLICATE_REASON = "shares an email with an earlier user (the import keeps the first)";

export function assess(
  plan: {
    source: string;
    input: string;
    prepared: PreparedRow[];
    invalid: InvalidRow[];
    skipped: InvalidRow[];
  },
  profile: SourceProfile,
  now: Date = new Date(),
): Assessment {
  const seen = new Set<string>();
  const sharedBy = new Map<string, number>();
  const importing: PreparedRow[] = [];
  for (const row of plan.prepared) {
    const key = row.user.email.toLowerCase();
    if (seen.has(key)) {
      sharedBy.set(key, (sharedBy.get(key) ?? 1) + 1);
    } else {
      seen.add(key);
      importing.push(row);
    }
  }
  const duplicates = plan.prepared.length - importing.length;

  const contacts = { verifiedEmail: 0, unverifiedEmail: 0, unknownEmail: 0, phoneOnly: 0, neither: 0 };
  for (const c of profile.contacts) {
    if (c.email && c.emailVerified === true) contacts.verifiedEmail++;
    else if (c.email && c.emailVerified === false) contacts.unverifiedEmail++;
    else if (c.email) contacts.unknownEmail++;
    else if (c.phone) contacts.phoneOnly++;
    else contacts.neither++;
  }

  const found = profile.contacts.length;
  const mau = Math.max(found, 1);
  const cost = new URL(`${DOCS_ORIGIN}/compare/cost`);
  cost.searchParams.set("mau", String(mau));
  if (profile.vendor) cost.searchParams.set("vendor", profile.vendor);

  return {
    source: plan.source,
    input: plan.input,
    generatedAt: now.toISOString(),
    users: {
      found,
      wouldImport: importing.length,
      notImported: found - importing.length,
      duplicateEmails: {
        addresses: sharedBy.size,
        users: [...sharedBy.values()].reduce((a, b) => a + b, 0),
      },
    },
    notImported: countBy([
      ...plan.invalid.map((r) => reasonOf(r.detail)),
      ...plan.skipped.map((r) => reasonOf(r.detail)),
      ...Array.from({ length: duplicates }, () => DUPLICATE_REASON),
    ]),
    contacts,
    roles: countBy(importing.flatMap((r) => r.user.roles ?? [])),
    organizations: countBy(
      importing.flatMap((r) => (r.user.organizations ?? []).map((o) => o.slug ?? o.organizationId ?? "")),
    ),
    dropped: profile.dropped,
    features: profile.features,
    notInExport: profile.notInExport,
    guide: profile.guide,
    costCalculator: cost.toString(),
  };
}

function table(head: [string, string], rows: [string, number | string][]): string[] {
  return [`| ${head[0]} | ${head[1]} |`, "| --- | ---: |", ...rows.map(([a, b]) => `| ${a} | ${b} |`)];
}

// Names in the report come from the export (a role, a column header), so they are
// kept from breaking a table row or rendering as markup.
function cell(value: string) {
  return value.replace(/[|\\`*_<>[\]]/g, (ch) => `\\${ch}`).replace(/\s+/g, " ");
}

function users(n: number) {
  return `${n} ${n === 1 ? "user" : "users"}`;
}

function share(n: number, of: number) {
  return of ? `${n} (${Math.round((n / of) * 100)}%)` : String(n);
}

/**
 * The report a developer hands to a technical lead. It carries counts and names
 * of fields, roles and organizations, never a user's email, phone or id.
 */
export function renderAssessment(a: Assessment): string {
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);
  const { found } = a.users;

  push(
    `# Migration readiness: ${a.source}`,
    "",
    `Assessed \`${cell(a.input)}\` as source \`${a.source}\` on ${a.generatedAt.slice(0, 10)} with \`seamless migrate assess\`. Nothing was sent to a Seamless Auth instance.`,
    "",
    "## Users",
    "",
    ...table(["", "Users"], [
      ["Found in the export", found],
      ["Would import", share(a.users.wouldImport, found)],
      ["Would not import", share(a.users.notImported, found)],
    ]),
    "",
  );
  if (a.users.duplicateEmails.addresses) {
    push(
      `${users(a.users.duplicateEmails.users)} share ${a.users.duplicateEmails.addresses} email address(es). Each address becomes one Seamless Auth account and the import keeps the first user, so before importing keep the one whose id the person signs in with.`,
      "",
    );
  }
  push(
    "Roles and organizations are checked against the instance only by a dry run, so a few more rows may be rejected there (an unknown role, a missing organization, an admin role).",
    "",
  );

  if (a.notImported.length) {
    push("### Why users would not import", "", ...table(["Reason", "Users"], a.notImported.map((r) => [cell(r.name), r.users])), "");
  }

  push(
    "## Contact coverage",
    "",
    "Every imported user signs in the first time by proving their email, then enrolls a passkey. This is who the enrollment campaign can reach.",
    "",
    ...table(["Contact", "Users"], [
      ["Verified email", share(a.contacts.verifiedEmail, found)],
      ["Email the source marks unverified", share(a.contacts.unverifiedEmail, found)],
      ["Email, verification not recorded", share(a.contacts.unknownEmail, found)],
      ["Phone only", share(a.contacts.phoneOnly, found)],
      ["Neither", share(a.contacts.neither, found)],
    ]),
    "",
    "## Groups and attributes",
    "",
  );
  if (a.roles.length) {
    push("Roles (must be in the instance's `available_roles`):", "", ...table(["Role", "Users"], a.roles.map((r) => [cell(r.name), r.users])), "");
  } else {
    push("No roles would be imported.", "");
  }
  if (a.organizations.length) {
    push(
      "Organization memberships (organizations must already exist):",
      "",
      ...table(["Organization", "Users"], a.organizations.map((r) => [cell(r.name), r.users])),
      "",
    );
  } else {
    push("No organization memberships would be imported.", "");
  }
  if (a.dropped.length) {
    push(
      "Fields in the export that are not imported (map them with `--map`, or leave them behind):",
      "",
      ...table(["Field", "Users"], a.dropped.map((r) => [cell(r.name), r.users])),
      "",
    );
  }

  push("## What Seamless Auth does not cover", "");
  if (a.features.length) {
    push("Seen in the export:", "");
    for (const f of a.features) push(`- **${f.feature}** (${users(f.users)}). ${f.note}`);
    push("");
  } else {
    push("Nothing in the export needs a feature Seamless Auth lacks.", "");
  }
  if (a.notInExport.length) {
    push("Not visible in an export, so check them by hand:", "");
    for (const item of a.notInExport) push(`- ${item}`);
    push("");
  }
  push(`Details: [What you give up or must plan for](${a.guide}).`, "");

  push(
    "## Cost",
    "",
    `Compare list prices at ${found} users in the [identity cost calculator](${a.costCalculator}). The user count is an upper bound for monthly active users.`,
    "",
    "## Next step",
    "",
    "Run the same `seamless migrate` command without `assess` against a Seamless Auth instance. It is a dry run until `--apply`, and its report lists every row.",
    "",
  );
  return lines.join("\n");
}

export function writeAssessment(path: string, a: Assessment): string {
  fs.writeFileSync(path, renderAssessment(a));
  return path;
}
