import { randomBytes } from "crypto";
import type { Profile } from "./config.js";

const SERVICE = "seamless-cli";

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  /**
   * Set when the session came from the OpenID Provider. It only picks which step-up to
   * offer; the instance decides what a session may do.
   */
  signIn?: "loopback" | "device";
}

export const KEYCHAIN_REQUIRED_MESSAGE =
  "Signing in needs an OS keychain to store the session, and this machine has none it can use. The CLI never keeps tokens in a file. On a headless machine, install and unlock one (for example gnome-keyring in a D-Bus session), or sign in from a machine with a keychain.";

const PREFLIGHT_ACCOUNT = "__seamless_cli_keychain_preflight__";

export class KeychainUnavailableError extends Error {
  constructor(cause?: unknown, message?: string) {
    super(
      message ??
      "No OS keychain is available. Set SEAMLESS_REFRESH_TOKEN to authenticate in a headless environment, or run on a machine with a keychain (macOS Keychain, Windows Credential Manager, or Linux Secret Service).",
    );
    this.name = "KeychainUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface KeychainBackend {
  get(account: string): string | null;
  set(account: string, secret: string): void;
  delete(account: string): boolean;
}

export function accountKey(
  profile: Pick<Profile, "name" | "instanceUrl">,
): string {
  return `${profile.name}::${profile.instanceUrl}`;
}

function isNoEntry(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no (matching )?entry/i.test(message) || /not found/i.test(message);
}

let backend: KeychainBackend | null = null;

async function loadBackend(): Promise<KeychainBackend> {
  if (backend) return backend;

  let Entry: typeof import("@napi-rs/keyring").Entry;
  try {
    ({ Entry } = await import("@napi-rs/keyring"));
  } catch (err) {
    throw new KeychainUnavailableError(err);
  }

  backend = {
    get(account) {
      try {
        return new Entry(SERVICE, account).getPassword();
      } catch (err) {
        if (isNoEntry(err)) return null;
        throw new KeychainUnavailableError(err);
      }
    },
    set(account, secret) {
      try {
        new Entry(SERVICE, account).setPassword(secret);
      } catch (err) {
        throw new KeychainUnavailableError(err);
      }
    },
    delete(account) {
      try {
        return new Entry(SERVICE, account).deletePassword();
      } catch (err) {
        if (isNoEntry(err)) return false;
        throw new KeychainUnavailableError(err);
      }
    },
  };

  return backend;
}

export function setBackendForTesting(fake: KeychainBackend | null): void {
  backend = fake;
}

/**
 * Run before a sign-in, so nobody approves one that could not be stored. Writes as well as
 * reads, because a locked keychain can answer a read. Uses its own entry, so a stored
 * session is never at risk.
 */
export async function assertKeychainUsable(): Promise<void> {
  try {
    const b = await loadBackend();
    const probe = randomBytes(16).toString("hex");
    b.set(PREFLIGHT_ACCOUNT, probe);
    const read = b.get(PREFLIGHT_ACCOUNT);
    b.delete(PREFLIGHT_ACCOUNT);
    if (read !== probe) throw new KeychainUnavailableError();
  } catch (err) {
    if (!(err instanceof KeychainUnavailableError)) throw err;
    throw new KeychainUnavailableError(err, KEYCHAIN_REQUIRED_MESSAGE);
  }
}

export async function saveTokens(
  profile: Pick<Profile, "name" | "instanceUrl">,
  bundle: TokenBundle,
): Promise<void> {
  const b = await loadBackend();
  b.set(accountKey(profile), JSON.stringify(bundle));
}

/**
 * The refresh token supplied by the environment, for a run with no keychain (CI).
 *
 * Worth knowing about separately from `getTokens`, because it is read fresh on every
 * run: the instance rotates the refresh token on every `/refresh` and treats a second
 * use of a spent one as theft, revoking the whole session chain. So a rotated token
 * cannot be persisted anywhere this will read it back, and a run that rotates leaves
 * the environment holding a token that must not be sent again.
 */
export function headlessRefreshToken(): string | undefined {
  return process.env.SEAMLESS_REFRESH_TOKEN?.trim() || undefined;
}

export async function getTokens(
  profile: Pick<Profile, "name" | "instanceUrl">,
): Promise<TokenBundle | null> {
  const envRefresh = headlessRefreshToken();
  if (envRefresh) {
    return { accessToken: "", refreshToken: envRefresh };
  }

  const b = await loadBackend();
  const raw = b.get(accountKey(profile));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as TokenBundle;
  } catch {
    return null;
  }
}

export async function deleteTokens(
  profile: Pick<Profile, "name" | "instanceUrl">,
): Promise<boolean> {
  const b = await loadBackend();
  return b.delete(accountKey(profile));
}
