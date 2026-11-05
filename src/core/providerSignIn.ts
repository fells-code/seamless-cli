import {
  SESSION_EXCHANGE_GRANT_TYPE,
  SESSION_EXCHANGE_ISSUED_TOKEN_TYPE,
  SESSION_EXCHANGE_SCOPE,
  SESSION_EXCHANGE_SUBJECT_TOKEN_TYPE,
  SessionExchangeRequestSchema,
  SessionExchangeResponseSchema,
} from "@seamless-auth/types";
import { createHash, randomBytes } from "crypto";
import { createServer, type Server } from "http";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { AddressInfo } from "net";
import { z } from "zod";
import { apiRequest, joinUrl, jsonBody, safeJson } from "./http.js";
import type { TokenBundle } from "./keychain.js";
import { openBrowser as defaultOpenBrowser } from "./openBrowser.js";
import { tokensFromAuthResponse } from "./tokenResponse.js";

export const PROVIDER_SCOPE = `openid ${SESSION_EXCHANGE_SCOPE}`;
export const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_SECONDS = 5;
const SLOW_DOWN_SECONDS = 5;
const CALLBACK_PATH = "/callback";

const CLIENT_SETTINGS_HINT =
  "The client must be a first-party public client with a loopback redirect, with sessionExchangeEnabled on (and the device grant, for --device).";

export class ProviderSignInError extends Error {
  constructor(
    message: string,
    readonly replayed = false,
  ) {
    super(message);
    this.name = "ProviderSignInError";
  }
}

export interface ProviderMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint?: string;
  jwksUri: string;
  issParameterSupported: boolean;
}

/** What a provider sign-in hands to the exchange. The access token goes no further. */
export interface ProviderSubject {
  accessToken: string;
  sub: string;
}

export interface ExchangedSession {
  tokens: TokenBundle;
  sub?: string;
  email?: string;
}

export function normalizeIssuer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderSignInError(`"${value}" is not a valid issuer URL.`);
  }
  if (url.protocol !== "https:") {
    throw new ProviderSignInError(`The issuer must use https, not ${url.protocol}`);
  }
  if (url.search || url.hash) {
    throw new ProviderSignInError("The issuer cannot have a query or a fragment.");
  }
  return value.replace(/\/+$/, "");
}

export function builtInResource(issuer: string): string {
  return `${issuer}/seamless`;
}

const httpsUrl = z.url().refine((value) => value.startsWith("https://"), "must be https");

// scopes_supported is deliberately not read: session:exchange is expected to be absent
// from it, because the scope belongs to one resource rather than to the provider.
const DiscoverySchema = z
  .object({
    issuer: z.string(),
    authorization_endpoint: httpsUrl,
    token_endpoint: httpsUrl,
    device_authorization_endpoint: httpsUrl.optional(),
    jwks_uri: httpsUrl,
    code_challenge_methods_supported: z.array(z.string()).optional(),
    authorization_response_iss_parameter_supported: z.boolean().optional(),
  })
  .loose();

export async function discoverProvider(issuer: string): Promise<ProviderMetadata> {
  const url = `${issuer}/.well-known/openid-configuration`;
  let res;
  try {
    res = await apiRequest<unknown>(url, { redirect: "error" });
  } catch {
    throw new ProviderSignInError(`Could not read the provider's discovery document at ${url}.`);
  }
  if (!res.ok) {
    throw new ProviderSignInError(`The provider's discovery document at ${url} answered ${res.status}.`);
  }

  const parsed = DiscoverySchema.safeParse(res.data);
  if (!parsed.success) {
    throw new ProviderSignInError(`The discovery document at ${url} is not one this CLI can use.`);
  }
  const doc = parsed.data;
  if (doc.issuer !== issuer) {
    throw new ProviderSignInError(
      `The discovery document at ${url} names issuer ${doc.issuer}, not ${issuer}.`,
    );
  }
  if (!doc.code_challenge_methods_supported?.includes("S256")) {
    throw new ProviderSignInError(`The provider at ${issuer} does not offer PKCE S256.`);
  }

  return {
    issuer: doc.issuer,
    authorizationEndpoint: doc.authorization_endpoint,
    tokenEndpoint: doc.token_endpoint,
    ...(doc.device_authorization_endpoint
      ? { deviceAuthorizationEndpoint: doc.device_authorization_endpoint }
      : {}),
    jwksUri: doc.jwks_uri,
    issParameterSupported: doc.authorization_response_iss_parameter_supported === true,
  };
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

// What the provider or a local program put in a query string reaches a terminal.
function printable(value: string | null | undefined): string {
  return (value ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 200);
}

const TokenResponseSchema = z
  .object({ access_token: z.string().optional(), id_token: z.string().optional() })
  .loose();

const OAuthErrorSchema = z
  .object({ error: z.string(), error_description: z.string().optional() })
  .loose();

function describeOAuthError(data: unknown): { error?: string; text: string } {
  const parsed = OAuthErrorSchema.safeParse(data);
  if (!parsed.success) return { text: "" };
  const error = printable(parsed.data.error);
  const description = printable(parsed.data.error_description);
  return { error, text: description ? `${error}: ${description}` : error };
}

async function verifyIdToken(
  idToken: string | undefined,
  metadata: ProviderMetadata,
  clientId: string,
  nonce?: string,
): Promise<string> {
  if (!idToken) throw new ProviderSignInError("The provider did not return an ID token.");

  let keys;
  try {
    const res = await apiRequest<JSONWebKeySet>(metadata.jwksUri, { redirect: "error" });
    if (!res.ok || !res.data) throw new Error(String(res.status));
    keys = createLocalJWKSet(res.data);
  } catch {
    throw new ProviderSignInError(`Could not read the provider's signing keys at ${metadata.jwksUri}.`);
  }

  let claims;
  try {
    ({ payload: claims } = await jwtVerify(idToken, keys, {
      issuer: metadata.issuer,
      audience: clientId,
      requiredClaims: ["sub", "exp", "iat"],
    }));
  } catch (err) {
    throw new ProviderSignInError(`The ID token did not verify: ${printable((err as Error).message)}.`);
  }
  if (nonce !== undefined && claims.nonce !== nonce) {
    throw new ProviderSignInError("The ID token's nonce does not match this sign-in.");
  }
  return claims.sub as string;
}

async function subjectFromTokens(
  data: unknown,
  metadata: ProviderMetadata,
  clientId: string,
  nonce?: string,
): Promise<ProviderSubject> {
  const parsed = TokenResponseSchema.safeParse(data);
  const accessToken = parsed.data?.access_token;
  if (!accessToken) {
    throw new ProviderSignInError("The provider did not return an access token.");
  }
  const sub = await verifyIdToken(parsed.data?.id_token, metadata, clientId, nonce);
  return { accessToken, sub };
}

function postForm(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
}

interface CallbackListener {
  redirectUri: string;
  callback: Promise<URLSearchParams>;
  close(): void;
}

const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>Seamless CLI</title>
<p>You can close this tab and go back to your terminal.</p>`;

// RFC 8252: the loopback IP only, not "localhost" and not every interface. The first GET
// to the callback path settles the sign-in, whatever it says: state decides below whether
// it was the real one, and the port closes either way.
function listenForCallback(timeoutMs: number): Promise<CallbackListener> {
  return new Promise((resolve, reject) => {
    let settle: (params: URLSearchParams) => void = () => {};
    let refuse: (err: Error) => void = () => {};
    const callback = new Promise<URLSearchParams>((res, rej) => {
      settle = res;
      refuse = rej;
    });
    // The caller may not be awaiting yet when the timer fires.
    callback.catch(() => {});

    let timer: NodeJS.Timeout | undefined;
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'",
        Connection: "close",
      });
      res.end(CALLBACK_PAGE, () => close());
      settle(url.searchParams);
    });

    const close = (): void => {
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    };

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      timer = setTimeout(() => {
        close();
        refuse(new ProviderSignInError("Timed out waiting for the browser sign-in."));
      }, timeoutMs);
      const { port } = server.address() as AddressInfo;
      resolve({
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        callback,
        close,
      });
    });
  });
}

function checkCallback(
  params: URLSearchParams,
  state: string,
  metadata: ProviderMetadata,
): string {
  if (params.get("state") !== state) {
    throw new ProviderSignInError(
      "The browser returned a sign-in with the wrong state, so it was refused. Sign in again.",
    );
  }
  const iss = params.get("iss");
  if (iss !== metadata.issuer && (iss !== null || metadata.issParameterSupported)) {
    throw new ProviderSignInError(
      "The browser returned a sign-in whose iss does not name this provider, so it was refused.",
    );
  }
  const error = params.get("error");
  if (error) {
    const description = printable(params.get("error_description"));
    const safe = printable(error);
    const hint =
      safe === "invalid_target" || safe === "invalid_scope" || safe === "unauthorized_client"
        ? ` ${CLIENT_SETTINGS_HINT}`
        : "";
    throw new ProviderSignInError(
      `The provider refused the sign-in: ${safe}${description ? `: ${description}` : ""}.${hint}`,
    );
  }
  const code = params.get("code");
  if (!code) throw new ProviderSignInError("The browser returned no authorization code.");
  return code;
}

export interface LoopbackOptions {
  metadata: ProviderMetadata;
  clientId: string;
  say: (line: string) => void;
  openBrowser?: (url: string) => Promise<boolean>;
  acrValues?: string;
  maxAge?: number;
  timeoutMs?: number;
}

/** RFC 8252: authorization code with PKCE, through the system browser, to a loopback redirect. */
export async function signInWithLoopback(opts: LoopbackOptions): Promise<ProviderSubject> {
  const { metadata, clientId, say } = opts;
  const open = opts.openBrowser ?? defaultOpenBrowser;
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();

  const listener = await listenForCallback(opts.timeoutMs ?? LOOPBACK_TIMEOUT_MS);
  try {
    const resource = builtInResource(metadata.issuer);
    const authorize = new URL(metadata.authorizationEndpoint);
    authorize.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      scope: PROVIDER_SCOPE,
      redirect_uri: listener.redirectUri,
      resource,
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      ...(opts.acrValues ? { acr_values: opts.acrValues } : {}),
      ...(opts.maxAge !== undefined ? { max_age: String(opts.maxAge) } : {}),
    }).toString();

    say(
      'Opening your browser to sign in. It will ask "Continue to <app>?": check that it names this CLI and your account, then continue.',
    );
    if (!(await open(authorize.href))) {
      say(`Could not open a browser. Open this URL yourself:\n\n  ${authorize.href}\n`);
      say("On a machine with no browser, run this again with --device.");
    }

    const code = checkCallback(await listener.callback, state, metadata);

    let res;
    try {
      res = await postForm(metadata.tokenEndpoint, {
        client_id: clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: listener.redirectUri,
        code_verifier: verifier,
        resource,
      });
    } catch {
      throw new ProviderSignInError(`Could not reach the provider's token endpoint at ${metadata.tokenEndpoint}.`);
    }
    const data = await safeJson<unknown>(res);
    if (!res.ok) {
      const { text } = describeOAuthError(data);
      throw new ProviderSignInError(
        `The provider's token endpoint refused the sign-in (${res.status})${text ? `: ${text}` : ""}.`,
      );
    }
    return await subjectFromTokens(data, metadata, clientId, nonce);
  } finally {
    listener.close();
  }
}

const DeviceAuthorizationSchema = z
  .object({
    device_code: z.string(),
    user_code: z.string(),
    verification_uri: httpsUrl,
    expires_in: z.number().positive(),
    interval: z.number().positive().optional(),
  })
  .loose();

export interface DeviceOptions {
  metadata: ProviderMetadata;
  clientId: string;
  say: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * RFC 8628. Takes no acr_values or max_age: the provider refuses them here, since an
 * approval made on another machine cannot speak for whoever holds this terminal.
 */
export async function signInWithDevice(opts: DeviceOptions): Promise<ProviderSubject> {
  const { metadata, clientId, say } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  const endpoint = metadata.deviceAuthorizationEndpoint;
  if (!endpoint) {
    throw new ProviderSignInError(`The provider at ${metadata.issuer} does not offer device sign-in.`);
  }

  let started;
  try {
    started = await postForm(endpoint, {
      client_id: clientId,
      scope: PROVIDER_SCOPE,
      resource: builtInResource(metadata.issuer),
    });
  } catch {
    throw new ProviderSignInError(`Could not reach the provider's device endpoint at ${endpoint}.`);
  }
  const startedData = await safeJson<unknown>(started);
  if (!started.ok) {
    const { text } = describeOAuthError(startedData);
    throw new ProviderSignInError(
      `The provider refused the device sign-in (${started.status})${text ? `: ${text}` : ""}. ${CLIENT_SETTINGS_HINT}`,
    );
  }
  const parsed = DeviceAuthorizationSchema.safeParse(startedData);
  if (!parsed.success) {
    throw new ProviderSignInError("The provider's device response is not one this CLI can read.");
  }
  const device = parsed.data;

  say(`On any device with a browser, open:\n\n  ${printable(device.verification_uri)}\n`);
  say(`and enter this code:\n\n  ${printable(device.user_code)}\n`);
  say("Only continue if you started this sign-in yourself. Waiting for approval...");

  const deadline = now() + device.expires_in * 1000;
  const expired = (): ProviderSignInError =>
    new ProviderSignInError("The device code expired before it was approved. Sign in again.");

  let interval = device.interval ?? DEFAULT_POLL_SECONDS;
  for (;;) {
    await sleep(interval * 1000);
    if (now() >= deadline) throw expired();

    let res;
    try {
      res = await postForm(metadata.tokenEndpoint, {
        client_id: clientId,
        grant_type: DEVICE_GRANT,
        device_code: device.device_code,
      });
    } catch {
      // RFC 8628 section 3.5: a connection timeout backs off. The code stays good until
      // it expires, and a response lost here shows up as the next poll's invalid_grant.
      interval *= 2;
      continue;
    }

    const data = await safeJson<unknown>(res);
    if (res.ok) return subjectFromTokens(data, metadata, clientId);

    const { error, text } = describeOAuthError(data);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += SLOW_DOWN_SECONDS;
      continue;
    }
    if (error === "expired_token") throw expired();
    if (error === "access_denied") {
      throw new ProviderSignInError("The sign-in was denied in the browser.");
    }
    throw new ProviderSignInError(
      `The provider refused the device sign-in (${res.status})${text ? `: ${text}` : ""}. Sign in again.`,
    );
  }
}

const SIGN_IN_AGAIN = "Sign in again: seamless profile login.";

/**
 * The token works once. Nothing here may send it twice, on any failure: a retry after a
 * lost response is a replay, and a replay revokes the session the first attempt created.
 */
export async function exchangeForSession(
  instanceUrl: string,
  subjectToken: string,
): Promise<ExchangedSession> {
  const body = SessionExchangeRequestSchema.parse({
    grant_type: SESSION_EXCHANGE_GRANT_TYPE,
    subject_token: subjectToken,
    subject_token_type: SESSION_EXCHANGE_SUBJECT_TOKEN_TYPE,
    requested_token_type: SESSION_EXCHANGE_ISSUED_TOKEN_TYPE,
  });

  let res;
  try {
    res = await apiRequest<Record<string, unknown>>(
      joinUrl(instanceUrl, "/sessions/exchange"),
      jsonBody("POST", body),
    );
  } catch {
    throw new ProviderSignInError(
      `Could not reach ${instanceUrl} to finish signing in. The token works only once, so it is not sent again. ${SIGN_IN_AGAIN}`,
    );
  }

  if (res.ok) {
    const parsed = SessionExchangeResponseSchema.loose().safeParse(res.data);
    const tokens = parsed.success ? tokensFromAuthResponse(res.data) : null;
    if (!parsed.success || !tokens) {
      throw new ProviderSignInError(
        `The instance returned a session this CLI cannot read. ${SIGN_IN_AGAIN}`,
      );
    }
    return { tokens, sub: parsed.data.sub, email: parsed.data.email };
  }

  if (res.status === 429) {
    throw new ProviderSignInError(
      "The instance is rate limiting sign-ins from this address. Wait a few minutes, then sign in again.",
    );
  }
  if (res.status === 404) {
    throw new ProviderSignInError(
      `${instanceUrl} has no session exchange route, so it needs auth server v0.23 or later. Use --email-code until then.`,
    );
  }
  if (res.status === 400 && res.data?.error_description === "token_already_used") {
    throw new ProviderSignInError(
      `This sign-in's token had already been used, so the instance revoked the session it created. Your sign-in may have been intercepted. Check your sessions with seamless sessions, then sign in again.`,
      true,
    );
  }
  if (res.status === 400) {
    throw new ProviderSignInError(
      `The instance refused the sign-in. The token lasts 60 seconds, and the client needs sessionExchangeEnabled on. ${SIGN_IN_AGAIN}`,
    );
  }
  throw new ProviderSignInError(
    `The instance failed while finishing the sign-in (${res.status}). The token works only once, so it is not sent again. ${SIGN_IN_AGAIN}`,
  );
}

/** Best effort: for a session this CLI got and will not keep. */
export async function endSession(instanceUrl: string, accessToken: string): Promise<boolean> {
  try {
    const res = await apiRequest(joinUrl(instanceUrl, "/logout"), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}
