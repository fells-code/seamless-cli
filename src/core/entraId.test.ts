import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  entraCredentialsFromEnv,
  getGraphToken,
  GRAPH_ORIGIN,
  listEntraUsers,
  loadGroupMapping,
  resolveGroupGrants,
  toImportRows,
  type EntraUser,
} from "./entraId.js";

const GROUP_A = "11111111-1111-1111-1111-111111111111";
const GROUP_B = "22222222-2222-2222-2222-222222222222";
const ORG_ID = "33333333-3333-3333-3333-333333333333";

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const creds = { tenantId: "contoso.onmicrosoft.com", clientId: "client", clientSecret: "s3cret" };

describe("entraCredentialsFromEnv", () => {
  it("reads the three variables", () => {
    expect(
      entraCredentialsFromEnv({
        ENTRA_TENANT_ID: " tenant-id ",
        ENTRA_CLIENT_ID: "client",
        ENTRA_CLIENT_SECRET: "secret",
      }),
    ).toEqual({ tenantId: "tenant-id", clientId: "client", clientSecret: "secret" });
  });

  it("names every missing variable", () => {
    expect(() => entraCredentialsFromEnv({ ENTRA_TENANT_ID: "t" })).toThrow(
      /ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET/,
    );
  });

  it("refuses a tenant id that would change the sign-in URL's path", () => {
    expect(() =>
      entraCredentialsFromEnv({
        ENTRA_TENANT_ID: "../common",
        ENTRA_CLIENT_ID: "c",
        ENTRA_CLIENT_SECRET: "s",
      }),
    ).toThrow(/tenant/);
  });
});

describe("getGraphToken", () => {
  it("asks for an app-only Graph token with the client credentials grant", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { access_token: "tok" }));

    await expect(getGraphToken(creds, { fetch: fetchMock })).resolves.toBe("tok");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token",
    );
    const body = new URLSearchParams(init.body);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(body.get("client_secret")).toBe("s3cret");
  });

  it("reports Microsoft's reason without the secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(401, {
        error: "invalid_client",
        error_description: "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: abc",
      }),
    );

    const err = await getGraphToken(creds, { fetch: fetchMock }).catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "Microsoft sign-in for the app registration failed: AADSTS7000215: Invalid client secret provided.",
    );
    expect((err as Error).message).not.toContain("s3cret");
  });
});

describe("listEntraUsers", () => {
  it("follows every page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(200, {
          value: [{ id: "1" }],
          "@odata.nextLink": `${GRAPH_ORIGIN}/v1.0/users?$skiptoken=abc`,
        }),
      )
      .mockResolvedValueOnce(json(200, { value: [{ id: "2" }] }));

    const users = await listEntraUsers("tok", undefined, { fetch: fetchMock });

    expect(users.map((u) => u.id)).toEqual(["1", "2"]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${GRAPH_ORIGIN}/v1.0/users?$select=id,mail,userPrincipalName,mobilePhone,accountEnabled,userType&$top=999`,
    );
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer tok");
  });

  it("reads a group's members, nested groups included", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { value: [] }));

    await listEntraUsers("tok", GROUP_A, { fetch: fetchMock });

    expect(fetchMock.mock.calls[0][0]).toContain(
      `/v1.0/groups/${GROUP_A}/transitiveMembers/microsoft.graph.user?`,
    );
  });

  it("will not send the token to a next page off Graph", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      json(200, { value: [], "@odata.nextLink": "https://evil.example/v1.0/users" }),
    );

    await expect(listEntraUsers("tok", undefined, { fetch: fetchMock })).rejects.toThrow(
      /outside https:\/\/graph.microsoft.com/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits out throttling, honouring Retry-After", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}, { "Retry-After": "3" }))
      .mockResolvedValueOnce(json(200, { value: [{ id: "1" }] }));

    const users = await listEntraUsers("tok", undefined, { fetch: fetchMock, sleep });

    expect(users).toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("names the permissions when Graph refuses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(403, { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges." } }),
    );

    await expect(listEntraUsers("tok", undefined, { fetch: fetchMock })).rejects.toThrow(
      /User\.Read\.All.*admin consent.*Insufficient privileges/,
    );
  });

  it("refuses a group id that is not an object id", async () => {
    await expect(listEntraUsers("tok", "engineering", { fetch: vi.fn() })).rejects.toThrow(
      /not an Entra ID group object id/,
    );
  });
});

describe("loadGroupMapping", () => {
  const write = (body: unknown) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "entra-map-")), "groups.json");
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  };

  it("reads organization and role grants", () => {
    expect(
      loadGroupMapping(
        write({
          groups: [
            { id: GROUP_A, organization: "engineering", organizationRoles: ["member"] },
            { id: GROUP_B, roles: ["staff"] },
          ],
        }),
      ),
    ).toEqual([
      { id: GROUP_A, organization: "engineering", organizationRoles: ["member"] },
      { id: GROUP_B, roles: ["staff"] },
    ]);
  });

  it("refuses a group that grants nothing", () => {
    expect(() => loadGroupMapping(write({ groups: [{ id: GROUP_A }] }))).toThrow(
      /grants nothing/,
    );
  });

  it("refuses a group named rather than given by id", () => {
    expect(() =>
      loadGroupMapping(write({ groups: [{ id: "Engineering", roles: ["staff"] }] })),
    ).toThrow(/not an Entra ID group object id/);
  });
});

describe("resolveGroupGrants", () => {
  it("collects each user's organizations and roles across groups", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { value: [{ id: "u1" }, { id: "u2" }] }))
      .mockResolvedValueOnce(json(200, { value: [{ id: "u1" }] }));

    const grants = await resolveGroupGrants(
      "tok",
      [
        { id: GROUP_A, organization: ORG_ID, organizationRoles: ["member"] },
        { id: GROUP_B, organization: "sales", roles: ["staff"] },
      ],
      { fetch: fetchMock },
    );

    expect(grants.get("u1")).toEqual({
      roles: ["staff"],
      organizations: [{ organizationId: ORG_ID, roles: ["member"] }, { slug: "sales" }],
    });
    expect(grants.get("u2")).toEqual({
      roles: [],
      organizations: [{ organizationId: ORG_ID, roles: ["member"] }],
    });
  });
});

describe("toImportRows", () => {
  const options = { allowUpn: false, includeGuests: false };

  it("keeps the object id as externalId and compacts the phone", () => {
    const users: EntraUser[] = [
      { id: "u1", mail: "ada@contoso.com", mobilePhone: "+1 (425) 555-0100", accountEnabled: true },
    ];
    const grants = new Map([["u1", { roles: ["staff"], organizations: [{ slug: "eng" }] }]]);

    const { prepared } = toImportRows(users, grants, options);

    expect(prepared).toEqual([
      {
        row: 1,
        user: {
          externalId: "u1",
          email: "ada@contoso.com",
          phone: "+14255550100",
          roles: ["staff"],
          organizations: [{ slug: "eng" }],
        },
      },
    ]);
  });

  it("skips disabled accounts and guests, and reports them", () => {
    const { prepared, skipped } = toImportRows(
      [
        { id: "u1", mail: "off@contoso.com", accountEnabled: false },
        { id: "u2", mail: "guest@partner.com", userType: "Guest", accountEnabled: true },
      ],
      new Map(),
      options,
    );

    expect(prepared).toEqual([]);
    expect(skipped.map((s) => s.detail)).toEqual([
      "disabled in Entra ID",
      "guest account (pass --include-guests to import guests)",
    ]);
  });

  it("imports guests when asked", () => {
    const { prepared } = toImportRows(
      [{ id: "u2", mail: "guest@partner.com", userType: "Guest" }],
      new Map(),
      { ...options, includeGuests: true },
    );
    expect(prepared).toHaveLength(1);
  });

  it("falls back to the userPrincipalName only when allowed", () => {
    const users: EntraUser[] = [{ id: "u1", mail: null, userPrincipalName: "ada@contoso.com" }];

    const strict = toImportRows(users, new Map(), options);
    expect(strict.prepared).toEqual([]);
    expect(strict.invalid[0].detail).toMatch(/--allow-upn/);

    const lenient = toImportRows(users, new Map(), { ...options, allowUpn: true });
    expect(lenient.prepared[0].user.email).toBe("ada@contoso.com");
  });

  it("reports a row the import schema refuses", () => {
    const { invalid } = toImportRows(
      [{ id: "u1", mail: "not-an-email" }],
      new Map(),
      options,
    );
    expect(invalid[0]).toMatchObject({ row: 1, externalId: "u1" });
    expect(invalid[0].detail).toMatch(/^email:/);
  });
});

describe("Graph failures", () => {
  it("says when Microsoft sign-in or Graph cannot be reached", async () => {
    const down = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));

    await expect(getGraphToken(creds, { fetch: down })).rejects.toThrow(
      /Could not reach Microsoft sign-in/,
    );
    await expect(listEntraUsers("tok", undefined, { fetch: down })).rejects.toThrow(
      /Could not reach Microsoft Graph/,
    );
  });

  it("reports a failed request with Graph's message, and a body that is not JSON", async () => {
    const failing = vi
      .fn()
      .mockResolvedValueOnce(json(500, { error: { message: "Service unavailable." } }))
      .mockResolvedValueOnce(new Response("<html>", { status: 502 }));

    await expect(listEntraUsers("tok", undefined, { fetch: failing })).rejects.toThrow(
      "Microsoft Graph request failed (500). Service unavailable.",
    );
    await expect(listEntraUsers("tok", undefined, { fetch: failing })).rejects.toThrow(
      "Microsoft Graph request failed (502).",
    );
  });

  it("gives up after repeated throttling", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const throttled = vi.fn().mockImplementation(async () => json(429, {}));

    await expect(
      listEntraUsers("tok", undefined, { fetch: throttled, sleep }),
    ).rejects.toThrow(/\(429\)/);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
  });
});

describe("loadGroupMapping validation", () => {
  const write = (body: string) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "entra-map-")), "groups.json");
    fs.writeFileSync(file, body);
    return file;
  };

  it.each([
    ["{", /Could not read the group mapping/],
    [JSON.stringify({ groups: [] }), /non-empty "groups" list/],
    [JSON.stringify({ groups: [{ roles: ["staff"] }] }), /groups\[0\]\.id must be/],
    [
      JSON.stringify({ groups: [{ id: GROUP_A, organization: 7 }] }),
      /groups\[0\]\.organization must be/,
    ],
    [
      JSON.stringify({ groups: [{ id: GROUP_A, roles: "staff" }] }),
      /groups\[0\]\.roles must be a list of strings/,
    ],
  ])("refuses %s", (body, message) => {
    expect(() => loadGroupMapping(write(body))).toThrow(message);
  });
});
