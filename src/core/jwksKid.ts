import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

import { parseEnv } from "./env.js";
import { apiRequest, joinUrl } from "./http.js";

// The placeholder adapters fall back to and warn about (an exact match, not a prefix).
export const DEV_JWKS_KID = "dev-main";

const COMPOSE_JWKS_KID = /^\s*JWKS_KID:\s*["']?([^"'\s]+)["']?\s*$/m;

export function generateLocalJwksKid(): string {
  return `local-${randomBytes(6).toString("hex")}`;
}

/**
 * The JWKS_KID for a local scaffold: the one an earlier run wrote into the backend's
 * .env or the compose file, so a re-run keeps it, or a new `local-<hex>` name.
 */
export function resolveLocalJwksKid(root: string, backendDir: string): string {
  const envPath = path.join(root, backendDir, ".env");
  const composePath = path.join(root, "docker-compose.yml");
  const candidates = [
    fs.existsSync(envPath) ? parseEnv(envPath).JWKS_KID : undefined,
    fs.existsSync(composePath)
      ? COMPOSE_JWKS_KID.exec(fs.readFileSync(composePath, "utf-8"))?.[1]
      : undefined,
  ];
  return (
    candidates.find((kid) => kid && kid !== DEV_JWKS_KID) ??
    generateLocalJwksKid()
  );
}

/**
 * A name for JWKS_KID on an app connected to a managed instance.
 *
 * Adapters use JWKS_KID only as the `kid` header on the HS256 service tokens they
 * sign with the service secret. Nothing verifies against it: the auth server checks
 * those tokens by secret, and adapters resolve the server's RSA keys from each
 * token's own `kid` through the remote JWKS. Adapters do warn on boot while it is
 * unset or the `dev-main` placeholder, so any other stable name will do. This
 * borrows the instance's active RSA kid (`trialkey1`, `paidkey1`) for that name; it
 * does not mean the service tokens are signed with that key.
 *
 * Returns undefined rather than throwing: the kid is cosmetic, and an instance that
 * is slow to come up should not fail a scaffold over it.
 */
export async function fetchActiveJwksKid(
  instanceUrl: string,
): Promise<string | undefined> {
  let res;
  try {
    res = await apiRequest<{ keys?: unknown }>(
      joinUrl(instanceUrl, "/.well-known/jwks.json"),
      { method: "GET" },
    );
  } catch {
    return undefined;
  }

  if (!res.ok || !Array.isArray(res.data?.keys)) return undefined;

  // Take the first RS256 signing key. The endpoint lists the active key first, and
  // a set carrying a retired key alongside it keeps that one later in the array.
  for (const key of res.data.keys) {
    if (!key || typeof key !== "object") continue;
    const record = key as Record<string, unknown>;
    if (typeof record.kid !== "string" || !record.kid) continue;
    if (record.use !== undefined && record.use !== "sig") continue;
    if (record.alg !== undefined && record.alg !== "RS256") continue;
    return record.kid;
  }

  return undefined;
}
