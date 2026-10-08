import { describe, expect, it } from "vitest";
import type { AuthClient } from "./authClient.js";
import type { ApiResponse } from "./http.js";
import {
  addMember,
  AdminApiError,
  createOrg,
  deleteUser,
  getOrg,
  getUserDetail,
  listMembers,
  listOrgs,
  listUsers,
  PermissionError,
  prepareDeviceReplacement,
  removeMember,
  updateMember,
  updateOrg,
} from "./admin.js";
import {
  apiCredential,
  apiMembership,
  apiOrg,
  apiUser,
  apiUserDetail,
} from "./admin.fixtures.js";

function response<T>(status: number, data: T | null): ApiResponse<T> {
  return { ok: status >= 200 && status < 300, status, data, headers: new Headers() };
}

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

function fakeClient(
  handler: (rec: Recorded) => ApiResponse<unknown>,
): { client: AuthClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const record = (method: string, path: string, init?: RequestInit) => {
    const rec: Recorded = {
      method,
      path,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(rec);
    return handler(rec);
  };
  return {
    calls,
    client: {
      profile: { name: "default", instanceUrl: "https://auth.example.com" },
      get: async (path) => record("GET", path) as never,
      post: async (path) => record("POST", path) as never,
      request: async (path, init) =>
        record((init?.method ?? "GET").toUpperCase(), path, init) as never,
    },
  };
}

describe("users", () => {
  it("lists users", async () => {
    const { client } = fakeClient(({ method, path }) => {
      expect(`${method} ${path}`).toBe("GET /admin/users");
      return response(200, { users: [apiUser()], total: 1 });
    });
    expect(await listUsers(client)).toEqual({ users: [apiUser()], total: 1 });
  });

  // The shared user schema is strict, which suits the API's own response tests but
  // would reject every user from an instance that has added a field since.
  it("keeps a user field this CLI's types do not know", async () => {
    const { client } = fakeClient(() =>
      response(200, { users: [{ ...apiUser(), addedLater: true }], total: 1 }),
    );
    const { users } = await listUsers(client);
    expect(users[0]).toMatchObject({ id: "u1", addedLater: true });
  });

  it("fails on a user it cannot read, naming the field", async () => {
    const { client } = fakeClient(() =>
      response(200, { users: [apiUser(), { id: "u2" }], total: 2 }),
    );
    await expect(listUsers(client)).rejects.toThrow(
      /a user list this CLI cannot read \(users\.1\.email: /,
    );
  });

  it("fails on a list response with no body", async () => {
    const { client } = fakeClient(() => response(200, null));
    await expect(listUsers(client)).rejects.toThrow(/\(response: /);
  });

  it("sends limit and offset as query params", async () => {
    const { client } = fakeClient(({ path }) => {
      expect(path).toBe("/admin/users?limit=10&offset=20");
      return response(200, { users: [], total: 30 });
    });
    await listUsers(client, { limit: 10, offset: 20 });
  });

  it("keeps a zero limit or offset in the query rather than dropping it", async () => {
    const { client } = fakeClient(({ path }) => {
      expect(path).toBe("/admin/users?limit=0&offset=0");
      return response(200, { users: [], total: 30 });
    });
    await listUsers(client, { limit: 0, offset: 0 });
  });

  it("deletes a user via the body userId", async () => {
    const { client, calls } = fakeClient(() => response(200, { message: "ok" }));
    await deleteUser(client, "u1");
    expect(calls[0]).toEqual({
      method: "DELETE",
      path: "/admin/users",
      body: { userId: "u1" },
    });
  });

  it("maps a 404 delete to a clear error", async () => {
    const { client } = fakeClient(() => response(404, { error: "User not found." }));
    await expect(deleteUser(client, "missing")).rejects.toThrow(/No user found/);
  });

  it("reads credentials from the user detail endpoint", async () => {
    const { client } = fakeClient(({ path }) => {
      expect(path).toBe("/admin/users/u1");
      return response(
        200,
        apiUserDetail([apiCredential({ id: "c1" }), apiCredential({ id: "c2" })]),
      );
    });
    const detail = await getUserDetail(client, "u1");
    expect(detail.credentials).toHaveLength(2);
  });

  it("explains the step-up requirement for device replacement", async () => {
    const { client, calls } = fakeClient(() => response(401, { error: "step up" }));
    await expect(
      prepareDeviceReplacement(client, "u1", {
        revokeSessions: true,
        removePasskeys: true,
        disableTotp: true,
      }),
    ).rejects.toThrow(/step-up/i);
    expect(calls[0].path).toBe("/admin/users/u1/recovery/device-replacement");
    expect(calls[0].body).toEqual({
      revokeSessions: true,
      removePasskeys: true,
      disableTotp: true,
    });
  });

  it("maps 403 to a PermissionError", async () => {
    const { client } = fakeClient(() => response(403, { error: "Forbidden" }));
    await expect(listUsers(client)).rejects.toBeInstanceOf(PermissionError);
  });

  it("returns the counts from a successful device replacement", async () => {
    const counts = {
      userId: "u1",
      revokedSessions: 2,
      removedCredentials: 1,
      disabledTotpCredentials: 0,
    };
    const { client } = fakeClient(() => response(200, counts));
    const result = await prepareDeviceReplacement(client, "u1", {
      revokeSessions: true,
      removePasskeys: false,
      disableTotp: false,
    });
    expect(result).toEqual(counts);
  });

  it("maps a generic failure on device replacement to an AdminApiError", async () => {
    const { client } = fakeClient(() => response(500, { error: "boom" }));
    await expect(
      prepareDeviceReplacement(client, "u1", {
        revokeSessions: false,
        removePasskeys: false,
        disableTotp: false,
      }),
    ).rejects.toThrow(/Could not prepare device replacement/);
  });
});

describe("organizations", () => {
  it("lists organizations", async () => {
    const { client } = fakeClient(({ path }) => {
      expect(path).toBe("/admin/organizations");
      return response(200, { organizations: [apiOrg()], total: 1 });
    });
    expect(await listOrgs(client)).toEqual({
      organizations: [apiOrg()],
      total: 1,
    });
  });

  it("sends limit, offset and search as query params", async () => {
    const { client } = fakeClient(({ path }) => {
      expect(path).toBe("/admin/organizations?limit=10&offset=20&search=acme+co");
      return response(200, { organizations: [], total: 0 });
    });
    await listOrgs(client, { limit: 10, offset: 20, search: "acme co" });
  });

  it.each([
    [
      "listing organizations",
      (c: AuthClient) => listOrgs(c),
      /Could not list organizations \(500\)/,
    ],
    [
      "listing members",
      (c: AuthClient) => listMembers(c, "o1"),
      /Could not list members \(500\)/,
    ],
    [
      "removing a member",
      (c: AuthClient) => removeMember(c, "o1", "u1"),
      /Could not remove member \(500\)/,
    ],
  ])("reports the status when %s fails", async (_label, run, message) => {
    const { client } = fakeClient(() => response(500, { error: "boom" }));
    await expect(run(client)).rejects.toThrow(message);
  });

  it("creates an org and unwraps the envelope", async () => {
    const { client, calls } = fakeClient(() =>
      response(201, { organization: apiOrg() }),
    );
    const org = await createOrg(client, { name: "Acme" });
    expect(org).toEqual(apiOrg());
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/admin/organizations",
      body: { name: "Acme" },
    });
  });

  it("updates an org", async () => {
    const { client, calls } = fakeClient(() =>
      response(200, { organization: apiOrg({ name: "New" }) }),
    );
    await updateOrg(client, "o1", { name: "New" });
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: "/admin/organizations/o1",
      body: { name: "New" },
    });
  });

  it("lists members and adds one by email", async () => {
    const { client } = fakeClient(({ method, path }) => {
      if (method === "GET") {
        expect(path).toBe("/admin/organizations/o1/members");
        return response(200, { members: [apiMembership()], total: 1 });
      }
      return response(201, {
        membership: apiMembership({ userId: "u2", roles: ["member"] }),
      });
    });

    expect((await listMembers(client, "o1")).total).toBe(1);
    const membership = await addMember(client, "o1", { email: "x@example.com" });
    expect(membership).toMatchObject({ userId: "u2", roles: ["member"] });
  });

  it("updates and removes a member with encoded paths", async () => {
    const { client, calls } = fakeClient(({ method }) =>
      method === "PATCH"
        ? response(200, { membership: apiMembership({ roles: ["admin"] }) })
        : response(200, { message: "ok" }),
    );

    await updateMember(client, "o1", "u1", { roles: ["admin"] });
    await removeMember(client, "o1", "u1");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /admin/organizations/o1/members/u1",
      "DELETE /admin/organizations/o1/members/u1",
    ]);
  });

  it("maps a 404 org to a clear error", async () => {
    const { client } = fakeClient(() => response(404, { error: "not found" }));
    await expect(updateOrg(client, "missing", { name: "x" })).rejects.toBeInstanceOf(
      AdminApiError,
    );
  });

  it("gets a single org and unwraps the envelope", async () => {
    const { client } = fakeClient(({ path }) => {
      expect(path).toBe("/admin/organizations/o1");
      return response(200, { organization: apiOrg() });
    });
    expect(await getOrg(client, "o1")).toEqual(apiOrg());
  });

  it("fails on an ok envelope with no organization in it", async () => {
    const { client } = fakeClient(() => response(200, {}));
    await expect(getOrg(client, "o1")).rejects.toThrow(
      /an organization this CLI cannot read \(organization: /,
    );
  });

  it("keeps an organization field this CLI's types do not know", async () => {
    const { client } = fakeClient(() =>
      response(200, { organization: { ...apiOrg(), addedLater: 1 } }),
    );
    expect(await getOrg(client, "o1")).toMatchObject({ addedLater: 1 });
  });

  it("maps a 404 get org to a clear error", async () => {
    const { client } = fakeClient(() => response(404, { error: "not found" }));
    await expect(getOrg(client, "missing")).rejects.toThrow(/No organization found/);
  });

  it("throws from the org envelope when the response is not ok", async () => {
    const { client } = fakeClient(() => response(500, { error: "boom" }));
    await expect(createOrg(client, { name: "Acme" })).rejects.toBeInstanceOf(
      AdminApiError,
    );
  });

  it("maps a 404 on listMembers to a clear error", async () => {
    const { client } = fakeClient(() => response(404, { error: "not found" }));
    await expect(listMembers(client, "missing")).rejects.toThrow(
      /No organization found/,
    );
  });

  it("throws from the membership envelope when the response is not ok", async () => {
    const { client } = fakeClient(() => response(500, { error: "boom" }));
    await expect(addMember(client, "o1", { email: "x@example.com" })).rejects.toBeInstanceOf(
      AdminApiError,
    );
  });

  it("maps a 404 on addMember to a clear error", async () => {
    const { client } = fakeClient(() => response(404, { error: "not found" }));
    await expect(
      addMember(client, "missing", { email: "x@example.com" }),
    ).rejects.toThrow(/No organization found/);
  });

  it("maps a 404 on updateMember to a clear error", async () => {
    const { client } = fakeClient(() => response(404, { error: "not found" }));
    await expect(
      updateMember(client, "o1", "missing", { roles: ["admin"] }),
    ).rejects.toThrow(/No such organization or member/);
  });

  it("maps a 404 on removeMember to a clear error", async () => {
    const { client } = fakeClient(() => response(404, { error: "not found" }));
    await expect(removeMember(client, "o1", "missing")).rejects.toThrow(
      /No such organization or member/,
    );
  });
});
