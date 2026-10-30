import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  assess,
  DOCS_ORIGIN,
  DUPLICATE_REASON,
  profileAuth0,
  profileCognito,
  profileCsv,
  profileEntraId,
  reasonOf,
  renderAssessment,
} from "./assess.js";
import { AUTH0_MAPPED_FIELDS, auth0ImportRows, parseAuth0Export, type Auth0User } from "./auth0.js";
import {
  COGNITO_MAPPED_FIELDS,
  cognitoImportRows,
  loadCognitoGroups,
  parseCognitoExport,
  type CognitoUser,
} from "./cognito.js";
import { parseCsvRecords } from "./csv.js";
import { toImportRows } from "./entraId.js";
import { loadMapping, prepareRows, resolveColumns } from "./migrate.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "migrate");
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf-8");
const NOW = new Date("2026-10-29T12:00:00Z");

const auth0Mapping = (file?: string) =>
  loadMapping(file && path.join(FIXTURES, file), { defaultSource: "auth0", fields: AUTH0_MAPPED_FIELDS });
const cognitoMapping = (file?: string) =>
  loadMapping(file && path.join(FIXTURES, file), { defaultSource: "cognito", fields: COGNITO_MAPPED_FIELDS });

function assessAuth0(users: Auth0User[], mapFile?: string) {
  const mapping = auth0Mapping(mapFile);
  const rows = auth0ImportRows(users, mapping, { allowUnverified: false });
  return assess({ source: "auth0", input: "auth0.json", ...rows }, profileAuth0(users, mapping), NOW);
}

function assessCognito(users: CognitoUser[], mapFile?: string) {
  const mapping = cognitoMapping(mapFile);
  const groups = loadCognitoGroups(path.join(FIXTURES, "cognito-groups.json"));
  const rows = cognitoImportRows(users, groups, mapping, {
    allowUnverified: false,
    includeUnconfirmed: false,
  });
  return assess({ source: "cognito", input: "cognito.json", ...rows }, profileCognito(users, mapping), NOW);
}

const auth0Fixture = () => parseAuth0Export(read("auth0-export.ndjson"), "auth0.json");
const cognitoFixture = () => [
  ...parseCognitoExport(read("cognito-users-0.json"), "0"),
  ...parseCognitoExport(read("cognito-users-1.json"), "1"),
];

describe("assess with the Auth0 fixture", () => {
  const a = assessAuth0(auth0Fixture(), "auth0-map.json");

  it("counts users, duplicates and the reasons the rest would not import", () => {
    expect(a.users).toEqual({
      found: 9,
      wouldImport: 4,
      notImported: 5,
      duplicateEmails: { addresses: 1, users: 2 },
    });
    expect(a.notImported.map((r) => r.name)).toEqual([
      "blocked in Auth0",
      "email not verified in Auth0 (pass --allow-unverified to import it)",
      "no email address",
      "no email address (a phone-only user; add an email in Auth0 before exporting)",
      DUPLICATE_REASON,
    ]);
  });

  it("splits contact coverage by verified email, phone only and neither", () => {
    expect(a.contacts).toEqual({
      verifiedEmail: 6,
      unverifiedEmail: 1,
      unknownEmail: 0,
      phoneOnly: 1,
      neither: 1,
    });
  });

  it("says where groups and metadata land", () => {
    expect(a.roles).toEqual([
      { name: "staff", users: 3 },
      { name: "manager", users: 2 },
    ]);
    expect(a.organizations).toEqual([
      { name: "engineering", users: 1 },
      { name: "platform", users: 1 },
    ]);
    expect(a.dropped).toEqual([]);
  });

  it("names the Auth0 features Seamless Auth lacks, with the guide and cost links", () => {
    expect(a.features.map((f) => [f.feature, f.users])).toEqual([
      ["Password sign-in (database connection)", 5],
      ["Enterprise connections (samlp)", 1],
    ]);
    expect(a.guide).toBe(
      "https://docs.seamlessauth.com/operate/migrate-from-auth0#what-you-give-up-or-must-plan-for",
    );
    expect(a.costCalculator).toBe("https://docs.seamlessauth.com/compare/cost?mau=9&vendor=auth0");
  });

  it("lists metadata as dropped without a mapping", () => {
    expect(assessAuth0(auth0Fixture()).dropped).toEqual([
      { name: "app_metadata.roles", users: 3 },
      { name: "app_metadata.org", users: 2 },
    ]);
  });
});

describe("profileAuth0", () => {
  it("flags social connections without a preset, MFA enrollments and unused profile fields", () => {
    const profile = profileAuth0(
      [
        { line: 1, user_id: "facebook|1", email: "a@example.com", name: "A", multifactor: ["guardian"] },
        { line: 2, user_id: "github|2", email: "b@example.com", user_metadata: { theme: "dark", empty: "" } },
        { line: 3, user_id: "email|3", email: "c@example.com", multifactor: [] },
        { line: 4, email: "d@example.com", picture: null },
      ] as Auth0User[],
      auth0Mapping(),
    );
    expect(profile.features.map((f) => [f.feature, f.users])).toEqual([
      ["Social connections without a CLI preset (facebook)", 1],
      ["MFA enrollments", 1],
    ]);
    expect(profile.dropped).toEqual([
      { name: "multifactor", users: 2 },
      { name: "name", users: 1 },
      { name: "user_metadata.theme", users: 1 },
    ]);
    expect(profile.contacts[3]).toEqual({ email: true, phone: false });
  });
});

describe("assess with the Cognito fixture", () => {
  it("counts users and turns a schema error into a shared reason", () => {
    const a = assessCognito(cognitoFixture());
    expect(a.users).toMatchObject({ found: 8, wouldImport: 3, notImported: 5 });
    expect(a.notImported.map((r) => r.name)).toContain(
      "roles: a group or role name that is not a valid role (letters, digits and hyphens, with optional : segments)",
    );
    expect(a.contacts).toEqual({
      verifiedEmail: 5,
      unverifiedEmail: 2,
      unknownEmail: 0,
      phoneOnly: 1,
      neither: 0,
    });
    expect(a.roles).toEqual([
      { name: "staff", users: 3 },
      { name: "manager", users: 1 },
    ]);
    expect(a.costCalculator).toBe("https://docs.seamlessauth.com/compare/cost?mau=8&vendor=cognito");
    expect(a.guide).toMatch(/migrate-from-cognito#what-you-give-up-or-must-plan-for$/);
    expect(a.notInExport[0]).toMatch(/Identity pools/);
  });

  it("drops custom:tenant unless the mapping reads it", () => {
    expect(assessCognito(cognitoFixture()).dropped.map((d) => d.name)).toEqual([
      "custom:tenant",
      "identities",
    ]);
    const mapped = assessCognito(cognitoFixture(), "cognito-map.json");
    expect(mapped.dropped.map((d) => d.name)).toEqual(["identities"]);
    expect(mapped.organizations).toEqual([{ name: "platform", users: 1 }]);
  });
});

describe("profileCognito", () => {
  it("flags SAML and other federated providers and SMS MFA", () => {
    const identities = (providerType: string) => ({
      Name: "identities",
      Value: JSON.stringify([{ providerName: "x", providerType }]),
    });
    const profile = profileCognito(
      [
        { Username: "a", UserStatus: "EXTERNAL_PROVIDER", Attributes: [identities("SAML")] },
        { Username: "b", UserStatus: "EXTERNAL_PROVIDER", Attributes: [identities("Twitch")] },
        { Username: "c", UserStatus: "EXTERNAL_PROVIDER", Attributes: [identities("Google")] },
        { Username: "d", Attributes: [{ Name: "identities", Value: "not json" }] },
        { Username: "e", Attributes: [{ Name: "identities", Value: '{"a":1}' }] },
        { Username: "f", MFAOptions: [{ DeliveryMedium: "SMS" }] } as CognitoUser,
      ],
      cognitoMapping(),
    );
    expect(profile.features.map((f) => [f.feature, f.users])).toEqual([
      ["Password sign-in (user pool directory)", 3],
      ["SAML identity providers", 1],
      ["Other federated providers (Twitch)", 1],
      ["SMS MFA settings", 1],
    ]);
    expect(profile.contacts[0]).toEqual({ email: false, phone: false });
  });
});

describe("assess with CSV and Entra ID", () => {
  it("lists unused CSV columns and leaves vendor off the cost link", () => {
    const { headers, records } = parseCsvRecords(
      ["email,phone,name,notes", "a@example.com,+15555550101,Ada,", ",+15555550102,Lin,x"].join("\n"),
    );
    const mapping = loadMapping(undefined);
    const columns = resolveColumns(headers, mapping);
    const { prepared, invalid } = prepareRows(records, columns, mapping);
    const a = assess(
      { source: "csv", input: "users.csv", prepared, invalid, skipped: [] },
      profileCsv(headers, columns, records),
      NOW,
    );
    expect(a.dropped).toEqual([
      { name: "name", users: 2 },
      { name: "notes", users: 1 },
    ]);
    expect(a.contacts).toMatchObject({ unknownEmail: 1, phoneOnly: 1 });
    expect(a.costCalculator).toBe(`${DOCS_ORIGIN}/compare/cost?mau=2`);
    expect(a.guide).toBe(`${DOCS_ORIGIN}/operate/migrate-users`);
    expect(a.features).toEqual([]);
  });

  it("treats an Entra ID mail address as verified and a UPN as unverified email", () => {
    const users = [
      { id: "1", mail: "a@contoso.com", mobilePhone: "+1 425 555 0100" },
      { id: "2", userPrincipalName: "b@contoso.com" },
      { id: "3", mobilePhone: "+1 425 555 0101" },
    ];
    expect(profileEntraId(users, { allowUpn: false }).contacts).toEqual([
      { email: true, emailVerified: true, phone: true },
      { email: false, phone: false },
      { email: false, phone: true },
    ]);
    const a = assess(
      { source: "entra-id", input: "entra-id:t", ...toImportRows(users, new Map(), { allowUpn: true, includeGuests: false }) },
      profileEntraId(users, { allowUpn: true }),
      NOW,
    );
    expect(a.contacts).toMatchObject({ verifiedEmail: 1, unknownEmail: 1, phoneOnly: 1 });
    expect(a.costCalculator).toBe(`${DOCS_ORIGIN}/compare/cost?mau=3`);
  });

  it("never links the calculator with zero users", () => {
    const a = assess(
      { source: "csv", input: "x", prepared: [], invalid: [], skipped: [] },
      { guide: "g", contacts: [], dropped: [], features: [], notInExport: [] },
      NOW,
    );
    expect(a.costCalculator).toMatch(/mau=1$/);
    expect(renderAssessment(a)).toMatch(/No roles would be imported/);
  });
});

describe("reasonOf", () => {
  it("drops list indexes and describes patterns", () => {
    expect(reasonOf("roles.3: Invalid string: must match pattern /x/")).toMatch(/^roles: a group or role name/);
    expect(reasonOf("organizations.0.slug: Invalid string: must match pattern /x/")).toBe(
      "organizations.slug: not in the format the import accepts",
    );
    expect(reasonOf("email: Invalid email address")).toBe("email: Invalid email address");
  });
});

describe("renderAssessment", () => {
  it("carries counts and names but no user's email, phone or id", () => {
    const auth0 = renderAssessment(assessAuth0(auth0Fixture(), "auth0-map.json"));
    const cognito = renderAssessment(assessCognito(cognitoFixture(), "cognito-map.json"));

    for (const report of [auth0, cognito]) {
      expect(report).not.toMatch(/@example\.com|@acme\.example/i);
      expect(report).not.toMatch(/\+1555555/);
      expect(report).not.toMatch(/auth0\||google-oauth2\||sms\||samlp\||11111111-aaaa/);
      expect(report).toMatch(/Nothing was sent to a Seamless Auth instance/);
    }
    expect(auth0).toContain("| Found in the export | 9 |");
    expect(auth0).toContain("| Would import | 4 (44%) |");
    expect(auth0).toContain("| Phone only | 1 (11%) |");
    expect(auth0).toContain("2 users share 1 email address(es)");
    expect(auth0).toContain("**Enterprise connections (samlp)** (1 user).");
    expect(auth0).toContain(
      "[What you give up or must plan for](https://docs.seamlessauth.com/operate/migrate-from-auth0#what-you-give-up-or-must-plan-for)",
    );
    expect(auth0).toContain("(https://docs.seamlessauth.com/compare/cost?mau=9&vendor=auth0)");
    expect(cognito).toContain("| platform | 1 |");
    expect(cognito).toContain("Identity pools that exchange");
  });

  it("escapes names from the export so they cannot break a table or add markup", () => {
    const a = assess(
      {
        source: "csv",
        input: "x|y.csv",
        prepared: [{ row: 1, user: { email: "a@example.com", roles: ["a|b"] } }],
        invalid: [],
        skipped: [],
      },
      { guide: "g", contacts: [{ email: true, phone: false }], dropped: [{ name: "<b>x</b>", users: 1 }], features: [], notInExport: [] },
      NOW,
    );
    const report = renderAssessment(a);
    expect(report).toContain("| a\\|b | 1 |");
    expect(report).toContain("| \\<b\\>x\\</b\\> | 1 |");
    expect(report).toContain("Nothing in the export needs a feature Seamless Auth lacks.");
  });
});
