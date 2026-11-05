import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => {
  const CANCEL = Symbol("cancel");
  return {
    CANCEL,
    text: vi.fn(),
    select: vi.fn(),
    isCancel: (value: unknown) => value === CANCEL,
  };
});

vi.mock("./tty.js", () => ({ isInteractive: vi.fn(() => true) }));

vi.mock("./providerSignIn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providerSignIn.js")>();
  return {
    ...actual,
    discoverProvider: vi.fn(async () => ({ issuer: "https://auth.example.com" })),
    signInWithLoopback: vi.fn(async () => ({ accessToken: "subject", sub: "user-1" })),
    exchangeForSession: vi.fn(async () => ({
      tokens: { accessToken: "new-access", refreshToken: "new-refresh" },
      sub: "user-1",
    })),
  };
});

import { CANCEL, select, text } from "@clack/prompts";
import type { AuthClient } from "./authClient.js";
import { CancelledError } from "./cancel.js";
import type { Profile } from "./config.js";
import type { ApiResponse } from "./http.js";
import { exchangeForSession, signInWithLoopback } from "./providerSignIn.js";
import {
  DEVICE_NO_AUTHENTICATOR_MESSAGE,
  DEVICE_STEP_UP_REQUIRED_MESSAGE,
  sessionStepUp,
} from "./providerStepUp.js";
import { NO_AUTHENTICATOR_MESSAGE, StepUpError } from "./stepUp.js";
import { isInteractive } from "./tty.js";
import type { StepUpSession } from "./stepUp.js";
import type { TokenBundle } from "./keychain.js";

const INSTANCE = "https://api.example.com";
const provider: Profile = {
  name: "prod",
  instanceUrl: INSTANCE,
  sub: "user-1",
  oidcIssuer: "https://auth.example.com",
  oidcClientId: "cli-client",
};

function response(status: number, data: unknown): ApiResponse<unknown> {
  return { ok: status < 300, status, data, headers: new Headers() };
}

const enrolled = response(200, { enabled: true });
const notEnrolled = response(200, { enabled: false });
const verified = response(200, { message: "Success", fresh: true });

function fakeClient(status: ApiResponse<unknown> = enrolled) {
  const calls: string[] = [];
  const client = {
    profile: provider,
    get: vi.fn(async (path: string) => {
      calls.push(`GET ${path}`);
      return status;
    }),
    post: vi.fn(async (path: string) => {
      calls.push(`POST ${path}`);
      return verified;
    }),
    request: vi.fn(),
  };
  return { client: client as unknown as AuthClient, calls };
}

function fakeSession(signIn: TokenBundle["signIn"]): StepUpSession & {
  replaced: TokenBundle[];
} {
  const replaced: TokenBundle[] = [];
  return {
    replaced,
    signIn: () => signIn,
    replace: async (next) => {
      replaced.push(next);
    },
  };
}

let stderr: string;

beforeEach(() => {
  vi.mocked(text).mockReset();
  vi.mocked(select).mockReset();
  vi.mocked(isInteractive).mockReturnValue(true);
  vi.mocked(signInWithLoopback).mockClear();
  vi.mocked(exchangeForSession).mockClear();
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a device session", () => {
  it("steps up with an authenticator app code through /totp/verify-mfa", async () => {
    vi.mocked(text).mockResolvedValue("123456");
    const { client, calls } = fakeClient();
    await sessionStepUp({})(client, fakeSession("device"));
    expect(calls).toEqual(["GET /totp/status", "POST /totp/verify-mfa"]);
  });

  it("never offers a passkey", async () => {
    vi.mocked(text).mockResolvedValue("123456");
    const { client } = fakeClient();
    await sessionStepUp({})(client, fakeSession("device"));
    expect(select).not.toHaveBeenCalled();
    expect(signInWithLoopback).not.toHaveBeenCalled();
    expect(stderr).not.toMatch(/passkey/i);
  });

  it("explains why it is being asked, even for a read", async () => {
    vi.mocked(text).mockResolvedValue("123456");
    const { client } = fakeClient();
    await sessionStepUp({})(client, fakeSession("device"));
    expect(stderr).toMatch(/device/i);
    expect(stderr).toMatch(/even.*read/i);
  });

  it("accepts SEAMLESS_TOTP_CODE without a prompt", async () => {
    vi.mocked(isInteractive).mockReturnValue(false);
    const { client, calls } = fakeClient();
    await sessionStepUp({ SEAMLESS_TOTP_CODE: "123456" })(client, fakeSession("device"));
    expect(calls).toContain("POST /totp/verify-mfa");
    expect(text).not.toHaveBeenCalled();
  });

  it("says what to do without a terminal", async () => {
    vi.mocked(isInteractive).mockReturnValue(false);
    const { client } = fakeClient();
    await expect(sessionStepUp({})(client, fakeSession("device"))).rejects.toThrow(
      DEVICE_STEP_UP_REQUIRED_MESSAGE,
    );
  });

  it("with no authenticator, says why and sends the user to a browser, and does not enroll", async () => {
    const { client, calls } = fakeClient(notEnrolled);
    await expect(sessionStepUp({})(client, fakeSession("device"))).rejects.toThrow(
      DEVICE_NO_AUTHENTICATOR_MESSAGE,
    );
    expect(DEVICE_NO_AUTHENTICATOR_MESSAGE).toMatch(/browser/);
    expect(DEVICE_NO_AUTHENTICATOR_MESSAGE).toMatch(/--device/);
    expect(calls).toEqual(["GET /totp/status"]);
    expect(calls.join()).not.toContain("enroll");
    expect(text).not.toHaveBeenCalled();
  });
});

describe("a loopback session", () => {
  it("offers a passkey and the authenticator app when both are possible", async () => {
    vi.mocked(select).mockResolvedValue("totp");
    vi.mocked(text).mockResolvedValue("123456");
    const { client, calls } = fakeClient();
    await sessionStepUp({})(client, fakeSession("loopback"));
    const options = vi.mocked(select).mock.calls[0]?.[0].options as Array<{ value: string }>;
    expect(options.map((option) => option.value)).toEqual(["passkey", "totp"]);
    expect(calls).toContain("POST /totp/verify-mfa");
    expect(signInWithLoopback).not.toHaveBeenCalled();
  });

  it("signs in again with acr_values and max_age, exchanges, swaps the tokens and logs out the old session", async () => {
    vi.mocked(select).mockResolvedValue("passkey");
    const { client, calls } = fakeClient();
    const session = fakeSession("loopback");
    await sessionStepUp({})(client, session);

    expect(signInWithLoopback).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "cli-client", acrValues: "phr", maxAge: 300 }),
    );
    expect(exchangeForSession).toHaveBeenCalledWith(INSTANCE, "subject");
    expect(session.replaced).toEqual([
      { accessToken: "new-access", refreshToken: "new-refresh", signIn: "loopback" },
    ]);
    expect(calls).not.toContain("POST /totp/verify-mfa");
    // The old session is ended with its own token, by the session handle.
    expect(session.replaced).toHaveLength(1);
  });

  it("goes straight to the passkey when no authenticator is enrolled", async () => {
    const { client } = fakeClient(notEnrolled);
    await sessionStepUp({})(client, fakeSession("loopback"));
    expect(select).not.toHaveBeenCalled();
    expect(signInWithLoopback).toHaveBeenCalled();
  });

  it("uses SEAMLESS_TOTP_CODE without asking", async () => {
    const { client, calls } = fakeClient();
    await sessionStepUp({ SEAMLESS_TOTP_CODE: "123456" })(client, fakeSession("loopback"));
    expect(select).not.toHaveBeenCalled();
    expect(calls).toContain("POST /totp/verify-mfa");
  });

  it("does not open a browser without a terminal", async () => {
    vi.mocked(isInteractive).mockReturnValue(false);
    const { client } = fakeClient();
    await expect(sessionStepUp({})(client, fakeSession("loopback"))).rejects.toThrow(StepUpError);
    expect(signInWithLoopback).not.toHaveBeenCalled();
  });

  it("reads a cancelled choice as a cancel", async () => {
    vi.mocked(select).mockResolvedValue(CANCEL as never);
    const { client } = fakeClient();
    await expect(sessionStepUp({})(client, fakeSession("loopback"))).rejects.toBeInstanceOf(
      CancelledError,
    );
  });

  it("refuses a sign-in as another account and ends that new session", async () => {
    vi.mocked(select).mockResolvedValue("passkey");
    vi.mocked(signInWithLoopback).mockResolvedValueOnce({ accessToken: "subject", sub: "user-9" });
    vi.mocked(exchangeForSession).mockResolvedValueOnce({
      tokens: { accessToken: "other-access", refreshToken: "other-refresh" },
      sub: "user-9",
    });
    const { client } = fakeClient();
    const session = fakeSession("loopback");
    await expect(sessionStepUp({})(client, session)).rejects.toThrow(/another account/i);
    expect(session.replaced).toEqual([]);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${INSTANCE}/logout`);
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer other-access");
  });

  it("falls back to the authenticator app on a profile that lost its provider settings", async () => {
    vi.mocked(text).mockResolvedValue("123456");
    const { client, calls } = fakeClient();
    (client as { profile: Profile }).profile = { name: "prod", instanceUrl: INSTANCE };
    await sessionStepUp({})(client, fakeSession("loopback"));
    expect(select).not.toHaveBeenCalled();
    expect(calls).toContain("POST /totp/verify-mfa");
  });
});

describe("any other session", () => {
  it("is unchanged: the authenticator app, with the existing messages", async () => {
    const { client } = fakeClient(notEnrolled);
    await expect(sessionStepUp({})(client, fakeSession(undefined))).rejects.toThrow(
      NO_AUTHENTICATOR_MESSAGE,
    );
    expect(select).not.toHaveBeenCalled();
    expect(signInWithLoopback).not.toHaveBeenCalled();
  });

  it("treats a call with no session handle the same way", async () => {
    vi.mocked(text).mockResolvedValue("123456");
    const { client, calls } = fakeClient();
    await sessionStepUp({})(client);
    expect(calls).toContain("POST /totp/verify-mfa");
  });
});
