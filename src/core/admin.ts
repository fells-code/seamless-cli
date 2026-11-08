import {
  AdminOrganizationListResponseSchema,
  AuditSinkSchema,
  AuditSinkStatusSchema,
  CalloutSecretSchema,
  CalloutTestResponseSchema,
  CustomClaimListResponseSchema,
  CustomClaimSourceSchema,
  LoginHookInvocationSchema,
  LoginHookSchema,
  WebhookDeliverySchema,
  WebhookEndpointSchema,
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
  type CreateAuditSinkRequest,
  type CreateWebhookEndpointRequest,
  type CustomClaimSourceKind,
  type LoginHookOutcome,
  type LoginHookTrigger,
  type SetLoginHookRequest,
  type UpdateAuditSinkRequest,
  type UpdateWebhookEndpointRequest,
  type WebhookDeliveryStatus,
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
function unsupported(
  res: ApiResponse<unknown>,
  anyNotFound = false,
  message = PERMISSIONS_UNSUPPORTED_MESSAGE,
): void {
  if (res.status !== 404) return;
  if (anyNotFound || apiMessage(res.data) === "Not Found") {
    throw new AdminApiError(message);
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

// Webhooks, login hooks, custom claims and audit sinks (auth API v0.23)

// The event catalogue and the failure reasons grow by addition, so a value this
// CLI's types do not know yet is kept rather than failing the whole response.
const AdminWebhookSchema = WebhookEndpointSchema.extend({
  eventTypes: z.array(z.string()),
}).loose();

const AdminDeliverySchema = WebhookDeliverySchema.extend({
  eventType: z.string(),
  lastFailure: z.string().nullable(),
}).loose();

const AdminDeliveryDetailSchema = AdminDeliverySchema.extend({
  event: z.record(z.string(), z.unknown()),
}).loose();

const AdminTestResultSchema = CalloutTestResponseSchema.extend({
  failure: z.string().nullable(),
}).loose();

const AdminLoginHookSchema = LoginHookSchema.loose();

const AdminInvocationSchema = LoginHookInvocationSchema.extend({
  failure: z.string().nullable(),
}).loose();

const AdminClaimSourceSchema = CustomClaimSourceSchema.loose();

const AdminAuditSinkSchema = AuditSinkSchema.extend({
  settings: z.looseObject({ kind: z.string() }),
  status: AuditSinkStatusSchema.extend({ lastFailure: z.string().nullable() }).loose(),
}).loose();

const SecretRotatedSchema = z
  .object({ secret: CalloutSecretSchema, previousSecretExpiresAt: z.string() })
  .loose();

const WebhookEnvelopeSchema = z.object({ endpoint: AdminWebhookSchema }).loose();
const WebhookCreatedSchema = WebhookEnvelopeSchema.extend({ secret: CalloutSecretSchema });
const WebhookListSchema = z.object({ endpoints: z.array(AdminWebhookSchema) }).loose();
const DeliveryListSchema = z
  .object({ deliveries: z.array(AdminDeliverySchema), nextCursor: z.string().nullable() })
  .loose();
const DeliveryEnvelopeSchema = z.object({ delivery: AdminDeliveryDetailSchema }).loose();
const LoginHookEnvelopeSchema = z
  .object({ hook: AdminLoginHookSchema, secret: CalloutSecretSchema.optional() })
  .loose();
const LoginHookListSchema = z.object({ hooks: z.array(AdminLoginHookSchema) }).loose();
const InvocationListSchema = z.object({ invocations: z.array(AdminInvocationSchema) }).loose();
const ClaimListSchema = CustomClaimListResponseSchema.extend({
  sources: z.array(AdminClaimSourceSchema),
}).loose();
const ClaimEnvelopeSchema = z.object({ source: AdminClaimSourceSchema }).loose();
const AuditSinkEnvelopeSchema = z.object({ sink: AdminAuditSinkSchema }).loose();
const AuditSinkListSchema = z.object({ sinks: z.array(AdminAuditSinkSchema) }).loose();

export type AdminWebhook = z.infer<typeof AdminWebhookSchema>;
export type AdminWebhookCreated = z.infer<typeof WebhookCreatedSchema>;
export type AdminDelivery = z.infer<typeof AdminDeliverySchema>;
export type AdminDeliveryDetail = z.infer<typeof AdminDeliveryDetailSchema>;
export type DeliveryList = z.infer<typeof DeliveryListSchema>;
export type CalloutTestResult = z.infer<typeof AdminTestResultSchema>;
export type SecretRotated = z.infer<typeof SecretRotatedSchema>;
export type AdminLoginHook = z.infer<typeof AdminLoginHookSchema>;
export type LoginHookSet = z.infer<typeof LoginHookEnvelopeSchema>;
export type AdminInvocation = z.infer<typeof AdminInvocationSchema>;
export type AdminClaimSource = z.infer<typeof AdminClaimSourceSchema>;
export type ClaimList = z.infer<typeof ClaimListSchema>;
export type AdminAuditSink = z.infer<typeof AdminAuditSinkSchema>;

export const WEBHOOKS_UNSUPPORTED_MESSAGE =
  "This instance has no webhooks. Webhooks need Seamless Auth API v0.23 or later.";
export const LOGIN_HOOKS_UNSUPPORTED_MESSAGE =
  "This instance has no login hooks. Login hooks need Seamless Auth API v0.23 or later.";
export const CUSTOM_CLAIMS_UNSUPPORTED_MESSAGE =
  "This instance has no custom claims. Custom claims need Seamless Auth API v0.23 or later.";
export const AUDIT_SINKS_UNSUPPORTED_MESSAGE =
  "This instance has no audit sinks. Audit sinks need Seamless Auth API v0.23 or later.";

// A request the API's own schema refuses answers 400 with `details.issues`, each
// naming the field. Spelling those out says what to fix.
function calloutError(res: ApiResponse<unknown>, summary: string): AdminApiError {
  const error = apiError(res, summary);
  const details = (res.data as { details?: { issues?: unknown } } | null)?.details;
  if (!Array.isArray(details?.issues)) return error;

  const issues = details.issues
    .map((issue: unknown) => {
      if (!issue || typeof issue !== "object") return undefined;
      const { path, message } = issue as { path?: unknown; message?: unknown };
      if (typeof message !== "string") return undefined;
      const where = Array.isArray(path) ? path.join(".") : "";
      return where ? `${where} ${message}` : message;
    })
    .filter((issue): issue is string => issue !== undefined);
  return issues.length
    ? new AdminApiError(`${error.message.replace(/\.$/, "")}, ${issues.join("; ")}.`)
    : error;
}

function webhookPath(id: string, suffix = ""): string {
  return `/admin/webhooks/${encodeURIComponent(id)}${suffix}`;
}

function deliveryPath(id: string, suffix = ""): string {
  return `/admin/webhook-deliveries/${encodeURIComponent(id)}${suffix}`;
}

function webhooksMissing(res: ApiResponse<unknown>, anyNotFound = false): void {
  unsupported(res, anyNotFound, WEBHOOKS_UNSUPPORTED_MESSAGE);
}

export async function listWebhooks(client: AuthClient): Promise<AdminWebhook[]> {
  const res = await call<unknown>(client, "GET", "/admin/webhooks");
  webhooksMissing(res, true);
  if (!res.ok) throw apiError(res, "Could not list webhooks");
  return parse(WebhookListSchema, res.data, "a webhook list").endpoints;
}

export async function getWebhook(client: AuthClient, id: string): Promise<AdminWebhook> {
  const res = await call<unknown>(client, "GET", webhookPath(id));
  webhooksMissing(res);
  if (res.status === 404) throw apiError(res, `No webhook found with id ${id}`);
  if (!res.ok) throw apiError(res, "Could not load webhook");
  return parse(WebhookEnvelopeSchema, res.data, "a webhook").endpoint;
}

export async function createWebhook(
  client: AuthClient,
  body: CreateWebhookEndpointRequest,
): Promise<AdminWebhookCreated> {
  const res = await call<unknown>(client, "POST", "/admin/webhooks", body);
  webhooksMissing(res, true);
  if (!res.ok) throw calloutError(res, "Could not create webhook");
  return parse(WebhookCreatedSchema, res.data, "a webhook");
}

export async function updateWebhook(
  client: AuthClient,
  id: string,
  body: UpdateWebhookEndpointRequest,
): Promise<AdminWebhook> {
  const res = await call<unknown>(client, "PATCH", webhookPath(id), body);
  webhooksMissing(res);
  if (res.status === 404) throw apiError(res, `No webhook found with id ${id}`);
  if (!res.ok) throw calloutError(res, "Could not update webhook");
  return parse(WebhookEnvelopeSchema, res.data, "a webhook").endpoint;
}

export async function deleteWebhook(client: AuthClient, id: string): Promise<void> {
  const res = await call(client, "DELETE", webhookPath(id));
  webhooksMissing(res);
  if (res.status === 404) throw apiError(res, `No webhook found with id ${id}`);
  if (!res.ok) throw apiError(res, "Could not delete webhook");
}

export async function rotateWebhookSecret(
  client: AuthClient,
  id: string,
): Promise<SecretRotated> {
  const res = await call<unknown>(client, "POST", webhookPath(id, "/secret"));
  webhooksMissing(res);
  if (res.status === 404) throw apiError(res, `No webhook found with id ${id}`);
  if (!res.ok) throw apiError(res, "Could not rotate the webhook secret");
  return parse(SecretRotatedSchema, res.data, "a new secret");
}

export async function testWebhook(
  client: AuthClient,
  id: string,
): Promise<CalloutTestResult> {
  const res = await call<unknown>(client, "POST", webhookPath(id, "/test"));
  webhooksMissing(res);
  if (res.status === 404) throw apiError(res, `No webhook found with id ${id}`);
  if (!res.ok) throw apiError(res, "Could not send a test event");
  return parse(AdminTestResultSchema, res.data, "a test result");
}

export interface ListDeliveriesOptions {
  endpointId?: string;
  status?: WebhookDeliveryStatus;
  eventType?: string;
  limit?: number;
  cursor?: string;
}

export async function listWebhookDeliveries(
  client: AuthClient,
  opts: ListDeliveriesOptions = {},
): Promise<DeliveryList> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(opts)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.size ? `?${query}` : "";

  const res = await call<unknown>(client, "GET", `/admin/webhook-deliveries${suffix}`);
  webhooksMissing(res, true);
  if (!res.ok) throw calloutError(res, "Could not list webhook deliveries");
  return parse(DeliveryListSchema, res.data, "a delivery list");
}

export async function getWebhookDelivery(
  client: AuthClient,
  id: string,
): Promise<AdminDeliveryDetail> {
  const res = await call<unknown>(client, "GET", deliveryPath(id));
  webhooksMissing(res);
  if (res.status === 404) throw apiError(res, `No delivery found with id ${id}`);
  if (!res.ok) throw apiError(res, "Could not load delivery");
  return parse(DeliveryEnvelopeSchema, res.data, "a delivery").delivery;
}

export async function redeliverWebhook(
  client: AuthClient,
  id: string,
): Promise<AdminDeliveryDetail> {
  const res = await call<unknown>(client, "POST", deliveryPath(id, "/redeliver"));
  webhooksMissing(res);
  if (res.status === 404) throw apiError(res, `No delivery found with id ${id}`);
  if (!res.ok) throw apiError(res, "Could not redeliver");
  return parse(DeliveryEnvelopeSchema, res.data, "a delivery").delivery;
}

function hookPath(trigger: LoginHookTrigger, suffix = ""): string {
  return `/admin/login-hooks/${encodeURIComponent(trigger)}${suffix}`;
}

function hooksMissing(res: ApiResponse<unknown>, anyNotFound = false): void {
  unsupported(res, anyNotFound, LOGIN_HOOKS_UNSUPPORTED_MESSAGE);
}

export async function listLoginHooks(client: AuthClient): Promise<AdminLoginHook[]> {
  const res = await call<unknown>(client, "GET", "/admin/login-hooks");
  hooksMissing(res, true);
  if (!res.ok) throw apiError(res, "Could not list login hooks");
  return parse(LoginHookListSchema, res.data, "a login hook list").hooks;
}

export async function setLoginHook(
  client: AuthClient,
  trigger: LoginHookTrigger,
  body: SetLoginHookRequest,
): Promise<LoginHookSet> {
  const res = await call<unknown>(client, "PUT", hookPath(trigger), body);
  hooksMissing(res, true);
  if (!res.ok) throw calloutError(res, `Could not set the ${trigger} hook`);
  return parse(LoginHookEnvelopeSchema, res.data, "a login hook");
}

export async function deleteLoginHook(
  client: AuthClient,
  trigger: LoginHookTrigger,
): Promise<void> {
  const res = await call(client, "DELETE", hookPath(trigger));
  hooksMissing(res);
  if (res.status === 404) throw apiError(res, `No ${trigger} hook is set`);
  if (!res.ok) throw apiError(res, `Could not delete the ${trigger} hook`);
}

export async function rotateLoginHookSecret(
  client: AuthClient,
  trigger: LoginHookTrigger,
): Promise<SecretRotated> {
  const res = await call<unknown>(client, "POST", hookPath(trigger, "/secret"));
  hooksMissing(res);
  if (res.status === 404) throw apiError(res, `No ${trigger} hook is set`);
  if (!res.ok) throw apiError(res, `Could not rotate the ${trigger} hook secret`);
  return parse(SecretRotatedSchema, res.data, "a new secret");
}

export async function testLoginHook(
  client: AuthClient,
  trigger: LoginHookTrigger,
): Promise<CalloutTestResult> {
  const res = await call<unknown>(client, "POST", hookPath(trigger, "/test"));
  hooksMissing(res);
  if (res.status === 404) throw apiError(res, `No ${trigger} hook is set`);
  if (!res.ok) throw apiError(res, `Could not test the ${trigger} hook`);
  return parse(AdminTestResultSchema, res.data, "a test result");
}

export async function listLoginHookInvocations(
  client: AuthClient,
  trigger: LoginHookTrigger,
  opts: { limit?: number; outcome?: LoginHookOutcome } = {},
): Promise<AdminInvocation[]> {
  const query = new URLSearchParams();
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  if (opts.outcome !== undefined) query.set("outcome", opts.outcome);
  const suffix = query.size ? `?${query}` : "";

  const res = await call<unknown>(client, "GET", hookPath(trigger, `/invocations${suffix}`));
  hooksMissing(res, true);
  if (!res.ok) throw calloutError(res, `Could not list ${trigger} hook invocations`);
  return parse(InvocationListSchema, res.data, "an invocation list").invocations;
}

function claimPath(kind: CustomClaimSourceKind, name: string): string {
  return `/admin/custom-claims/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;
}

function claimsMissing(res: ApiResponse<unknown>, anyNotFound = false): void {
  unsupported(res, anyNotFound, CUSTOM_CLAIMS_UNSUPPORTED_MESSAGE);
}

export async function listCustomClaims(client: AuthClient): Promise<ClaimList> {
  const res = await call<unknown>(client, "GET", "/admin/custom-claims");
  claimsMissing(res, true);
  if (!res.ok) throw apiError(res, "Could not list custom claims");
  return parse(ClaimListSchema, res.data, "a custom claim list");
}

/** The source's claims, or undefined when it has none set. */
export async function getCustomClaims(
  client: AuthClient,
  kind: CustomClaimSourceKind,
  name: string,
): Promise<AdminClaimSource | undefined> {
  const res = await call<unknown>(client, "GET", claimPath(kind, name));
  claimsMissing(res);
  if (res.status === 404) return undefined;
  if (!res.ok) throw apiError(res, `Could not load the custom claims of ${name}`);
  return parse(ClaimEnvelopeSchema, res.data, "custom claims").source;
}

export async function setCustomClaims(
  client: AuthClient,
  kind: CustomClaimSourceKind,
  name: string,
  claims: Record<string, unknown>,
): Promise<AdminClaimSource> {
  const res = await call<unknown>(client, "PUT", claimPath(kind, name), { claims });
  claimsMissing(res);
  if (res.status === 404) throw apiError(res, `No ${kind} named ${name}`);
  if (!res.ok) throw calloutError(res, `Could not set the custom claims of ${name}`);
  return parse(ClaimEnvelopeSchema, res.data, "custom claims").source;
}

export async function deleteCustomClaims(
  client: AuthClient,
  kind: CustomClaimSourceKind,
  name: string,
): Promise<void> {
  const res = await call(client, "DELETE", claimPath(kind, name));
  claimsMissing(res);
  if (res.status === 404) throw apiError(res, `No custom claims are set for ${kind} ${name}`);
  if (!res.ok) throw apiError(res, `Could not delete the custom claims of ${name}`);
}

function sinkPath(id: string, suffix = ""): string {
  return `/admin/audit-sinks/${encodeURIComponent(id)}${suffix}`;
}

function sinksMissing(res: ApiResponse<unknown>, anyNotFound = false): void {
  unsupported(res, anyNotFound, AUDIT_SINKS_UNSUPPORTED_MESSAGE);
}

export async function listAuditSinks(client: AuthClient): Promise<AdminAuditSink[]> {
  const res = await call<unknown>(client, "GET", "/admin/audit-sinks");
  sinksMissing(res, true);
  if (!res.ok) throw apiError(res, "Could not list audit sinks");
  return parse(AuditSinkListSchema, res.data, "an audit sink list").sinks;
}

export async function getAuditSink(client: AuthClient, id: string): Promise<AdminAuditSink> {
  const res = await call<unknown>(client, "GET", sinkPath(id));
  sinksMissing(res);
  if (res.status === 404) throw apiError(res, `No audit sink found with id ${id}`);
  if (!res.ok) throw apiError(res, "Could not load audit sink");
  return parse(AuditSinkEnvelopeSchema, res.data, "an audit sink").sink;
}

export async function createAuditSink(
  client: AuthClient,
  body: CreateAuditSinkRequest,
): Promise<AdminAuditSink> {
  const res = await call<unknown>(client, "POST", "/admin/audit-sinks", body);
  sinksMissing(res, true);
  if (!res.ok) throw calloutError(res, "Could not create audit sink");
  return parse(AuditSinkEnvelopeSchema, res.data, "an audit sink").sink;
}

export async function updateAuditSink(
  client: AuthClient,
  id: string,
  body: UpdateAuditSinkRequest,
): Promise<AdminAuditSink> {
  const res = await call<unknown>(client, "PATCH", sinkPath(id), body);
  sinksMissing(res);
  if (res.status === 404) throw apiError(res, `No audit sink found with id ${id}`);
  if (!res.ok) throw calloutError(res, "Could not update audit sink");
  return parse(AuditSinkEnvelopeSchema, res.data, "an audit sink").sink;
}

export async function deleteAuditSink(client: AuthClient, id: string): Promise<void> {
  const res = await call(client, "DELETE", sinkPath(id));
  sinksMissing(res);
  if (res.status === 404) throw apiError(res, `No audit sink found with id ${id}`);
  if (!res.ok) throw apiError(res, "Could not delete audit sink");
}

export async function testAuditSink(
  client: AuthClient,
  id: string,
): Promise<CalloutTestResult> {
  const res = await call<unknown>(client, "POST", sinkPath(id, "/test"));
  sinksMissing(res);
  if (res.status === 404) throw apiError(res, `No audit sink found with id ${id}`);
  if (!res.ok) throw apiError(res, "Could not send a test record");
  return parse(AdminTestResultSchema, res.data, "a test result");
}
