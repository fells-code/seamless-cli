import type { TokenBundle } from "./keychain.js";

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
