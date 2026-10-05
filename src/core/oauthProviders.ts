import { generateSecret } from "./secrets.js";

// The web app's OAuth callback route. The scaffolded web container serves the app
// at :5173, and the react-oauth template redirects to /oauth/callback there.
const REDIRECT_URI = "http://localhost:5173/oauth/callback";

// A known OIDC/OAuth provider the CLI can wire up from just a client id + secret.
// The endpoints are the provider's well-known ones, so the user only supplies
// credentials. Apple is intentionally absent: its client secret is a short-lived
// signed JWT (Team id, Key id, .p8 key) and it has no userinfo endpoint, so it does
// not fit this "paste a client id and secret" flow and is documented as manual.
export interface OAuthProviderCatalogEntry {
  id: string;
  label: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  pkce?: boolean;
  // Provider-specific claim path overrides (defaults on the server are sub/email).
  extra?: Record<string, unknown>;
  // The endpoints contain `{tenant}`, filled from a tenant the user supplies.
  tenanted?: boolean;
}

export const OAUTH_PROVIDER_CATALOG: OAuthProviderCatalogEntry[] = [
  {
    id: "google",
    label: "Google",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
    pkce: true,
  },
  {
    id: "github",
    label: "GitHub",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    scopes: ["read:user", "user:email"],
    extra: { subjectJsonPath: "id", nameJsonPath: "name" },
  },
  {
    id: "microsoft",
    label: "Microsoft",
    // Tenant-scoped, never `common`, `organizations` or `consumers`. Those accept a
    // sign-in from any Entra tenant, and every tenant's administrator controls the
    // email its users present.
    authorizationUrl:
      "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
    userInfoUrl: "https://graph.microsoft.com/oidc/userinfo",
    scopes: ["openid", "email", "profile"],
    pkce: true,
    tenanted: true,
    // The profile comes from the verified ID token. `xms_edov` is the optional claim
    // saying the tenant verified the email's domain; add it to the app registration's
    // token configuration. Users imported with source `entra-id` are matched on `oid`.
    extra: {
      issuer: "https://login.microsoftonline.com/{tenant}/v2.0",
      jwksUri: "https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys",
      emailVerifiedJsonPath: "xms_edov",
      externalIdSource: "entra-id",
      externalIdJsonPath: "oid",
    },
  },
  {
    id: "gitlab",
    label: "GitLab",
    authorizationUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    userInfoUrl: "https://gitlab.com/oauth/userinfo",
    scopes: ["openid", "email", "profile"],
    pkce: true,
  },
];

// A provider the user chose plus the credentials they supplied (either may be blank).
export interface CollectedOAuthProvider {
  catalog: OAuthProviderCatalogEntry;
  clientId: string;
  clientSecret: string;
  /** For a tenanted provider: the directory (tenant) id. */
  tenant?: string;
}

const MULTI_TENANT = new Set(["common", "organizations", "consumers"]);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a tenant value cannot be used, or undefined when it can (blank is allowed). */
export function tenantProblem(value: string): string | undefined {
  const tenant = value.trim();
  if (!tenant) return undefined;
  if (MULTI_TENANT.has(tenant.toLowerCase())) {
    return `"${tenant}" accepts sign-ins from any tenant. Use your directory (tenant) id.`;
  }
  if (!GUID.test(tenant)) {
    // ID tokens name the tenant by its GUID in `iss`, so a domain here would never
    // match the issuer and every sign-in would be refused.
    return "Use the directory (tenant) id, a GUID. Find it on the Entra admin center's overview page.";
  }
  return undefined;
}

function secretEnvName(id: string): string {
  return `${id.toUpperCase().replace(/-/g, "_")}_CLIENT_SECRET`;
}

// Turns the chosen providers into the auth-server env: the OAUTH_PROVIDERS JSON, a
// per-provider client-secret env var, and OAUTH_STATE_SECRET. A provider missing
// either credential is scaffolded disabled (so the stack still boots) and reported
// in `pending` so the CLI can tell the user what to fill in.
export function buildOAuthAuthEnv(providers: CollectedOAuthProvider[]): {
  env: Record<string, string>;
  pending: string[];
} {
  const env: Record<string, string> = {};
  const pending: string[] = [];

  const configs = providers.map(({ catalog, clientId, clientSecret, tenant = "" }) => {
    const envName = secretEnvName(catalog.id);
    const ready =
      clientId.length > 0 && clientSecret.length > 0 && (!catalog.tenanted || tenant.length > 0);
    if (!ready) pending.push(catalog.label);
    const withTenant = (url: string) =>
      url.replace("{tenant}", tenant || `REPLACE_WITH_${catalog.id.toUpperCase()}_TENANT_ID`);

    env[envName] = clientSecret;

    return {
      id: catalog.id,
      name: catalog.label,
      enabled: ready,
      clientId: clientId || `REPLACE_WITH_${catalog.id.toUpperCase()}_CLIENT_ID`,
      clientSecretEnv: envName,
      authorizationUrl: withTenant(catalog.authorizationUrl),
      tokenUrl: withTenant(catalog.tokenUrl),
      userInfoUrl: catalog.userInfoUrl,
      scopes: catalog.scopes,
      redirectUri: REDIRECT_URI,
      redirectUris: [REDIRECT_URI],
      ...(catalog.pkce ? { pkce: true } : {}),
      ...Object.fromEntries(
        Object.entries(catalog.extra ?? {}).map(([key, value]) => [
          key,
          typeof value === "string" ? withTenant(value) : value,
        ]),
      ),
    };
  });

  env.OAUTH_PROVIDERS = JSON.stringify(configs);
  env.OAUTH_STATE_SECRET = generateSecret(32);

  return { env, pending };
}

// Ensures a login method is present in a comma-separated LOGIN_METHODS value.
export function withLoginMethod(current: string | undefined, method: string): string {
  const methods = (current ?? "passkey,magic_link")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (!methods.includes(method)) methods.push(method);
  return methods.join(",");
}
