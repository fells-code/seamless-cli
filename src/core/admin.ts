import {
  AdminOrganizationListResponseSchema,
  AdminUserDetailResponseSchema,
  ApiUserSchema,
  AuthEventSchema,
  CredentialResponseSchema,
  DeviceReplacementRecoveryResponseSchema,
  OrganizationMembersResponseSchema,
  OrganizationMembershipSchema,
  OrganizationSchema,
  SessionSchema,
  UsersListResponseSchema,
  type AddOrganizationMemberRequest,
  type CreateOrganizationRequest,
  type DeviceReplacementRecoveryRequest,
  type DeviceReplacementRecoveryResponse,
  type UpdateOrganizationMemberRequest,
  type UpdateOrganizationRequest,
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
