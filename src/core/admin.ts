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
  type DeviceReplacementRecoveryResponse,
  type UpdateOrganizationMemberRequest,
  type UpdateOrganizationRequest,
} from "@seamless-auth/types";
import { z } from "zod";
import type { AuthClient } from "./authClient.js";
import type { ApiResponse } from "./http.js";
import { PermissionError } from "./systemConfig.js";

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
  if (res.status === 403) throw new PermissionError();
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
  if (!res.ok) throw new AdminApiError(`Could not list users (${res.status}).`);
  // `total` counts every user, not just this page, so callers can report position.
  return parse(UserListSchema, res.data, "a user list");
}

export async function deleteUser(client: AuthClient, id: string): Promise<void> {
  const res = await call(client, "DELETE", "/admin/users", { userId: id });
  if (res.status === 404) throw new AdminApiError(`No user found with id ${id}.`);
  if (!res.ok) throw new AdminApiError(`Could not delete user (${res.status}).`);
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
  if (res.status === 404) throw new AdminApiError(`No user found with id ${id}.`);
  if (!res.ok) throw new AdminApiError(`Could not load user (${res.status}).`);
  return parse(UserDetailSchema, res.data, "a user");
}

export interface DeviceReplacementOptions {
  revokeSessions: boolean;
  removePasskeys: boolean;
  disableTotp: boolean;
}

export async function prepareDeviceReplacement(
  client: AuthClient,
  id: string,
  opts: DeviceReplacementOptions,
): Promise<DeviceReplacementRecoveryResponse> {
  const res = await client.request<unknown>(
    `/admin/users/${encodeURIComponent(id)}/recovery/device-replacement`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    },
  );
  if (res.status === 404) throw new AdminApiError(`No user found with id ${id}.`);
  if (res.status === 401 || res.status === 403) {
    throw new PermissionError(
      "Admin-assisted device replacement requires an elevated step-up admin session, which the CLI cannot establish yet. Use the dashboard for this action.",
    );
  }
  if (!res.ok) {
    throw new AdminApiError(
      `Could not prepare device replacement (${res.status}).`,
    );
  }
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
  if (!res.ok) throw new AdminApiError(`Could not list organizations (${res.status}).`);
  // `total` counts every match, not just this page, so callers can report position.
  return parse(OrgListSchema, res.data, "an organization list");
}

function orgEnvelope(res: ApiResponse<unknown>): AdminOrganization {
  if (!res.ok) throw new AdminApiError(`Request failed (${res.status}).`);
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
  return orgEnvelope(res);
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
    throw new AdminApiError(`No organization found with id ${id}.`);
  }
  return orgEnvelope(res);
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
    throw new AdminApiError(`No organization found with id ${id}.`);
  }
  return orgEnvelope(res);
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
    throw new AdminApiError(`No organization found with id ${orgId}.`);
  }
  if (!res.ok) throw new AdminApiError(`Could not list members (${res.status}).`);
  return parse(MemberListSchema, res.data, "a member list");
}

function membershipEnvelope(res: ApiResponse<unknown>): AdminMembership {
  if (!res.ok) throw new AdminApiError(`Request failed (${res.status}).`);
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
  if (res.status === 404) {
    throw new AdminApiError(`No organization found with id ${orgId}.`);
  }
  return membershipEnvelope(res);
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
  if (res.status === 404) {
    throw new AdminApiError(`No such organization or member.`);
  }
  return membershipEnvelope(res);
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
  if (res.status === 404) {
    throw new AdminApiError(`No such organization or member.`);
  }
  if (!res.ok) throw new AdminApiError(`Could not remove member (${res.status}).`);
}
