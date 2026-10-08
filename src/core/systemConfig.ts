import {
  AvailableRolesResponseSchema,
  OAuthProviderConfigSchema,
  SystemConfigPatchSchema,
  SystemConfigSchema,
  UpdateSystemConfigResponseSchema,
  type OAuthProviderConfig,
  type SystemConfigPatch,
  type UpdateSystemConfigResponse,
} from "@seamless-auth/types";
import { z } from "zod";
import type { AuthClient } from "./authClient.js";
import { scrubTokens } from "./redact.js";

// What an instance stores, typed with the shared schema's input side but every key
// optional and others allowed: the instance may be older or newer than this CLI's
// types. Reads are deliberately not parsed with SystemConfigSchema. Its defaults
// would invent keys an older instance does not have, and its value rules (which can
// tighten between versions) would make `config get` fail on a value the instance
// accepted. Only the shape is checked.
export type SystemConfig = Partial<z.input<typeof SystemConfigSchema>> &
  Record<string, unknown>;

// What a config file or `config set` supplies, before the instance validates it.
export type SystemConfigInput = Record<string, unknown>;

// The keys `config set` and `config apply` send. The instance's patch schema is
// strict and rejects the whole patch over one key it does not know, so a key goes
// here only once a released auth API accepts it, never on a types bump alone (see
// "Config keys ahead of the API" in AGENTS.md). `satisfies` ties each entry to the
// shared patch schema, and a test fails when that schema gains a key that is in
// neither this list nor NOT_YET_WRITABLE, so a bump cannot add one unnoticed.
export const WRITABLE_KEYS = [
  "app_name",
  "default_roles",
  "available_roles",
  "login_methods",
  "passkey_login_fallback_enabled",
  "prompt_passkey_enrollment",
  "phishing_resistant_only",
  "oauth_providers",
  "lockout_policy",
  "authenticator_policy",
  "access_token_ttl",
  "session_idle_ttl",
  "refresh_token_ttl",
  "max_concurrent_sessions",
  "rate_limit",
  "delay_after",
  "flow_rate_limits",
  "rpid",
  "origins",
  "magic_link_redirect_uris",
] as const satisfies readonly (keyof SystemConfigPatch)[];

// In the shared patch schema but not yet accepted by a released auth API this CLI
// can rely on, each with the ticket that tracks it. Move a key to WRITABLE_KEYS
// once it is.
export const NOT_YET_WRITABLE = {} as const satisfies Partial<
  Record<keyof SystemConfigPatch, string>
>;

const WRITABLE = new Set<string>(WRITABLE_KEYS);

const KNOWN = new Set<string>(Object.keys(SystemConfigSchema.shape));

export class PermissionError extends Error {
  constructor(
    message = "You do not have permission for this action. It requires an admin role on the instance.",
  ) {
    super(message);
    this.name = "PermissionError";
  }
}

export class ConfigApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigApiError";
  }
}

const ConfigObjectSchema = z.record(z.string(), z.unknown());

export async function getSystemConfig(
  client: AuthClient,
): Promise<SystemConfig> {
  const res = await client.get<unknown>("/system-config/admin");
  if (res.status === 403) throw new PermissionError();
  if (!res.ok) {
    throw new ConfigApiError(`Could not read system config (${res.status}).`);
  }
  const parsed = ConfigObjectSchema.safeParse(res.data);
  if (!parsed.success) {
    throw new ConfigApiError(
      "The instance returned a system config this CLI cannot read.",
    );
  }
  return parsed.data as SystemConfig;
}

export async function getRoles(client: AuthClient): Promise<string[]> {
  const res = await client.get<unknown>("/system-config/roles");
  if (res.status === 403) throw new PermissionError();
  if (!res.ok) {
    throw new ConfigApiError(`Could not read roles (${res.status}).`);
  }
  const parsed = AvailableRolesResponseSchema.safeParse(res.data);
  if (!parsed.success) {
    throw new ConfigApiError("The instance returned a role list this CLI cannot read.");
  }
  return parsed.data.roles;
}

export type PatchResult = UpdateSystemConfigResponse;

export async function patchSystemConfig(
  client: AuthClient,
  patch: SystemConfigInput,
): Promise<PatchResult> {
  const res = await client.request<{
    success?: boolean;
    updatedKeys?: string[];
    error?: string;
    details?: unknown;
  }>("/system-config/admin", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });

  if (res.status === 403) throw new PermissionError();
  if (res.status === 400) {
    const reason = res.data?.error ?? "Invalid configuration";
    const details = res.data?.details
      ? ` ${JSON.stringify(scrubTokens(res.data.details))}`
      : "";
    throw new ConfigApiError(`${reason}.${details}`);
  }
  if (!res.ok) {
    throw new ConfigApiError(`Could not update system config (${res.status}).`);
  }

  // The patch has been applied by now, so an answer this CLI cannot read is reported
  // as no keys listed rather than as a failure.
  const parsed = UpdateSystemConfigResponseSchema.safeParse(res.data);
  return parsed.success ? parsed.data : { success: true, updatedKeys: [] };
}

// A provider as the instance stores it. As with SystemConfig, reads are not parsed
// with OAuthProviderConfigSchema, whose defaults would invent settings; only the id
// every provider has is checked.
export type OAuthProvider = Partial<z.input<typeof OAuthProviderConfigSchema>> &
  Pick<OAuthProviderConfig, "id"> &
  Record<string, unknown>;

// What `oauth-providers add` and `update` read from the developer, before the
// instance validates it.
export type OAuthProviderInput = Record<string, unknown>;

const StoredProviderSchema = OAuthProviderConfigSchema.pick({ id: true }).loose();

const ProviderListSchema = z.object({ providers: z.array(StoredProviderSchema) });

const ProviderEnvelopeSchema = z.object({ provider: StoredProviderSchema });

const OAUTH_PROVIDERS_PATH = "/system-config/oauth-providers";

function providerMutationError(
  res: { status: number; data: { error?: string; details?: unknown } | null },
  action: string,
  id?: unknown,
): never {
  if (res.status === 403) throw new PermissionError();

  const label = id ? ` "${String(id)}"` : "";
  if (res.status === 404) {
    throw new ConfigApiError(`OAuth provider${label} not found.`);
  }
  if (res.status === 409) {
    throw new ConfigApiError(
      res.data?.error ?? `OAuth provider${label} already exists.`,
    );
  }
  if (res.status === 400) {
    const reason = res.data?.error ?? "Invalid OAuth provider";
    const details = res.data?.details
      ? ` ${JSON.stringify(scrubTokens(res.data.details))}`
      : "";
    throw new ConfigApiError(`${reason}.${details}`);
  }
  throw new ConfigApiError(`Could not ${action} OAuth provider (${res.status}).`);
}

export async function listOAuthProviders(
  client: AuthClient,
): Promise<OAuthProvider[]> {
  const res = await client.get<unknown>(OAUTH_PROVIDERS_PATH);
  if (res.status === 403) throw new PermissionError();
  if (!res.ok) {
    throw new ConfigApiError(`Could not list OAuth providers (${res.status}).`);
  }
  const parsed = ProviderListSchema.safeParse(res.data);
  if (!parsed.success) {
    throw new ConfigApiError(
      "The instance returned an OAuth provider list this CLI cannot read.",
    );
  }
  return parsed.data.providers as OAuthProvider[];
}

// Like a config patch, a provider change has been applied by the time this reads
// the answer, so one it cannot read falls back to what was sent.
function providerFrom(data: unknown): OAuthProvider | undefined {
  const parsed = ProviderEnvelopeSchema.safeParse(data);
  return parsed.success ? (parsed.data.provider as OAuthProvider) : undefined;
}

export async function createOAuthProvider(
  client: AuthClient,
  provider: OAuthProviderInput,
): Promise<OAuthProviderInput> {
  const res = await client.request<{ error?: string; details?: unknown }>(
    OAUTH_PROVIDERS_PATH,
    {
    method: "POST",
    headers: { "Content-Type": "application/json" },
      body: JSON.stringify(provider),
    },
  );

  if (res.ok) return providerFrom(res.data) ?? provider;
  throw providerMutationError(res, "add", provider.id);
}

export async function updateOAuthProvider(
  client: AuthClient,
  id: string,
  updates: OAuthProviderInput,
): Promise<OAuthProviderInput> {
  const res = await client.request<{ error?: string; details?: unknown }>(
    `${OAUTH_PROVIDERS_PATH}/${encodeURIComponent(id)}`,
    {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    },
  );

  if (res.ok) return providerFrom(res.data) ?? updates;
  throw providerMutationError(res, "update", id);
}

export async function deleteOAuthProvider(
  client: AuthClient,
  id: string,
): Promise<void> {
  const res = await client.request<{ error?: string; details?: unknown }>(
    `${OAUTH_PROVIDERS_PATH}/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );

  if (res.ok) return;
  throw providerMutationError(res, "remove", id);
}

// The writable keys the shared patch schema types as a plain string. Their values are
// never JSON-parsed, so `config set app_name 123` sends the string "123" rather than
// the number 123, and `config set rpid true` sends "true". Everything else is parsed
// as JSON, falling back to the raw string, which is what makes `access_token_ttl 15m`
// work: a TTL is string-typed, but the fallback would have carried it anyway.
const STRING_KEYS = new Set<string>(
  WRITABLE_KEYS.filter((key) => {
    const field = SystemConfigPatchSchema.shape[key];
    return field instanceof z.ZodOptional && field.unwrap() instanceof z.ZodString;
  }),
);

export function isStringKey(key: string): boolean {
  return STRING_KEYS.has(key);
}

export function parseValue(raw: string, key?: string): unknown {
  const trimmed = raw.trim();
  if (key !== undefined && STRING_KEYS.has(key)) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

export function isWritableKey(key: string): boolean {
  return WRITABLE.has(key);
}

// Whether the shared config schema has this key at all, as opposed to a key the
// instance has but does not let a patch change.
export function isKnownKey(key: string): boolean {
  return KNOWN.has(key);
}

export function filterWritable(config: SystemConfigInput): {
  patch: SystemConfigInput;
  readOnly: string[];
  unknown: string[];
} {
  const patch: SystemConfigInput = {};
  const readOnly: string[] = [];
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (WRITABLE.has(key)) patch[key] = value;
    else if (KNOWN.has(key)) readOnly.push(key);
    else unknown.push(key);
  }
  return { patch, readOnly, unknown };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    );
  }

  return false;
}

export interface ConfigChange {
  key: string;
  from: unknown;
  to: unknown;
}

export function diffConfig(
  local: SystemConfigInput,
  remote: SystemConfig,
): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const [key, to] of Object.entries(local)) {
    if (!deepEqual(remote[key], to)) {
      changes.push({ key, from: remote[key], to });
    }
  }
  return changes;
}
