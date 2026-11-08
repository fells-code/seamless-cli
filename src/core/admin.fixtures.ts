import type { OidcApplication, OidcResource } from "@seamless-auth/types";
import type {
  AdminAuditSink,
  AdminClaimSource,
  AdminCredential,
  AdminDelivery,
  AdminInvocation,
  AdminLoginHook,
  AdminWebhook,
  AdminMembership,
  AdminOrganization,
  AdminPermission,
  AdminRole,
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
    sessionExchangeEnabled: false,
    pkceRequired: true,
    nonceRequired: true,
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

export function apiPermission(
  overrides: Partial<AdminPermission> = {},
): AdminPermission {
  return {
    id: "p1",
    name: "invoices:read",
    description: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function apiRole(overrides: Partial<AdminRole> = {}): AdminRole {
  return {
    name: "billing",
    kind: "organization",
    description: null,
    builtIn: false,
    permissions: [],
    ...overrides,
  };
}

export const WEBHOOK_ID = "0f8e3c1a-5b2d-4c7e-9a10-1b2c3d4e5f60";
export const DELIVERY_ID = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
export const SINK_ID = "3c2b1a09-8f7e-4d6c-9b5a-493827161504";
export const SECRET = `whsec_${"A".repeat(43)}=`;

export function apiWebhook(overrides: Partial<AdminWebhook> = {}): AdminWebhook {
  return {
    id: WEBHOOK_ID,
    url: "https://hooks.example.com/seamless",
    description: null,
    eventTypes: ["user.created"],
    enabled: true,
    disabledReason: null,
    version: 1,
    previousSecretExpiresAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function apiDelivery(overrides: Partial<AdminDelivery> = {}): AdminDelivery {
  return {
    id: DELIVERY_ID,
    endpointId: WEBHOOK_ID,
    eventType: "user.created",
    status: "failed",
    attempts: 2,
    nextAttemptAt: CREATED,
    lastAttemptAt: CREATED,
    lastStatusCode: 500,
    lastFailure: "http_status",
    createdAt: CREATED,
    ...overrides,
  };
}

export function apiLoginHook(overrides: Partial<AdminLoginHook> = {}): AdminLoginHook {
  return {
    trigger: "post_login",
    url: "https://hooks.example.com/login",
    timeoutMs: 2000,
    failureMode: "closed",
    enabled: true,
    previousSecretExpiresAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

export function apiInvocation(overrides: Partial<AdminInvocation> = {}): AdminInvocation {
  return {
    id: "i1",
    trigger: "post_login",
    userId: "u1",
    outcome: "allowed",
    failure: null,
    statusCode: 200,
    durationMs: 42,
    createdAt: CREATED,
    ...overrides,
  };
}

export function apiClaimSource(overrides: Partial<AdminClaimSource> = {}): AdminClaimSource {
  return {
    sourceKind: "organization_role",
    sourceName: "billing",
    claims: { tier: "gold" },
    updatedAt: CREATED,
    ...overrides,
  };
}

export function apiAuditSink(overrides: Partial<AdminAuditSink> = {}): AdminAuditSink {
  return {
    id: SINK_ID,
    name: "datadog",
    enabled: true,
    settings: {
      kind: "otlp",
      endpoint: "https://otlp.example.com",
      headersFromEnv: { "DD-API-KEY": "DD_AUDIT_SINK_SECRET" },
      serviceName: "seamless-auth",
    },
    status: {
      cursorSeq: 10,
      lagEvents: 0,
      lastDeliveredAt: CREATED,
      lastFailure: null,
      lastFailureAt: null,
    },
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}
