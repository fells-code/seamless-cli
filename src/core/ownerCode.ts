import fs from "fs";
import path from "path";
import { parseEnv } from "./env.js";
import { apiRequest, isRateLimited, joinUrl, jsonBody } from "./http.js";
import { deliveryCode } from "./loginFlow.js";

export const LOCAL_AUTH_URL = "http://localhost:5312";

const EXTERNAL_DELIVERY_HEADER = "x-seamless-auth-delivery-mode";

export class OwnerCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerCodeError";
  }
}

// OWNER_EMAIL may list several addresses; the first is the one init asked for.
function firstAddress(value: string | undefined): string | undefined {
  return value
    ?.split(",")
    .map((address) => address.trim())
    .find(Boolean);
}

function composeFileOf(root: string): string {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(root, "seamless.config.json"), "utf-8"),
    );
    const file = config?.docker?.composeFile;
    if (typeof file === "string" && file) return file;
  } catch {
    // No config, or not JSON: fall back to the name init always writes.
  }
  return "docker-compose.yml";
}

/**
 * The owner address init wrote to auth/.env. Projects scaffolded before that file
 * existed for --auth=docker have it inline in the compose file's auth service.
 */
export function findOwnerEmail(root: string): string | undefined {
  const envPath = path.join(root, "auth", ".env");
  if (fs.existsSync(envPath)) {
    const fromEnv = firstAddress(parseEnv(envPath).OWNER_EMAIL);
    if (fromEnv) return fromEnv;
  }

  const composePath = path.join(root, composeFileOf(root));
  if (fs.existsSync(composePath)) {
    const match = /^\s*OWNER_EMAIL:\s*(?:"([^"]*)"|(\S+))\s*$/m.exec(
      fs.readFileSync(composePath, "utf-8"),
    );
    return firstAddress(match?.[1] ?? match?.[2]);
  }

  return undefined;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWaiting?: () => void;
}

async function isHealthy(authUrl: string): Promise<boolean> {
  try {
    const res = await fetch(joinUrl(authUrl, "/health/status"));
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitForAuthServer(
  authUrl: string,
  opts: WaitOptions = {},
): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.timeoutMs ?? 120_000);
  const interval = opts.intervalMs ?? 2_000;

  if (await isHealthy(authUrl)) return;
  opts.onWaiting?.();

  while (now() < deadline) {
    await sleep(interval);
    if (await isHealthy(authUrl)) return;
  }

  throw new OwnerCodeError(
    `The auth server at ${authUrl} did not come up. Start the stack with docker compose up, then run this again.`,
  );
}

/**
 * Issues a fresh email code for the address through registration, with external
 * delivery so it comes back in the response.
 *
 * The auth server keeps one email code per account, so this code replaces whatever
 * the browser's own registration or sign-in sent and is accepted on that page. For an
 * address with no account yet, registration creates it, which is what grants the
 * owner its admin role.
 */
export async function requestOwnerCode(
  authUrl: string,
  email: string,
): Promise<string> {
  let res;
  try {
    res = await apiRequest<Record<string, unknown>>(
      joinUrl(authUrl, "/registration/register"),
      jsonBody("POST", { email }, { [EXTERNAL_DELIVERY_HEADER]: "external" }),
    );
  } catch {
    throw new OwnerCodeError(`Could not reach the auth server at ${authUrl}.`);
  }

  if (isRateLimited(res)) {
    throw new OwnerCodeError(
      "The auth server is rate limiting code requests. Wait a few minutes and try again.",
    );
  }
  if (res.status === 400) {
    throw new OwnerCodeError(`"${email}" is not a valid email address.`);
  }
  if (!res.ok) {
    throw new OwnerCodeError(`The auth server refused the request (${res.status}).`);
  }

  const code = deliveryCode(res.data);
  if (!code) {
    throw new OwnerCodeError(
      "The auth server did not return the code. It returns codes only outside production with ALLOW_UNCREDENTIALED_DELIVERY_SECRETS=true, which seamless init sets.",
    );
  }
  return code;
}
