import {
  getActiveProfile,
  getPortalSession,
  type Profile,
} from "./config.js";
import {
  deleteTokens,
  getTokens,
  headlessRefreshToken,
  KeychainUnavailableError,
  saveTokens,
  type TokenBundle,
} from "./keychain.js";
import { apiRequest, joinUrl, type ApiResponse } from "./http.js";
import {
  authenticatorAppStepUp,
  isFactorRejection,
  isStepUpRequired,
  type StepUpHandler,
} from "./stepUp.js";

export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

export interface AuthClient {
  profile: Profile;
  request<T = unknown>(path: string, init?: RequestInit): Promise<ApiResponse<T>>;
  get<T = unknown>(path: string, init?: RequestInit): Promise<ApiResponse<T>>;
  post<T = unknown>(
    path: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<ApiResponse<T>>;
}

export function tokensFromAuthResponse(
  data: Record<string, unknown> | null,
): TokenBundle | null {
  if (!data) return null;

  const accessToken = typeof data.token === "string" ? data.token : undefined;
  const refreshToken =
    typeof data.refreshToken === "string" ? data.refreshToken : undefined;
  if (!accessToken || !refreshToken) return null;

  const now = Date.now();
  const ttl = typeof data.ttl === "number" ? data.ttl : undefined;
  const refreshTtl =
    typeof data.refreshTtl === "number" ? data.refreshTtl : undefined;

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: ttl !== undefined ? now + ttl * 1000 : undefined,
    refreshTokenExpiresAt:
      refreshTtl !== undefined ? now + refreshTtl * 1000 : undefined,
  };
}

/**
 * Reads a `/refresh` response, keeping the current refresh token when the instance
 * did not send a new one.
 *
 * Separate from `tokensFromAuthResponse` because the two answer different questions.
 * A login must establish both tokens, and a response missing either is unusable. A
 * refresh only has to produce a usable access token: the response schema marks both
 * fields optional, so requiring the pair would wipe a session that is still valid
 * the first time an instance rotates only the access token.
 */
export function tokensFromRefreshResponse(
  data: Record<string, unknown> | null,
  current: TokenBundle,
): TokenBundle | null {
  if (!data) return null;

  const accessToken = typeof data.token === "string" ? data.token : undefined;
  if (!accessToken) return null;

  const rotated =
    typeof data.refreshToken === "string" && data.refreshToken
      ? data.refreshToken
      : undefined;

  const now = Date.now();
  const ttl = typeof data.ttl === "number" ? data.ttl : undefined;
  const refreshTtl =
    typeof data.refreshTtl === "number" ? data.refreshTtl : undefined;

  return {
    accessToken,
    refreshToken: rotated ?? current.refreshToken,
    accessTokenExpiresAt: ttl !== undefined ? now + ttl * 1000 : undefined,
    refreshTokenExpiresAt:
      refreshTtl !== undefined
        ? now + refreshTtl * 1000
        : // An unrotated token keeps the expiry it already had.
          rotated
          ? undefined
          : current.refreshTokenExpiresAt,
  };
}

// A client for an auth instance a developer administers, resolved from the active
// profile. Portal calls use createPortalClient instead: the two sessions are
// different accounts on different hosts and must never be interchanged.
export async function createAuthClient(
  opts: { profileFlag?: string; stepUp?: StepUpHandler } = {},
): Promise<AuthClient> {
  const profile = getActiveProfile(opts);
  if (!profile) {
    throw new ReauthRequiredError(
      "No active profile is configured. Add one with: seamless profile add <name> --instance-url <url>, then run seamless profile login <name>.",
    );
  }

  return createClientForProfile(
    profile,
    {
      label: `profile "${profile.name}"`,
      reauthCommand: `seamless profile login ${profile.name}`,
    },
    opts.stepUp ?? authenticatorAppStepUp(),
  );
}

// A client for the Seamless portal, used for control-plane calls
// (core/portal.ts). Absolute URLs pass through joinUrl untouched, so the same
// client reaches api.seamlessauth.com while refreshing against the portal's own
// auth host.
export async function createPortalClient(): Promise<AuthClient> {
  const session = getPortalSession();
  if (!session) {
    throw new ReauthRequiredError(
      "You are not signed in to the Seamless portal. Run: seamless login.",
    );
  }

  return createClientForProfile(session, {
    label: "the Seamless portal",
    reauthCommand: "seamless login",
  });
}

interface ReauthCopy {
  label: string;
  reauthCommand: string;
}

async function createClientForProfile(
  profile: Profile,
  copy: ReauthCopy,
  stepUp?: StepUpHandler,
): Promise<AuthClient> {
  const tokens = await getTokens(profile);
  if (!tokens || !tokens.refreshToken) {
    throw new ReauthRequiredError(
      `No session for ${copy.label}. Run: ${copy.reauthCommand}.`,
    );
  }
  const session = tokens;

  // A headless run reads SEAMLESS_REFRESH_TOKEN fresh every time, so the keychain is
  // never consulted and writing a rotated token there only makes it look preserved.
  const headless = headlessRefreshToken() !== undefined;

  const persist = async (next: TokenBundle): Promise<void> => {
    session.accessToken = next.accessToken;
    session.refreshToken = next.refreshToken;
    session.accessTokenExpiresAt = next.accessTokenExpiresAt;
    session.refreshTokenExpiresAt = next.refreshTokenExpiresAt;
    if (headless) return;
    try {
      await saveTokens(profile, next);
    } catch (err) {
      if (!(err instanceof KeychainUnavailableError)) throw err;
    }
  };

  const clearSession = async (): Promise<void> => {
    try {
      await deleteTokens(profile);
    } catch (err) {
      if (!(err instanceof KeychainUnavailableError)) throw err;
    }
  };

  const expiredMessage = (): string =>
    headless
      ? `The refresh token in SEAMLESS_REFRESH_TOKEN was rejected by ${copy.label}. The instance rotates the refresh token on every refresh and revokes the session if a spent one is sent again, so a token that has already been refreshed once cannot be reused on a later run. Issue a fresh one with: ${copy.reauthCommand}.`
      : `Your session for ${copy.label} has expired or was revoked. Run: ${copy.reauthCommand}.`;

  const runRefresh = async (): Promise<void> => {
    const res = await apiRequest<Record<string, unknown>>(
      joinUrl(profile.instanceUrl, "/refresh"),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${session.refreshToken}` },
      },
    );

    if (!res.ok) {
      await clearSession();
      throw new ReauthRequiredError(expiredMessage());
    }

    const next = tokensFromRefreshResponse(res.data, session);
    if (!next) {
      await clearSession();
      throw new ReauthRequiredError(
        `Received an unexpected refresh response from ${profile.instanceUrl}. Run: ${copy.reauthCommand}.`,
      );
    }

    await persist(next);
  };

  // Single-flight. The instance rotates the refresh token on every call and reads a
  // second use of the old one as theft, revoking the whole session chain, so two
  // concurrent refreshes would not merely race: they would log the developer out.
  let inFlight: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (!inFlight) {
      inFlight = runRefresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };

  let stepUpInFlight: Promise<void> | null = null;
  const runStepUp = (handler: StepUpHandler): Promise<void> => {
    if (!stepUpInFlight) {
      stepUpInFlight = handler(client).finally(() => {
        stepUpInFlight = null;
      });
    }
    return stepUpInFlight;
  };

  const send = async <T>(
    path: string,
    init: RequestInit,
  ): Promise<ApiResponse<T>> => {
    const build = (): RequestInit => ({
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${session.accessToken}`,
      },
    });

    const url = joinUrl(profile.instanceUrl, path);
    const sentWith = session.accessToken;
    let res = await apiRequest<T>(url, build());

    if (res.status === 401 && session.refreshToken && !isFactorRejection(res)) {
      // Only refresh if nothing else already did while this request was in flight.
      // Otherwise a burst of 401s against one stale token would each rotate again.
      if (session.accessToken === sentWith) {
        await refresh();
      }
      res = await apiRequest<T>(url, build());

      // A 401 on a freshly refreshed token is not something a caller can act on by
      // retrying, and returning it verbatim left commands reporting an opaque failure
      // instead of saying the session is gone.
      if (res.status === 401) {
        await clearSession();
        throw new ReauthRequiredError(
          `Your session for ${copy.label} was rejected after refreshing it. Run: ${copy.reauthCommand}.`,
        );
      }
    }

    return res;
  };

  // A write the instance refuses for want of a fresh step-up is retried once after
  // the handler steps up the same session. A second refusal goes back to the caller.
  const authedFetch = async <T>(
    path: string,
    init: RequestInit = {},
  ): Promise<ApiResponse<T>> => {
    const res = await send<T>(path, init);
    if (!stepUp || !isStepUpRequired(res)) return res;
    await runStepUp(stepUp);
    return send<T>(path, init);
  };

  const client: AuthClient = {
    profile,
    request: authedFetch,
    get: (path, init = {}) => authedFetch(path, { ...init, method: "GET" }),
    post: (path, body, init = {}) => {
      const headers: Record<string, string> = {
        ...(init.headers as Record<string, string> | undefined),
      };
      let bodyInit = init.body;
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        bodyInit = JSON.stringify(body);
      }
      return authedFetch(path, {
        ...init,
        method: "POST",
        headers,
        body: bodyInit,
      });
    },
  };
  return client;
}
