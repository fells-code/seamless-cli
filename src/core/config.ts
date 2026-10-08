import type { IdentifierType } from "@seamless-auth/types";
import fs from "fs";
import os from "os";
import path from "path";

export type { IdentifierType };

export interface Profile {
  name: string;
  instanceUrl: string;
  sub?: string;
  email?: string;
  identifierType?: IdentifierType;
}

export interface SeamlessConfig {
  activeProfile: string;
  profiles: Record<string, Profile>;
  // The Seamless portal session. There is exactly one, so it lives beside the
  // profile map rather than inside it: profiles are auth instances a developer
  // administers, the portal is the managed control plane's own account.
  portal?: Profile;
}

export const DEFAULT_PROFILE_NAME = "default";

// Reserved profile name for the portal session's keychain entry, so it can never
// collide with a developer's own profile (see assertUsableProfileName).
export const PORTAL_PROFILE_NAME = "__portal__";

// The portal's first-party auth instance (portal-auth in seamless-iac), which
// issues the sessions api.seamlessauth.com accepts. Paired with getPortalApiUrl
// in core/portal.ts, which lives there to avoid an import cycle.
export const DEFAULT_PORTAL_AUTH_URL = "https://seamless.seamlessauth.com";

export function getPortalAuthUrl(): string {
  const override = process.env.SEAMLESS_PORTAL_AUTH_URL?.trim();
  return normalizeInstanceUrl(override || DEFAULT_PORTAL_AUTH_URL);
}

export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "seamless");
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

function emptyConfig(): SeamlessConfig {
  return { activeProfile: DEFAULT_PROFILE_NAME, profiles: {} };
}

function coerceProfile(name: string, value: unknown): Profile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.instanceUrl !== "string") return undefined;

  const profile: Profile = { name, instanceUrl: raw.instanceUrl };
  if (typeof raw.sub === "string") profile.sub = raw.sub;
  if (typeof raw.email === "string") profile.email = raw.email;
  if (raw.identifierType === "email" || raw.identifierType === "phone") {
    profile.identifierType = raw.identifierType;
  }
  return profile;
}

function normalizeLoaded(parsed: unknown): SeamlessConfig {
  if (!parsed || typeof parsed !== "object") return emptyConfig();
  const raw = parsed as Record<string, unknown>;

  const profiles: Record<string, Profile> = {};
  if (raw.profiles && typeof raw.profiles === "object") {
    for (const [name, value] of Object.entries(
      raw.profiles as Record<string, unknown>,
    )) {
      const profile = coerceProfile(name, value);
      if (profile) profiles[name] = profile;
    }
  }

  const active =
    typeof raw.activeProfile === "string" && raw.activeProfile
      ? raw.activeProfile
      : DEFAULT_PROFILE_NAME;

  const config: SeamlessConfig = { activeProfile: active, profiles };

  const portal = coerceProfile(PORTAL_PROFILE_NAME, raw.portal);
  if (portal) config.portal = portal;

  return config;
}

export function loadConfig(): SeamlessConfig {
  const file = getConfigPath();
  if (!fs.existsSync(file)) return emptyConfig();

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(
      `Unable to read config at ${file}: ${(err as Error).message}`,
    );
  }

  try {
    return normalizeLoaded(JSON.parse(raw));
  } catch {
    throw new Error(
      `Config at ${file} is not valid JSON. Fix or remove it and try again.`,
    );
  }
}

export function saveConfig(config: SeamlessConfig): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const file = getConfigPath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function listProfiles(config: SeamlessConfig = loadConfig()): Profile[] {
  return Object.values(config.profiles);
}

export function getProfile(
  name: string,
  config: SeamlessConfig = loadConfig(),
): Profile | undefined {
  return config.profiles[name];
}

export function upsertProfile(profile: Profile): SeamlessConfig {
  const config = loadConfig();
  config.profiles[profile.name] = profile;
  if (!config.profiles[config.activeProfile]) {
    config.activeProfile = profile.name;
  }
  saveConfig(config);
  return config;
}

export function removeProfile(name: string): SeamlessConfig {
  const config = loadConfig();
  if (!config.profiles[name]) {
    throw new Error(`Profile "${name}" does not exist.`);
  }

  delete config.profiles[name];
  if (config.activeProfile === name) {
    config.activeProfile = Object.keys(config.profiles)[0] ?? DEFAULT_PROFILE_NAME;
  }

  saveConfig(config);
  return config;
}

export function setActiveProfile(name: string): SeamlessConfig {
  const config = loadConfig();
  if (!config.profiles[name]) {
    throw new Error(
      `Profile "${name}" does not exist. Add it with "seamless profile add ${name}".`,
    );
  }

  config.activeProfile = name;
  saveConfig(config);
  return config;
}

export function resolveActiveProfileName(
  opts: { profileFlag?: string } = {},
  config: SeamlessConfig = loadConfig(),
): string {
  return (
    opts.profileFlag?.trim() ||
    process.env.SEAMLESS_PROFILE?.trim() ||
    config.activeProfile ||
    DEFAULT_PROFILE_NAME
  );
}

export function getActiveProfile(
  opts: { profileFlag?: string } = {},
): Profile | undefined {
  const config = loadConfig();
  return config.profiles[resolveActiveProfileName(opts, config)];
}

// Rejects the reserved portal name so a developer's profile can never share a
// keychain account with the portal session.
export function assertUsableProfileName(name: string): void {
  if (name === PORTAL_PROFILE_NAME) {
    throw new Error(
      `"${PORTAL_PROFILE_NAME}" is reserved for the portal session. Pick another profile name.`,
    );
  }
}

// The stored portal session, but only when it belongs to the portal the CLI is
// currently pointed at. Switching SEAMLESS_PORTAL_AUTH_URL therefore reads as
// logged out rather than silently reusing a session from the other host, whose
// tokens are keyed to that host anyway.
export function getPortalSession(
  config: SeamlessConfig = loadConfig(),
): Profile | undefined {
  const portal = config.portal;
  if (!portal) return undefined;
  return portal.instanceUrl === getPortalAuthUrl() ? portal : undefined;
}

export function savePortalSession(session: Omit<Profile, "name">): SeamlessConfig {
  const config = loadConfig();
  config.portal = { ...session, name: PORTAL_PROFILE_NAME };
  saveConfig(config);
  return config;
}

export function clearPortalSession(): SeamlessConfig {
  const config = loadConfig();
  delete config.portal;
  saveConfig(config);
  return config;
}

const LOCAL_HOSTS = new Set(["localhost", "::1", "[::1]", "::", "[::]"]);

/** An IPv4 dotted quad, as four numbers, or null when the host is not one. */
function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : NaN,
  );
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

function isPrivateIpv4(host: string): boolean {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets;

  if (a === 127) return true; // loopback, the whole /8 rather than just .0.1
  if (a === 0) return true; // 0.0.0.0, what a dev server binds to for "every interface"
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true; // /12, so not 172.32+
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

function isPrivateIpv6(host: string): boolean {
  // URL.hostname keeps the brackets on an IPv6 literal.
  const inner = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1).toLowerCase()
    : null;
  if (!inner) return false;
  // fc00::/7 unique-local and fe80::/10 link-local. Matching on the leading group
  // is enough here: a global address never opens with one of these.
  return /^f[cd]/.test(inner) || /^fe[89ab]/.test(inner);
}

/**
 * Whether a URL points at something on the developer's own machine or network.
 *
 * Gates two things: allowing plaintext http, and `--local` OTP delivery, which asks
 * the instance to return the code in the response body. A dev instance is commonly
 * reached at something other than localhost, a container bound to `0.0.0.0`, a LAN
 * address from a phone on the same network, or an mDNS `.local` name, and refusing
 * those forced https onto a box that has no certificate.
 */
export function isLocalInstanceUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL((input ?? "").trim());
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    LOCAL_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local") ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  );
}

export function normalizeInstanceUrl(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    throw new Error("Instance URL is required.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid instance URL: "${input}". Include the scheme, for example https://auth.example.com.`,
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `Instance URL must use http or https, got "${url.protocol}".`,
    );
  }

  const host = url.hostname;
  if (url.protocol === "http:" && !isLocalInstanceUrl(trimmed)) {
    throw new Error(
      `Instance URL must use https for non-local host "${host}".`,
    );
  }

  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}
