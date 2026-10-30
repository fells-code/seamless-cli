import { SEAMLESS_AUTH_API_COMMIT } from "./images.js";

/**
 * A GET whose connection-level failure says what it could not reach.
 *
 * When `fetch` never gets a response at all (offline, DNS, TLS, no route) it rejects
 * with a bare `TypeError: fetch failed`, which reaches the top-level handler as
 * "Error: fetch failed" and names neither the host nor what the CLI wanted from it.
 * A non-ok response is left to the caller, which knows what its status means.
 */
export async function fetchRemote(url: string, purpose: string): Promise<Response> {
  try {
    return await fetch(url);
  } catch (err) {
    throw new Error(
      `Could not reach ${url} to ${purpose}. Check your network connection.`,
      { cause: err },
    );
  }
}

export async function fetchEnvExample(): Promise<string> {
  const url =
    `https://raw.githubusercontent.com/fells-code/seamless-auth-api/${SEAMLESS_AUTH_API_COMMIT}/.env.example`;

  const res = await fetchRemote(url, "read the auth server's env.example");

  if (!res.ok) {
    throw new Error("Failed to fetch auth env.example");
  }

  return await res.text();
}
