import type {
  AdminCredential,
  AdminMembership,
  AdminOrganization,
  AdminUser,
} from "./admin.js";

// Admin payloads as the auth API sends them, with every field the shared schemas
// require, so a test only spells out the ones it is about.

const CREATED = "2026-07-13T10:00:00.000Z";

export function apiUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "u1",
    email: "ada@example.com",
    phone: null,
    roles: [],
    ...overrides,
  };
}

export function apiCredential(
  overrides: Partial<AdminCredential> = {},
): AdminCredential {
  return {
    id: "cred-1",
    counter: 0,
    backedup: false,
    backedUp: false,
    createdAt: CREATED,
    ...overrides,
  };
}

export function apiOrg(overrides: Partial<AdminOrganization> = {}): AdminOrganization {
  return {
    id: "o1",
    name: "Acme",
    slug: "acme",
    createdByUserId: null,
    metadata: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function apiMembership(
  overrides: Partial<AdminMembership> = {},
): AdminMembership {
  return {
    id: "m1",
    organizationId: "o1",
    userId: "u1",
    roles: [],
    scopes: [],
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function apiUserDetail(credentials: AdminCredential[] = []) {
  return { user: apiUser(), sessions: [], credentials, events: [] };
}
