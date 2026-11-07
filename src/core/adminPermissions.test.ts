import { describe, expect, it } from "vitest";
import type { AuthClient } from "./authClient.js";
import type { ApiResponse } from "./http.js";
import {
  AdminApiError,
  createOrganizationRole,
  createPermission,
  deleteOrganizationRole,
  deletePermission,
  listPermissions,
  listRoles,
  PERMISSIONS_UNSUPPORTED_MESSAGE,
  setRolePermissions,
  updateOrganizationRole,
  updatePermission,
} from "./admin.js";
import { StepUpError } from "./stepUp.js";
import { apiPermission, apiRole } from "./admin.fixtures.js";

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

// What an instance from before v0.23 answers for a route it does not have.
const routeMissing = () => response(404, { error: "Not Found" });

async function message(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdminApiError);
  return (err as Error).message;
}

describe("permissions", () => {
  it("lists the catalogue", async () => {
    const { client, calls } = fakeClient(() =>
      response(200, { permissions: [apiPermission({ extra: 1 } as never)], total: 1 }),
    );
    const list = await listPermissions(client);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/admin/permissions" });
    expect(list.total).toBe(1);
    expect(list.permissions[0]).toMatchObject({ name: "invoices:read", extra: 1 });
  });

  it("creates a permission", async () => {
    const { client, calls } = fakeClient(() =>
      response(201, { permission: apiPermission({ description: "Read" }) }),
    );
    const permission = await createPermission(client, {
      name: "invoices:read",
      description: "Read",
    });
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/admin/permissions",
      body: { name: "invoices:read", description: "Read" },
    });
    expect(permission.description).toBe("Read");
  });

  it("names the duplicate on a 409", async () => {
    const { client } = fakeClient(() =>
      response(409, { error: "Permission already exists" }),
    );
    expect(await message(createPermission(client, { name: "invoices:read" }))).toBe(
      "A permission named invoices:read already exists (409: Permission already exists).",
    );
  });

  it("reports any other failure to create", async () => {
    const { client } = fakeClient(() => response(500, null));
    expect(await message(createPermission(client, { name: "a" }))).toBe(
      "Could not create permission (500).",
    );
  });

  it("updates a description, encoding the name in the path", async () => {
    const { client, calls } = fakeClient(() =>
      response(200, { permission: apiPermission({ name: "a:b" }) }),
    );
    await updatePermission(client, "a:b", { description: null });
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: "/admin/permissions/a%3Ab",
      body: { description: null },
    });
  });

  it("names a missing permission on update and delete", async () => {
    const { client } = fakeClient(() => response(404, { error: "Permission not found" }));
    expect(await message(updatePermission(client, "x", { description: null }))).toBe(
      "No permission named x (404: Permission not found).",
    );
    expect(await message(deletePermission(client, "x"))).toBe(
      "No permission named x (404: Permission not found).",
    );
  });

  it("reports any other failure to update", async () => {
    const { client } = fakeClient(() => response(400, { error: "Bad request" }));
    expect(await message(updatePermission(client, "x", { description: null }))).toBe(
      "Could not update permission (400: Bad request).",
    );
  });

  it("deletes a permission", async () => {
    const { client, calls } = fakeClient(() => response(200, { message: "Success" }));
    await deletePermission(client, "invoices:read");
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      path: "/admin/permissions/invoices%3Aread",
    });
  });

  it("names the roles that still grant a permission it cannot delete", async () => {
    const { client } = fakeClient(() =>
      response(409, {
        error: "Permission is still granted by a role",
        details: {
          roles: [
            { kind: "instance", name: "admin" },
            { kind: "organization", name: "billing" },
          ],
        },
      }),
    );
    expect(await message(deletePermission(client, "invoices:read"))).toBe(
      "Could not delete permission invoices:read (409: Permission is still granted by a role), roles: instance role admin, organization role billing.",
    );
  });

  it("parses a list it cannot read into a named error", async () => {
    const { client } = fakeClient(() => response(200, { permissions: [{}], total: 1 }));
    expect(await message(listPermissions(client))).toMatch(
      /^The instance returned a permission list this CLI cannot read \(permissions\.0\.id: /,
    );
  });

  it("reports a failed list", async () => {
    const { client } = fakeClient(() => response(500, { message: "boom." }));
    expect(await message(listPermissions(client))).toBe(
      "Could not list permissions (500: boom).",
    );
  });
});

describe("roles", () => {
  it("lists both kinds", async () => {
    const roles = [
      apiRole({ name: "admin", kind: "instance", permissions: ["a"] }),
      apiRole(),
    ];
    const { client, calls } = fakeClient(() => response(200, { roles }));
    expect(await listRoles(client)).toEqual(roles);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/admin/roles" });
  });

  it("reports a failed list", async () => {
    const { client } = fakeClient(() => response(500, null));
    expect(await message(listRoles(client))).toBe("Could not list roles (500).");
  });

  it("replaces a role's permissions", async () => {
    const role = apiRole({ permissions: ["invoices:read"] });
    const { client, calls } = fakeClient(() => response(200, { role }));
    expect(
      await setRolePermissions(client, "organization", "billing", ["invoices:read"]),
    ).toEqual(role);
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/admin/roles/organization/billing/permissions",
      body: { permissions: ["invoices:read"] },
    });
  });

  it("names a missing role on set", async () => {
    const { client } = fakeClient(() => response(404, { error: "Role not found" }));
    expect(await message(setRolePermissions(client, "instance", "ghost", []))).toBe(
      "No instance role named ghost (404: Role not found).",
    );
  });

  it("names the permissions that do not exist", async () => {
    const { client } = fakeClient(() =>
      response(400, {
        error: "Unknown permissions",
        details: { permissions: ["nope", "never"] },
      }),
    );
    expect(
      await message(setRolePermissions(client, "instance", "admin", ["nope", "never"])),
    ).toBe(
      "Could not set the permissions of admin (400: Unknown permissions), permissions: nope, never.",
    );
  });

  it("creates an organization role", async () => {
    const role = apiRole({ permissions: ["a"] });
    const { client, calls } = fakeClient(() => response(201, { role }));
    expect(
      await createOrganizationRole(client, { name: "billing", permissions: ["a"] }),
    ).toEqual(role);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/admin/organization-roles",
      body: { name: "billing", permissions: ["a"] },
    });
  });

  it("reports a role that already exists", async () => {
    const { client } = fakeClient(() =>
      response(409, { error: "Organization role already exists" }),
    );
    expect(await message(createOrganizationRole(client, { name: "billing" }))).toBe(
      "Could not create organization role (409: Organization role already exists).",
    );
  });

  it("updates an organization role", async () => {
    const role = apiRole({ description: "Pays" });
    const { client, calls } = fakeClient(() => response(200, { role }));
    expect(
      await updateOrganizationRole(client, "billing", { description: "Pays" }),
    ).toEqual(role);
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: "/admin/organization-roles/billing",
      body: { description: "Pays" },
    });
  });

  it("names a missing organization role on update and delete", async () => {
    const { client } = fakeClient(() => response(404, { error: "Role not found" }));
    expect(
      await message(updateOrganizationRole(client, "ghost", { description: null })),
    ).toBe("No organization role named ghost (404: Role not found).");
    expect(await message(deleteOrganizationRole(client, "ghost"))).toBe(
      "No organization role named ghost (404: Role not found).",
    );
  });

  it("reports any other failure to update", async () => {
    const { client } = fakeClient(() => response(500, null));
    expect(
      await message(updateOrganizationRole(client, "billing", { description: null })),
    ).toBe("Could not update organization role (500).");
  });

  it("deletes an organization role", async () => {
    const { client, calls } = fakeClient(() => response(200, { message: "Success" }));
    await deleteOrganizationRole(client, "billing");
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      path: "/admin/organization-roles/billing",
    });
  });

  it("says how many memberships still hold a role it cannot delete", async () => {
    const one = fakeClient(() =>
      response(409, { error: "Organization role is still held", details: { holders: 1 } }),
    );
    expect(await message(deleteOrganizationRole(one.client, "billing"))).toBe(
      "Could not delete organization role billing (409: Organization role is still held), held by 1 membership.",
    );

    const many = fakeClient(() =>
      response(409, { error: "Organization role is still held", details: { holders: 3 } }),
    );
    expect(await message(deleteOrganizationRole(many.client, "billing"))).toMatch(
      /held by 3 memberships\.$/,
    );
  });

  it("prints detail it does not recognise as it came", async () => {
    const { client } = fakeClient(() =>
      response(409, { error: "Conflict", details: { reason: "other", empty: {} } }),
    );
    expect(await message(deleteOrganizationRole(client, "billing"))).toBe(
      "Could not delete organization role billing (409: Conflict), reason: other; empty: [object Object].",
    );
  });

  it("ignores details that are absent or not an object", async () => {
    for (const data of [{ error: "Built in", details: "x" }, "plain", { details: {} }]) {
      const { client } = fakeClient(() => response(409, data));
      expect(await message(deleteOrganizationRole(client, "owner"))).toMatch(
        /^Could not delete organization role owner \(409(: Built in)?\)\.$/,
      );
    }
  });
});

describe("an instance before v0.23", () => {
  const calls: Array<[string, (client: AuthClient) => Promise<unknown>]> = [
    ["permissions list", (c) => listPermissions(c)],
    ["permissions create", (c) => createPermission(c, { name: "a" })],
    ["permissions update", (c) => updatePermission(c, "a", { description: null })],
    ["permissions delete", (c) => deletePermission(c, "a")],
    ["roles list", (c) => listRoles(c)],
    ["roles set", (c) => setRolePermissions(c, "instance", "admin", [])],
    ["roles create", (c) => createOrganizationRole(c, { name: "billing" })],
    ["roles update", (c) => updateOrganizationRole(c, "billing", { description: null })],
    ["roles delete", (c) => deleteOrganizationRole(c, "billing")],
  ];

  it.each(calls)("%s says the instance needs v0.23", async (_name, run) => {
    const { client } = fakeClient(routeMissing);
    expect(await message(run(client))).toBe(PERMISSIONS_UNSUPPORTED_MESSAGE);
  });

  it("treats any 404 on a collection route as a missing route", async () => {
    const { client } = fakeClient(() => response(404, null));
    expect(await message(listRoles(client))).toBe(PERMISSIONS_UNSUPPORTED_MESSAGE);
  });
});

describe("authorization", () => {
  it("maps a step-up 403 to a StepUpError", async () => {
    const { client } = fakeClient(() =>
      response(403, { error: "step_up_required", fresh: false, maxAgeSeconds: 300 }),
    );
    await expect(deletePermission(client, "a")).rejects.toBeInstanceOf(StepUpError);
  });
});
