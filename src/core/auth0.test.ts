import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { assertAuth0Mapping, AUTH0_MAPPED_FIELDS, auth0ImportRows, parseAuth0Export } from "./auth0.js";
import { loadMapping } from "./migrate.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "migrate");
const exportFile = path.join(FIXTURES, "auth0-export.ndjson");
const users = () => parseAuth0Export(fs.readFileSync(exportFile, "utf-8"), exportFile);
const mapping = (file?: string) =>
  loadMapping(file && path.join(FIXTURES, file), {
    defaultSource: "auth0",
    fields: AUTH0_MAPPED_FIELDS,
  });

describe("parseAuth0Export", () => {
  it("reads one user per line, numbered by line, skipping blank lines", () => {
    const parsed = users();
    expect(parsed).toHaveLength(9);
    expect(parsed[0]).toMatchObject({ line: 1, user_id: "auth0|65f1a2b3c4d5e6f7a8b9c0d1" });
    expect(parsed[8].line).toBe(9);
  });

  it("reads a JSON array of users", () => {
    const parsed = parseAuth0Export(
      JSON.stringify([{ user_id: "auth0|1", email: "a@example.com" }]),
      "users.json",
    );
    expect(parsed).toEqual([{ user_id: "auth0|1", email: "a@example.com", line: 1 }]);
  });

  it("names the line that is not JSON, and suggests the JSON export format", () => {
    expect(() => parseAuth0Export('{"user_id":"a"}\n\'ada@example.com', "x.ndjson")).toThrow(
      /x\.ndjson line 2 is not JSON.*"format": "json"/,
    );
  });

  it("refuses an empty file, a broken array, and values that are not users", () => {
    expect(() => parseAuth0Export("  \n", "x")).toThrow(/is empty/);
    expect(() => parseAuth0Export("[{", "x")).toThrow(/not valid JSON/);
    expect(() => parseAuth0Export("[1]", "x")).toThrow(/item 1 is not an Auth0 user/);
    expect(() => parseAuth0Export("null", "x")).toThrow(/line 1 is not an Auth0 user/);
  });
});

describe("assertAuth0Mapping", () => {
  it("accepts app_metadata and user_metadata paths only", () => {
    expect(() => assertAuth0Mapping(mapping("auth0-map.json"))).not.toThrow();
    const bad = { ...mapping(), columns: { roles: "email" } };
    expect(() => assertAuth0Mapping(bad)).toThrow(/app_metadata or user_metadata/);
  });
});

describe("auth0ImportRows", () => {
  it("matches the guide's jq conversion when the mapping reads roles and org from app_metadata", () => {
    const { prepared, invalid, skipped } = auth0ImportRows(users(), mapping("auth0-map.json"), {
      allowUnverified: false,
    });

    expect(prepared.map((p) => [p.row, p.user])).toEqual([
      [
        1,
        {
          email: "ada@example.com",
          externalId: "auth0|65f1a2b3c4d5e6f7a8b9c0d1",
          roles: ["staff"],
          organizations: [{ slug: "engineering" }],
        },
      ],
      [
        2,
        {
          email: "grace@example.com",
          externalId: "google-oauth2|104857600123456789012",
          roles: ["staff", "manager"],
          organizations: [{ slug: "platform" }],
        },
      ],
      [
        3,
        {
          email: "lin@example.com",
          externalId: "sms|65f1a2b3c4d5e6f7a8b9c0d9",
          phone: "+15555550101",
        },
      ],
      [
        8,
        {
          email: "kai@acme.example",
          externalId: "samlp|acme|kai@acme.example",
          roles: ["staff", "manager"],
        },
      ],
      [9, { email: "ADA@example.com", externalId: "auth0|65f1a2b3c4d5e6f7a8b9c0e4" }],
    ]);
    expect(invalid).toEqual([
      {
        row: 4,
        email: "",
        externalId: "sms|65f1a2b3c4d5e6f7a8b9c0e0",
        detail: "no email address (a phone-only user; add an email in Auth0 before exporting)",
      },
      { row: 5, email: "", externalId: "auth0|65f1a2b3c4d5e6f7a8b9c0e1", detail: "no email address" },
    ]);
    expect(skipped.map((s) => [s.row, s.detail])).toEqual([
      [6, "email not verified in Auth0 (pass --allow-unverified to import it)"],
      [7, "blocked in Auth0"],
    ]);
  });

  it("imports no metadata without a mapping, and unverified users when allowed", () => {
    const { prepared, skipped } = auth0ImportRows(users(), mapping(), { allowUnverified: true });

    expect(prepared.some((p) => p.user.roles || p.user.organizations)).toBe(false);
    expect(prepared.map((p) => p.row)).toContain(6);
    expect(skipped.map((s) => s.row)).toEqual([7]);
  });

  it("adds the mapping's roles and organization roles to every row", () => {
    const withDefaults = {
      ...mapping("auth0-map.json"),
      roles: ["customer"],
      organizationRoles: ["member"],
    };
    const { prepared } = auth0ImportRows(users().slice(0, 1), withDefaults, {
      allowUnverified: false,
    });
    expect(prepared[0].user).toMatchObject({
      roles: ["customer", "staff"],
      organizations: [{ slug: "engineering", roles: ["member"] }],
    });
  });

  it("marks a row without a user_id, or one the import schema refuses, invalid", () => {
    const { invalid } = auth0ImportRows(
      [
        { line: 1, email: "a@example.com" },
        { line: 2, user_id: "auth0|2", email: "not-an-email" },
      ],
      mapping(),
      { allowUnverified: false },
    );
    expect(invalid).toEqual([
      { row: 1, email: "a@example.com", detail: "no user_id (include it in the export fields)" },
      { row: 2, email: "not-an-email", externalId: "auth0|2", detail: expect.stringMatching(/^email:/) },
    ]);
  });
});
