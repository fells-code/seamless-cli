import { APIRequestContext, expect } from "@playwright/test";

import { bearer } from "./conformanceFlows";

// Roles and permissions the permission guard specs depend on, set up through the admin API.
// Everything here is idempotent, because several adapter projects share one instance.

export const READ = "conformance:read";
export const WRITE = "conformance:write";
export const OTHER = "conformance:other";
export const ORG = "conformance:org";

export const READER_ROLE = "conformance-reader";
export const WRITER_ROLE = "conformance-writer";
export const OVERFLOW_ROLE = "conformance-overflow";
export const ORG_ROLE = "conformance-org-member";

// Long enough together to pass the 1 KiB budget, which is what makes a token omit its claims.
const OVERFLOW_PERMISSIONS = Array.from(
  { length: 40 },
  (_, index) => `conformance:overflow:permission-with-a-long-name-${index}`,
);

async function ensurePermission(
  ctx: APIRequestContext,
  admin: string,
  name: string,
) {
  const res = await ctx.post("/admin/permissions", {
    headers: bearer(admin),
    data: { name },
  });
  expect(
    [201, 409],
    `POST /admin/permissions ${name} -> ${res.status()}`,
  ).toContain(res.status());
}

async function ensureInstanceRoles(
  ctx: APIRequestContext,
  admin: string,
  roles: string[],
) {
  const current = await ctx.get("/system-config/admin", {
    headers: bearer(admin),
  });
  expect(
    current.ok(),
    `GET /system-config/admin -> ${current.status()}`,
  ).toBeTruthy();
  const available: string[] = (await current.json()).available_roles;
  const missing = roles.filter((role) => !available.includes(role));

  if (missing.length === 0) return;

  const res = await ctx.patch("/system-config/admin", {
    headers: bearer(admin),
    data: { available_roles: [...available, ...missing] },
  });
  expect(
    res.ok(),
    `PATCH /system-config/admin -> ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

async function ensureOrganizationRole(
  ctx: APIRequestContext,
  admin: string,
  name: string,
) {
  const res = await ctx.post("/admin/organization-roles", {
    headers: bearer(admin),
    data: { name },
  });
  expect(
    [201, 409],
    `POST /admin/organization-roles -> ${res.status()}`,
  ).toContain(res.status());
}

async function setRolePermissions(
  ctx: APIRequestContext,
  admin: string,
  kind: "instance" | "organization",
  role: string,
  permissions: string[],
) {
  const res = await ctx.put(`/admin/roles/${kind}/${role}/permissions`, {
    headers: bearer(admin),
    data: { permissions },
  });
  expect(
    res.ok(),
    `PUT role permissions ${role} -> ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

/** The roles and mappings the specs use. `admin` is a stepped-up owner token. */
export async function ensurePermissionModel(
  ctx: APIRequestContext,
  admin: string,
): Promise<void> {
  for (const name of [READ, WRITE, OTHER, ORG, ...OVERFLOW_PERMISSIONS]) {
    await ensurePermission(ctx, admin, name);
  }

  await ensureInstanceRoles(ctx, admin, [
    READER_ROLE,
    WRITER_ROLE,
    OVERFLOW_ROLE,
  ]);
  await ensureOrganizationRole(ctx, admin, ORG_ROLE);

  await setRolePermissions(ctx, admin, "instance", READER_ROLE, [READ]);
  await setRolePermissions(ctx, admin, "instance", WRITER_ROLE, [WRITE]);
  await setRolePermissions(ctx, admin, "instance", OVERFLOW_ROLE, [
    READ,
    ...OVERFLOW_PERMISSIONS,
  ]);
  await setRolePermissions(ctx, admin, "organization", ORG_ROLE, [ORG, OTHER]);
}

/** A new organization with the user as a member holding `roles`. Returns its id. */
export async function organizationWithMember(
  ctx: APIRequestContext,
  admin: string,
  userId: string,
  roles: string[],
): Promise<string> {
  const created = await ctx.post("/admin/organizations", {
    headers: bearer(admin),
    data: {
      name: `Conformance ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  expect(
    created.ok(),
    `POST /admin/organizations -> ${created.status()}`,
  ).toBeTruthy();
  const organizationId: string = (await created.json()).organization.id;

  const added = await ctx.post(
    `/admin/organizations/${organizationId}/members`,
    {
      headers: bearer(admin),
      // A member without this scope cannot switch to the organization.
      data: { userId, roles, scopes: ["organization:read"] },
    },
  );
  expect(
    added.ok(),
    `add member -> ${added.status()} ${await added.text()}`,
  ).toBeTruthy();

  return organizationId;
}

export async function removeMember(
  ctx: APIRequestContext,
  admin: string,
  organizationId: string,
  userId: string,
): Promise<void> {
  const res = await ctx.delete(
    `/admin/organizations/${organizationId}/members/${userId}`,
    {
      headers: bearer(admin),
    },
  );
  expect(
    res.ok(),
    `remove member -> ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}
