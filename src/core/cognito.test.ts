import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  COGNITO_MAPPED_FIELDS,
  cognitoAttributes,
  cognitoImportRows,
  loadCognitoGroups,
  parseCognitoExport,
  parseJsonValues,
} from "./cognito.js";
import { loadMapping } from "./migrate.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "migrate");
const page0 = fs.readFileSync(path.join(FIXTURES, "cognito-users-0.json"), "utf-8");
const page1 = fs.readFileSync(path.join(FIXTURES, "cognito-users-1.json"), "utf-8");
const pages = [JSON.parse(page0), JSON.parse(page1)];
const allUsers = () => [
  ...parseCognitoExport(page0, "users-0.json"),
  ...parseCognitoExport(page1, "users-1.json"),
];
const mapping = (file?: string) =>
  loadMapping(file && path.join(FIXTURES, file), {
    defaultSource: "cognito",
    fields: COGNITO_MAPPED_FIELDS,
  });
const usernames = (text: string) =>
  parseCognitoExport(text, "export.json").map((u) => u.Username);

const EXPECTED = ["ada", "Google_104857600123456789012", "lin", "phone-only", "disabled", "unconfirmed", "unverified", "kai"];

describe("parseCognitoExport", () => {
  it("reads every shape the guide's export produces, in page order", () => {
    // Concatenated pages, as `cat cognito-export/users-*.json` writes them.
    expect(usernames(page0 + page1)).toEqual(EXPECTED);
    // An array of pages, as `jq -s .` writes them.
    expect(usernames(JSON.stringify(pages))).toEqual(EXPECTED);
    // The flattened users array, as `jq -s '[.[].Users[]]'` and `jq '.Users'` write it.
    expect(usernames(JSON.stringify(pages.flatMap((p) => p.Users)))).toEqual(EXPECTED);
    // One page, NextToken and all.
    expect(usernames(page0)).toEqual(EXPECTED.slice(0, 3));
  });

  it("keeps braces and quotes inside attribute values out of the page split", () => {
    const tricky = JSON.stringify({
      Users: [{ Username: "x", Attributes: [{ Name: "custom:note", Value: '}{"]\\[' }] }],
    });
    expect(parseCognitoExport(tricky + "\n" + tricky, "t")).toHaveLength(2);
  });

  it("explains input that is not list-users output", () => {
    expect(() => parseCognitoExport("", "x.json")).toThrow(/x\.json is empty/);
    expect(() => parseCognitoExport('{"Groups": []}', "x.json")).toThrow(/not aws cognito-idp list-users output/);
    expect(() => parseCognitoExport("[1, 2]", "x.json")).toThrow(/not aws cognito-idp list-users output/);
  });
});

describe("parseJsonValues", () => {
  it("refuses broken JSON with the file name", () => {
    expect(() => parseJsonValues('{"a": 1} x', "f")).toThrow(/f is not valid JSON: unexpected "x"/);
    expect(() => parseJsonValues('{"a": 1}}', "f")).toThrow(/unexpected "}"/);
    expect(() => parseJsonValues('{"a": 1} {"b"', "f")).toThrow(/ends early/);
    expect(() => parseJsonValues('{"a": 1} {"b" 2}', "f")).toThrow(/f is not valid JSON/);
  });
});

describe("loadCognitoGroups", () => {
  it("reads the username-to-groups map and drops Cognito's per-provider groups", () => {
    const groups = loadCognitoGroups(path.join(FIXTURES, "cognito-groups.json"));
    expect(groups.get("Google_104857600123456789012")).toEqual(["staff", "manager"]);
    expect(groups.get("kai")).toEqual(["Read_Only"]);
  });

  it("refuses a file that is not a username-to-groups map", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-cognito-"));
    const write = (body: string) => {
      const file = path.join(dir, "groups.json");
      fs.writeFileSync(file, body);
      return file;
    };
    expect(() => loadCognitoGroups(path.join(dir, "missing.json"))).toThrow(/Could not read the groups file/);
    expect(() => loadCognitoGroups(write("[]"))).toThrow(/must map each username/);
    expect(() => loadCognitoGroups(write('{"ada": "staff"}'))).toThrow(/lists "ada"/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cognitoAttributes", () => {
  it("ignores attributes without a string value", () => {
    expect(
      cognitoAttributes({ Attributes: [{ Name: "email" }, { Name: "sub", Value: "s" }] }),
    ).toEqual({ sub: "s" });
    expect(cognitoAttributes({})).toEqual({});
  });
});

describe("cognitoImportRows", () => {
  const groups = () => loadCognitoGroups(path.join(FIXTURES, "cognito-groups.json"));

  it("matches the guide's jq conversion with groups and custom:tenant", () => {
    const { prepared, invalid, skipped } = cognitoImportRows(
      allUsers(),
      groups(),
      mapping("cognito-map.json"),
      { allowUnverified: false, includeUnconfirmed: false },
    );

    expect(prepared.map((p) => p.user)).toEqual([
      { email: "ada@example.com", externalId: "11111111-aaaa-4bbb-8ccc-000000000001", roles: ["staff"] },
      {
        email: "grace@example.com",
        externalId: "11111111-aaaa-4bbb-8ccc-000000000002",
        roles: ["staff", "manager"],
      },
      {
        email: "lin@example.com",
        externalId: "11111111-aaaa-4bbb-8ccc-000000000003",
        phone: "+15555550101",
        roles: ["staff"],
        organizations: [{ slug: "platform" }],
      },
    ]);
    expect(invalid.map((r) => [r.row, r.detail])).toEqual([
      [4, "no email address (a phone-only user; add an email in Cognito before exporting)"],
      [8, expect.stringMatching(/^roles\.0:/)],
    ]);
    expect(skipped.map((r) => [r.row, r.detail])).toEqual([
      [5, "disabled in Cognito"],
      [6, "sign-up never confirmed (pass --include-unconfirmed to import it)"],
      [7, "email not verified in Cognito (pass --allow-unverified to import it)"],
    ]);
  });

  it("imports unconfirmed and unverified users when asked, with no roles without groups", () => {
    const { prepared, skipped } = cognitoImportRows(allUsers(), new Map(), mapping(), {
      allowUnverified: true,
      includeUnconfirmed: true,
    });
    expect(prepared.map((p) => p.row)).toEqual([1, 2, 3, 6, 7, 8]);
    expect(prepared.some((p) => p.user.roles)).toBe(false);
    expect(skipped.map((r) => r.row)).toEqual([5]);
  });

  it("reads roles from an attribute and adds the mapping's own roles", () => {
    const { prepared } = cognitoImportRows(
      [
        {
          Attributes: [
            { Name: "sub", Value: "s-1" },
            { Name: "email", Value: "a@example.com" },
            { Name: "custom:roles", Value: "staff;manager" },
          ],
        },
      ],
      new Map(),
      { ...mapping(), columns: { roles: "custom:roles" }, roles: ["customer"] },
      { allowUnverified: false, includeUnconfirmed: false },
    );
    expect(prepared[0].user.roles).toEqual(["customer", "staff", "manager"]);
  });

  it("marks a user with no email or no sub invalid", () => {
    const { invalid } = cognitoImportRows(
      [
        { Username: "nobody", Attributes: [{ Name: "sub", Value: "s-1" }] },
        { Username: "nosub", Attributes: [{ Name: "email", Value: "a@example.com" }] },
      ],
      new Map(),
      mapping(),
      { allowUnverified: false, includeUnconfirmed: false },
    );
    expect(invalid).toEqual([
      { row: 1, email: "", externalId: "s-1", detail: "no email address" },
      { row: 2, email: "a@example.com", detail: "no sub attribute" },
    ]);
  });
});
