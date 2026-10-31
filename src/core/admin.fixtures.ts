import type { OidcApplication, OidcResource } from "@seamless-auth/types";
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

export function apiApplication(
  overrides: Partial<OidcApplication> = {},
): OidcApplication {
  return {
    id: "client_docs",
    name: "Docs",
    clientType: "confidential",
    applicationType: "web",
    firstParty: false,
    tokenEndpointAuthMethod: "private_key_jwt",
    redirectUris: ["https://docs.example.com/callback"],
    postLogoutRedirectUris: [],
    grantTypes: ["authorization_code", "refresh_token"],
    deviceFlowEnabled: false,
    noticesEnabled: false,
    jwks: null,
    jwksUri: null,
    hasSecret: false,
    backchannelLogoutUri: null,
    accessTokenTtlSeconds: null,
    idTokenTtlSeconds: null,
    refreshTokenTtlSeconds: null,
    disabled: false,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export const RESOURCE_ID = "00000000-0000-4000-8000-000000000001";

export function apiResource(overrides: Partial<OidcResource> = {}): OidcResource {
  return {
    id: RESOURCE_ID,
    identifier: "https://orders.example.com",
    name: "Orders",
    scopes: ["orders:read", "orders:write"],
    accessTokenTtlSeconds: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}
