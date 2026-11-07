import {
  AdminOrganizationListResponseSchema,
  AdminUserDetailResponseSchema,
  ApiUserSchema,
  AuthEventSchema,
  CredentialResponseSchema,
  DeviceReplacementRecoveryResponseSchema,
  OrganizationMembersResponseSchema,
  OidcApplicationCreatedResponseSchema,
  OidcApplicationListResponseSchema,
  OidcApplicationResourcesResponseSchema,
  OidcApplicationResponseSchema,
  OidcApplicationSecretResponseSchema,
  OidcResourceListResponseSchema,
  OidcResourceResponseSchema,
  OrganizationMembershipSchema,
  OrganizationSchema,
  PermissionEnvelopeResponseSchema,
  PermissionListResponseSchema,
  PermissionSchema,
  RoleDefinitionSchema,
  RoleEnvelopeResponseSchema,
  RoleListResponseSchema,
  SessionSchema,
  UsersListResponseSchema,
  type AddOrganizationMemberRequest,
  type CreateOrganizationRequest,
  type CreateOrganizationRoleRequest,
  type CreatePermissionRequest,
  type DeviceReplacementRecoveryRequest,
  type DeviceReplacementRecoveryResponse,
  type OidcApplication,
  type OidcApplicationCreatedResponse,
  type OidcApplicationCreateRequest,
  type OidcApplicationKeysRequest,
  type OidcApplicationResource,
  type OidcApplicationResourceGrant,
  type OidcApplicationSecretResponse,
  type OidcApplicationUpdateRequest,
  type OidcResource,
  type OidcResourceCreateRequest,
  type OidcResourceUpdateRequest,
  type RoleKind,
  type UpdateOrganizationMemberRequest,
  type UpdateOrganizationRequest,
  type UpdateOrganizationRoleRequest,
  type UpdatePermissionRequest,
} from "@seamless-auth/types";
import { z } from "zod";
import type { AuthClient } from "./authClient.js";
import type { ApiResponse } from "./http.js";
import { PermissionError } from "./permissionError.js";
import { forbidden } from "./stepUp.js";

export { PermissionError };

export class AdminApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminApiError";
  }
}

// Responses are parsed with the shared schemas, loosened so a key the schema does
// not know is kept rather than stripped or, for the strict user schema, rejected.
// An instance newer than this CLI's types then still lists, and `--json` prints
// everything the instance sent.
const UserSchema = ApiUserSchema.loose();

const MembershipSchema = OrganizationMembershipSchema.extend({
  user: OrganizationMembershipSchema.shape.user.unwrap().loose().optional(),
}).loose();

const OrgSchema = OrganizationSchema.extend({
  membership: MembershipSchema.optional(),
}).loose();

const UserListSchema = UsersListResponseSchema.extend({
  users: z.array(UserSchema),
});

const UserDetailSchema = AdminUserDetailResponseSchema.extend({
  user: UserSchema,
  sessions: z.array(SessionSchema.loose()),
  credentials: z.array(CredentialResponseSchema.loose()),
  events: z.array(AuthEventSchema.loose()),
});

const OrgListSchema = AdminOrganizationListResponseSchema.extend({
  organizations: z.array(OrgSchema),
});

const MemberListSchema = OrganizationMembersResponseSchema.extend({
  members: z.array(MembershipSchema),
});

export type AdminUser = z.infer<typeof UserSchema>;
export type AdminCredential = z.infer<typeof CredentialResponseSchema>;
export type AdminOrganization = z.infer<typeof OrgSchema>;
export type AdminMembership = z.infer<typeof MembershipSchema>;

function parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.join(".") || "response";
    throw new AdminApiError(
      `The instance returned ${what} this CLI cannot read (${where}: ${issue.message}).`,
    );
  }
  return parsed.data;
}

function apiMessage(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const value of [record.error, record.message]) {
      if (typeof value === "string" && value.trim()) {
        return value.trim().replace(/\.$/, "");
      }
    }
  }
  return undefined;
}

function apiError(res: ApiResponse<unknown>, summary: string): AdminApiError {
  const detail = apiMessage(res.data);
  return new AdminApiError(
    `${summary} (${res.status}${detail ? `: ${detail}` : ""}).`,
  );
}

async function call<T>(
  client: AuthClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  let res: ApiResponse<T>;
  if (method === "GET") {
    res = await client.get<T>(path);
  } else {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    res = await client.request<T>(path, init);
  }
  if (res.status === 403) throw forbidden(res);
  return res;
}

// Users

export type UserList = z.infer<typeof UserListSchema>;

export interface ListUsersOptions {
  limit?: number;
  offset?: number;
}

export async function listUsers(
  client: AuthClient,
  opts: ListUsersOptions = {},
): Promise<UserList> {
  const query = new URLSearchParams();
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  if (opts.offset !== undefined) query.set("offset", String(opts.offset));
  const suffix = query.size ? `?${query}` : "";

  const res = await call<unknown>(client, "GET", `/admin/users${suffix}`);
  if (!res.ok) throw apiError(res, "Could not list users");
  // `total` counts every user, not just this page, so callers can report position.
  return parse(UserListSchema, res.data, "a user list");
}

export async function deleteUser(client: AuthClient, id: string): Promise<void> {
  const res = await call(client, "DELETE", "/admin/users", { userId: id });
  if (res.status === 404) throw apiError(res, `No user found with id ${id}`);
  if (!res.ok) throw apiError(res, "Could not delete user");
}

export type UserDetail = z.infer<typeof UserDetailSchema>;

export async function getUserDetail(
  client: AuthClient,
  id: string,
): Promise<UserDetail> {
  const res = await call<unknown>(
    client,
    "GET",
    `/admin/users/${encodeURIComponent(id)}`,
  );
  if (res.status === 404) throw apiError(res, `No user found with id ${id}`);
  if (!res.ok) throw apiError(res, "Could not load user");
  return parse(UserDetailSchema, res.data, "a user");
}

export type DeviceReplacementOptions = DeviceReplacementRecoveryRequest;

export async function prepareDeviceReplacement(
  client: AuthClient,
  id: string,
  opts: DeviceReplacementOptions,
): Promise<DeviceReplacementRecoveryResponse> {
  const res = await call<unknown>(
    client,
    "POST",
    `/admin/users/${encodeURIComponent(id)}/recovery/device-replacement`,
    opts,
  );
  if (res.status === 404) throw apiError(res, `No user found with id ${id}`);
  if (!res.ok) throw apiError(res, "Could not prepare device replacement");
  return parse(
    DeviceReplacementRecoveryResponseSchema,
    res.data,
    "a device replacement result",
  );
}

// Organizations

export type OrgList = z.infer<typeof OrgListSchema>;

export interface ListOrgsOptions {
  limit?: number;
  offset?: number;
  search?: string;
}

export async function listOrgs(
  client: AuthClient,
  opts: ListOrgsOptions = {},
): Promise<OrgList> {
  const query = new URLSearchParams();
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  if (opts.offset !== undefined) query.set("offset", String(opts.offset));
  if (opts.search) query.set("search", opts.search);
  const suffix = query.size ? `?${query}` : "";

  const res = await call<unknown>(client, "GET", `/admin/organizations${suffix}`);
  if (!res.ok) throw apiError(res, "Could not list organizations");
  // `total` counts every match, not just this page, so callers can report position.
  return parse(OrgListSchema, res.data, "an organization list");
}

function orgEnvelope(
  res: ApiResponse<unknown>,
  summary: string,
): AdminOrganization {
  if (!res.ok) throw apiError(res, summary);
  return parse(
    z.object({ organization: OrgSchema }),
    res.data,
    "an organization",
  ).organization;
}

export async function createOrg(
  client: AuthClient,
  body: CreateOrganizationRequest,
): Promise<AdminOrganization> {
  const res = await call<unknown>(
    client,
    "POST",
    "/admin/organizations",
    body,
  );
  return orgEnvelope(res, "Could not create organization");
}

export async function getOrg(
  client: AuthClient,
  id: string,
): Promise<AdminOrganization> {
  const res = await call<unknown>(
    client,
    "GET",
    `/admin/organizations/${encodeURIComponent(id)}`,
  );
  if (res.status === 404) {
    throw apiError(res, `No organization found with id ${id}`);
  }
  return orgEnvelope(res, "Could not load organization");
}

export async function updateOrg(
  client: AuthClient,
  id: string,
  body: UpdateOrganizationRequest,
): Promise<AdminOrganization> {
  const res = await call<unknown>(
    client,
    "PATCH",
    `/admin/organizations/${encodeURIComponent(id)}`,
    body,
  );
  if (res.status === 404) {
    throw apiError(res, `No organization found with id ${id}`);
  }
  return orgEnvelope(res, "Could not update organization");
}

export type MemberList = z.infer<typeof MemberListSchema>;

export async function listMembers(
  client: AuthClient,
  orgId: string,
): Promise<MemberList> {
  const res = await call<unknown>(
    client,
    "GET",
    `/admin/organizations/${encodeURIComponent(orgId)}/members`,
  );
  if (res.status === 404) {
    throw apiError(res, `No organization found with id ${orgId}`);
  }
  if (!res.ok) throw apiError(res, "Could not list members");
  return parse(MemberListSchema, res.data, "a member list");
}

function membershipEnvelope(
  res: ApiResponse<unknown>,
  summary: string,
): AdminMembership {
  if (!res.ok) throw apiError(res, summary);
  return parse(
    z.object({ membership: MembershipSchema }),
    res.data,
    "a membership",
  ).membership;
}

export async function addMember(
  client: AuthClient,
  orgId: string,
  body: AddOrganizationMemberRequest,
): Promise<AdminMembership> {
  const res = await call<unknown>(
    client,
    "POST",
    `/admin/organizations/${encodeURIComponent(orgId)}/members`,
    body,
  );
  // The API answers 404 for a missing user as well as a missing organization.
  if (res.status === 404) throw apiError(res, "No such organization or user");
  if (res.status === 409) {
    throw apiError(
      res,
      `That user is already a member of organization ${orgId}`,
    );
  }
  return membershipEnvelope(res, "Could not add member");
}

export async function updateMember(
  client: AuthClient,
  orgId: string,
  userId: string,
  body: UpdateOrganizationMemberRequest,
): Promise<AdminMembership> {
  const res = await call<unknown>(
    client,
    "PATCH",
    `/admin/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
    body,
  );
  if (res.status === 404) throw apiError(res, "No such organization or member");
  return membershipEnvelope(res, "Could not update member");
}

export async function removeMember(
  client: AuthClient,
  orgId: string,
  userId: string,
): Promise<void> {
  const res = await call(
    client,
    "DELETE",
    `/admin/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
  );
  if (res.status === 404) throw apiError(res, "No such organization or member");
  if (!res.ok) throw apiError(res, "Could not remove member");
}

// OpenID Provider applications and resources

function applicationPath(id: string): string {
  return `/admin/applications/${encodeURIComponent(id)}`;
}

function resourcePath(id: string): string {
  return `/admin/resources/${encodeURIComponent(id)}`;
}

function notFound(res: ApiResponse<unknown>, what: string, id: string): void {
  if (res.status === 404) throw apiError(res, `No ${what} found with id ${id}`);
}

export async function listApplications(
  client: AuthClient,
): Promise<OidcApplication[]> {
  const res = await call<unknown>(client, "GET", "/admin/applications");
  if (!res.ok) throw apiError(res, "Could not list applications");
  return parse(
    OidcApplicationListResponseSchema.loose(),
    res.data,
    "an application list",
  ).applications;
}

export async function getApplication(
  client: AuthClient,
  id: string,
): Promise<OidcApplication> {
  const res = await call<unknown>(client, "GET", applicationPath(id));
  notFound(res, "application", id);
  if (!res.ok) throw apiError(res, "Could not load application");
  return parse(OidcApplicationResponseSchema, res.data, "an application")
    .application;
}

export async function createApplication(
  client: AuthClient,
  body: OidcApplicationCreateRequest,
): Promise<OidcApplicationCreatedResponse> {
  const res = await call<unknown>(client, "POST", "/admin/applications", body);
  if (!res.ok) throw apiError(res, "Could not create application");
  return parse(OidcApplicationCreatedResponseSchema, res.data, "an application");
}

export async function updateApplication(
  client: AuthClient,
  id: string,
  body: OidcApplicationUpdateRequest,
): Promise<OidcApplication> {
  const res = await call<unknown>(client, "PATCH", applicationPath(id), body);
  notFound(res, "application", id);
  if (!res.ok) throw apiError(res, "Could not update application");
  return parse(OidcApplicationResponseSchema, res.data, "an application")
    .application;
}

export async function deleteApplication(
  client: AuthClient,
  id: string,
): Promise<void> {
  const res = await call(client, "DELETE", applicationPath(id));
  notFound(res, "application", id);
  if (!res.ok) throw apiError(res, "Could not delete application");
}

export async function rotateApplicationSecret(
  client: AuthClient,
  id: string,
): Promise<OidcApplicationSecretResponse> {
  const res = await call<unknown>(client, "POST", `${applicationPath(id)}/secret`);
  notFound(res, "application", id);
  if (!res.ok) throw apiError(res, "Could not issue a secret");
  return parse(OidcApplicationSecretResponseSchema, res.data, "a secret");
}

export async function setApplicationKeys(
  client: AuthClient,
  id: string,
  body: OidcApplicationKeysRequest,
): Promise<OidcApplication> {
  const res = await call<unknown>(client, "PUT", `${applicationPath(id)}/keys`, body);
  notFound(res, "application", id);
  if (!res.ok) throw apiError(res, "Could not register keys");
  return parse(OidcApplicationResponseSchema, res.data, "an application")
    .application;
}

export async function listApplicationResources(
  client: AuthClient,
  id: string,
): Promise<OidcApplicationResource[]> {
  const res = await call<unknown>(client, "GET", `${applicationPath(id)}/resources`);
  notFound(res, "application", id);
  if (!res.ok) throw apiError(res, "Could not list the application's resources");
  return parse(
    OidcApplicationResourcesResponseSchema,
    res.data,
    "a resource list",
  ).resources;
}

export async function setApplicationResources(
  client: AuthClient,
  id: string,
  resources: OidcApplicationResourceGrant[],
): Promise<OidcApplicationResource[]> {
  const res = await call<unknown>(client, "PUT", `${applicationPath(id)}/resources`, {
    resources,
  });
  notFound(res, "application", id);
  if (!res.ok) throw apiError(res, "Could not set the application's resources");
  return parse(
    OidcApplicationResourcesResponseSchema,
    res.data,
    "a resource list",
  ).resources;
}

export async function listResources(client: AuthClient): Promise<OidcResource[]> {
  const res = await call<unknown>(client, "GET", "/admin/resources");
  if (!res.ok) throw apiError(res, "Could not list resources");
  return parse(OidcResourceListResponseSchema.loose(), res.data, "a resource list")
    .resources;
}

export async function getResource(
  client: AuthClient,
  id: string,
): Promise<OidcResource> {
  const res = await call<unknown>(client, "GET", resourcePath(id));
  notFound(res, "resource", id);
  if (!res.ok) throw apiError(res, "Could not load resource");
  return parse(OidcResourceResponseSchema, res.data, "a resource").resource;
}

export async function createResource(
  client: AuthClient,
  body: OidcResourceCreateRequest,
): Promise<OidcResource> {
  const res = await call<unknown>(client, "POST", "/admin/resources", body);
  if (res.status === 409) {
    throw apiError(res, `A resource with identifier ${body.identifier} already exists`);
  }
  if (!res.ok) throw apiError(res, "Could not create resource");
  return parse(OidcResourceResponseSchema, res.data, "a resource").resource;
}

export async function updateResource(
  client: AuthClient,
  id: string,
  body: OidcResourceUpdateRequest,
): Promise<OidcResource> {
  const res = await call<unknown>(client, "PATCH", resourcePath(id), body);
  notFound(res, "resource", id);
  if (!res.ok) throw apiError(res, "Could not update resource");
  return parse(OidcResourceResponseSchema, res.data, "a resource").resource;
}

export async function deleteResource(client: AuthClient, id: string): Promise<void> {
  const res = await call(client, "DELETE", resourcePath(id));
  notFound(res, "resource", id);
  if (!res.ok) throw apiError(res, "Could not delete resource");
}

// Permissions and roles (auth API v0.23)

const AdminPermissionSchema = PermissionSchema.loose();
const AdminRoleSchema = RoleDefinitionSchema.loose();

const PermissionListSchema = PermissionListResponseSchema.extend({
  permissions: z.array(AdminPermissionSchema),
}).loose();

const RoleListSchema = RoleListResponseSchema.extend({
  roles: z.array(AdminRoleSchema),
}).loose();

const PermissionEnvelopeSchema = PermissionEnvelopeResponseSchema.extend({
  permission: AdminPermissionSchema,
});

const RoleEnvelopeSchema = RoleEnvelopeResponseSchema.extend({
  role: AdminRoleSchema,
});

export type AdminPermission = z.infer<typeof AdminPermissionSchema>;
export type AdminRole = z.infer<typeof AdminRoleSchema>;
export type PermissionList = z.infer<typeof PermissionListSchema>;

export const PERMISSIONS_UNSUPPORTED_MESSAGE =
  "This instance has no permission catalogue. Permissions and organization roles need Seamless Auth API v0.23 or later.";

// An instance from before v0.23 has none of these routes, so it answers with the
// app's catch-all 404 (`{ error: "Not Found" }`). A missing permission or role on
// v0.23 is a 404 too, but it names what was missing, which is how the two differ.
function unsupported(res: ApiResponse<unknown>, anyNotFound = false): void {
  if (res.status !== 404) return;
  if (anyNotFound || apiMessage(res.data) === "Not Found") {
    throw new AdminApiError(PERMISSIONS_UNSUPPORTED_MESSAGE);
  }
}

// A 400 or 409 from these routes can carry `details` naming what is in the way:
// the roles still granting a permission, the permissions that do not exist, or
// how many memberships still hold a role.
function conflictDetail(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const details = (data as Record<string, unknown>).details;
  if (!details || typeof details !== "object") return undefined;

  const parts: string[] = [];
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      const names = value.map((item) => {
        if (item && typeof item === "object") {
          const role = item as Record<string, unknown>;
          return `${String(role.kind)} role ${String(role.name)}`;
        }
        return String(item);
      });
      parts.push(`${key}: ${names.join(", ")}`);
    } else if (key === "holders" && typeof value === "number") {
      parts.push(`held by ${value} membership${value === 1 ? "" : "s"}`);
    } else {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.length ? parts.join("; ") : undefined;
}

function permissionsError(res: ApiResponse<unknown>, summary: string): AdminApiError {
  const error = apiError(res, summary);
  const detail = conflictDetail(res.data);
  return detail
    ? new AdminApiError(`${error.message.replace(/\.$/, "")}, ${detail}.`)
    : error;
}

function permissionPath(name: string): string {
  return `/admin/permissions/${encodeURIComponent(name)}`;
}

function organizationRolePath(name: string): string {
  return `/admin/organization-roles/${encodeURIComponent(name)}`;
}

export async function listPermissions(client: AuthClient): Promise<PermissionList> {
  const res = await call<unknown>(client, "GET", "/admin/permissions");
  unsupported(res, true);
  if (!res.ok) throw apiError(res, "Could not list permissions");
  return parse(PermissionListSchema, res.data, "a permission list");
}

export async function createPermission(
  client: AuthClient,
  body: CreatePermissionRequest,
): Promise<AdminPermission> {
  const res = await call<unknown>(client, "POST", "/admin/permissions", body);
  unsupported(res, true);
  if (res.status === 409) {
    throw apiError(res, `A permission named ${body.name} already exists`);
  }
  if (!res.ok) throw permissionsError(res, "Could not create permission");
  return parse(PermissionEnvelopeSchema, res.data, "a permission").permission;
}

export async function updatePermission(
  client: AuthClient,
  name: string,
  body: UpdatePermissionRequest,
): Promise<AdminPermission> {
  const res = await call<unknown>(client, "PATCH", permissionPath(name), body);
  unsupported(res);
  if (res.status === 404) throw apiError(res, `No permission named ${name}`);
  if (!res.ok) throw permissionsError(res, "Could not update permission");
  return parse(PermissionEnvelopeSchema, res.data, "a permission").permission;
}

export async function deletePermission(client: AuthClient, name: string): Promise<void> {
  const res = await call(client, "DELETE", permissionPath(name));
  unsupported(res);
  if (res.status === 404) throw apiError(res, `No permission named ${name}`);
  if (!res.ok) throw permissionsError(res, `Could not delete permission ${name}`);
}

export async function listRoles(client: AuthClient): Promise<AdminRole[]> {
  const res = await call<unknown>(client, "GET", "/admin/roles");
  unsupported(res, true);
  if (!res.ok) throw apiError(res, "Could not list roles");
  return parse(RoleListSchema, res.data, "a role list").roles;
}

export async function setRolePermissions(
  client: AuthClient,
  kind: RoleKind,
  role: string,
  permissions: string[],
): Promise<AdminRole> {
  const res = await call<unknown>(
    client,
    "PUT",
    `/admin/roles/${encodeURIComponent(kind)}/${encodeURIComponent(role)}/permissions`,
    { permissions },
  );
  unsupported(res);
  if (res.status === 404) throw apiError(res, `No ${kind} role named ${role}`);
  if (!res.ok) throw permissionsError(res, `Could not set the permissions of ${role}`);
  return parse(RoleEnvelopeSchema, res.data, "a role").role;
}

export async function createOrganizationRole(
  client: AuthClient,
  body: CreateOrganizationRoleRequest,
): Promise<AdminRole> {
  const res = await call<unknown>(client, "POST", "/admin/organization-roles", body);
  unsupported(res, true);
  if (!res.ok) throw permissionsError(res, "Could not create organization role");
  return parse(RoleEnvelopeSchema, res.data, "a role").role;
}

export async function updateOrganizationRole(
  client: AuthClient,
  name: string,
  body: UpdateOrganizationRoleRequest,
): Promise<AdminRole> {
  const res = await call<unknown>(client, "PATCH", organizationRolePath(name), body);
  unsupported(res);
  if (res.status === 404) throw apiError(res, `No organization role named ${name}`);
  if (!res.ok) throw permissionsError(res, "Could not update organization role");
  return parse(RoleEnvelopeSchema, res.data, "a role").role;
}

export async function deleteOrganizationRole(
  client: AuthClient,
  name: string,
): Promise<void> {
  const res = await call(client, "DELETE", organizationRolePath(name));
  unsupported(res);
  if (res.status === 404) throw apiError(res, `No organization role named ${name}`);
  if (!res.ok) throw permissionsError(res, `Could not delete organization role ${name}`);
}
