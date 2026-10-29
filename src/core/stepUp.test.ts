import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => {
  const CANCEL = Symbol("cancel");
  return { CANCEL, text: vi.fn(), isCancel: (v: unknown) => v === CANCEL };
});

vi.mock("./tty.js", () => ({ isInteractive: vi.fn(() => true) }));

import { CANCEL, text } from "@clack/prompts";
import type { AuthClient } from "./authClient.js";
import { CancelledError } from "./cancel.js";
import type { ApiResponse } from "./http.js";
import { PermissionError } from "./permissionError.js";
import {
  authenticatorAppStepUp,
  forbidden,
  isFactorRejection,
  isStepUpRequired,
  MAX_CODE_ATTEMPTS,
  NO_AUTHENTICATOR_MESSAGE,
  STEP_UP_REQUIRED_MESSAGE,
  StepUpError,
  TOTP_CODE_ENV,
} from "./stepUp.js";
import { isInteractive } from "./tty.js";

function response(
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): ApiResponse<unknown> {
  return {
    ok: status >= 200 && status < 300,
    status,
    data,
    headers: new Headers(headers),
  };
}

const enrolled = response(200, { enabled: true, verifiedAt: null, lastUsedAt: null });
const verified = response(200, {
  message: "Success",
  fresh: true,
  method: "totp",
  verifiedAt: "2026-10-28T00:00:00.000Z",
  expiresAt: "2026-10-28T00:05:00.000Z",
  maxAgeSeconds: 300,
});
const wrongCode = response(401, { error: "totp_verification_failed" });

function fakeClient(
  status: ApiResponse<unknown>,
  verifies: ApiResponse<unknown>[],
): { client: AuthClient; codes: string[] } {
  const codes: string[] = [];
  let i = 0;
  const client: AuthClient = {
    profile: { name: "default", instanceUrl: "https://auth.example.com" },
    get: vi.fn(async (path: string) => {
      expect(path).toBe("/totp/status");
      return status;
    }) as AuthClient["get"],
    post: vi.fn(async (path: string, body?: unknown) => {
      expect(path).toBe("/totp/verify-mfa");
      codes.push((body as { code: string }).code);
      return verifies[Math.min(i++, verifies.length - 1)];
    }) as AuthClient["post"],
    request: vi.fn() as AuthClient["request"],
  };
  return { client, codes };
}

let stderr: string[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(text).mockReset();
  vi.mocked(isInteractive).mockReturnValue(true);
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function answers(...values: unknown[]): void {
  for (const value of values) vi.mocked(text).mockResolvedValueOnce(value as never);
}

describe("response classification", () => {
  it("tells step_up_required apart from a missing admin role", () => {
    const stepUp = response(403, { error: "step_up_required", fresh: false });
    const role = response(403, { error: "Forbidden" });

    expect(isStepUpRequired(stepUp)).toBe(true);
    expect(isStepUpRequired(role)).toBe(false);
    expect(isStepUpRequired(response(403, null))).toBe(false);
    expect(isStepUpRequired(response(401, { error: "step_up_required" }))).toBe(false);

    expect(forbidden(stepUp)).toBeInstanceOf(StepUpError);
    expect(forbidden(stepUp).message).toBe(STEP_UP_REQUIRED_MESSAGE);
    const plain = forbidden(role);
    expect(plain).toBeInstanceOf(PermissionError);
    expect(plain).not.toBeInstanceOf(StepUpError);
    expect(plain.message).toMatch(/requires an admin role/);
  });

  it("treats only a rejected code as a factor rejection", () => {
    expect(isFactorRejection(wrongCode)).toBe(true);
    expect(isFactorRejection(response(401, { error: "unauthorized" }))).toBe(false);
    expect(isFactorRejection(response(400, { error: "totp_verification_failed" }))).toBe(false);
  });
});

describe("authenticatorAppStepUp: prompting", () => {
  it("prompts for a code, sends it, and returns once verified", async () => {
    answers("123456");
    const { client, codes } = fakeClient(enrolled, [verified]);

    await authenticatorAppStepUp({})(client);

    expect(codes).toEqual(["123456"]);
    expect(stderr.join("")).toContain("needs a fresh step-up");
    const options = vi.mocked(text).mock.calls[0][0];
    expect(options.message).toBe("Enter the code from your authenticator app");
    expect(options.output).toBe(process.stderr);
  });

  it("strips the spaces an app shows inside a code", async () => {
    answers(" 123 456 ");
    const { client, codes } = fakeClient(enrolled, [verified]);

    await authenticatorAppStepUp({})(client);

    expect(codes).toEqual(["123456"]);
  });

  it("validates the shape of a code before sending it", async () => {
    answers("123456");
    const { client } = fakeClient(enrolled, [verified]);
    await authenticatorAppStepUp({})(client);

    const validate = vi.mocked(text).mock.calls[0][0].validate!;
    expect(validate("123456")).toBeUndefined();
    expect(validate("123 456")).toBeUndefined();
    expect(validate("12345")).toMatch(/6 digits/);
    expect(validate("abcdef")).toMatch(/6 digits/);
    expect(validate(undefined)).toMatch(/6 digits/);
  });

  it("re-prompts after a wrong code and succeeds on a later attempt", async () => {
    answers("111111", "222222");
    const { client, codes } = fakeClient(enrolled, [wrongCode, verified]);

    await authenticatorAppStepUp({})(client);

    expect(codes).toEqual(["111111", "222222"]);
    expect(vi.mocked(text).mock.calls[1][0].message).toBe(
      "Enter a new code from your authenticator app",
    );
    expect(stderr.join("")).toContain("That code was not accepted");
  });

  it(`gives up after ${MAX_CODE_ATTEMPTS} wrong codes`, async () => {
    answers("111111", "222222", "333333", "444444");
    const { client, codes } = fakeClient(enrolled, [wrongCode]);

    const err = await authenticatorAppStepUp({})(client).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StepUpError);
    expect((err as Error).message).toMatch(/None of the 3 codes was accepted/);
    expect(codes).toHaveLength(MAX_CODE_ATTEMPTS);
  });

  it("reads a cancelled prompt as a cancellation", async () => {
    answers(CANCEL);
    const { client, codes } = fakeClient(enrolled, [verified]);

    await expect(authenticatorAppStepUp({})(client)).rejects.toBeInstanceOf(
      CancelledError,
    );
    expect(codes).toEqual([]);
  });

  it("fails without a terminal and names the environment variable", async () => {
    vi.mocked(isInteractive).mockReturnValue(false);
    const { client, codes } = fakeClient(enrolled, [verified]);

    const err = await authenticatorAppStepUp({})(client).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StepUpError);
    expect((err as Error).message).toBe(STEP_UP_REQUIRED_MESSAGE);
    expect((err as Error).message).toContain(TOTP_CODE_ENV);
    expect(text).not.toHaveBeenCalled();
    expect(codes).toEqual([]);
  });
});

describe("authenticatorAppStepUp: enrollment", () => {
  it("stops before asking when no authenticator app is enrolled", async () => {
    const { client, codes } = fakeClient(
      response(200, { enabled: false, verifiedAt: null, lastUsedAt: null }),
      [verified],
    );

    const err = await authenticatorAppStepUp({})(client).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StepUpError);
    expect((err as Error).message).toBe(NO_AUTHENTICATOR_MESSAGE);
    expect(text).not.toHaveBeenCalled();
    expect(codes).toEqual([]);
  });

  it.each([
    ["an unreadable status", response(200, { something: "else" })],
    ["a failed status call", response(500, { error: "boom" })],
  ])("goes on to verify after %s", async (_label, status) => {
    answers("123456");
    const { client, codes } = fakeClient(status, [verified]);

    await authenticatorAppStepUp({})(client);

    expect(codes).toEqual(["123456"]);
  });
});

describe("authenticatorAppStepUp: the environment code", () => {
  it(`uses ${TOTP_CODE_ENV} without prompting`, async () => {
    vi.mocked(isInteractive).mockReturnValue(false);
    const { client, codes } = fakeClient(enrolled, [verified]);

    await authenticatorAppStepUp({ [TOTP_CODE_ENV]: " 654 321 " })(client);

    expect(codes).toEqual(["654321"]);
    expect(text).not.toHaveBeenCalled();
  });

  it("uses the environment code once, then needs a terminal", async () => {
    vi.mocked(isInteractive).mockReturnValue(false);
    const { client } = fakeClient(enrolled, [verified]);
    const stepUp = authenticatorAppStepUp({ [TOTP_CODE_ENV]: "654321" });

    await stepUp(client);
    await expect(stepUp(client)).rejects.toThrow(STEP_UP_REQUIRED_MESSAGE);
  });

  it("names the variable when its code is rejected without a terminal", async () => {
    vi.mocked(isInteractive).mockReturnValue(false);
    const { client, codes } = fakeClient(enrolled, [wrongCode]);

    const err = await authenticatorAppStepUp({ [TOTP_CODE_ENV]: "654321" })(
      client,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StepUpError);
    expect((err as Error).message).toMatch(
      new RegExp(`The code in ${TOTP_CODE_ENV} was not accepted`),
    );
    expect(codes).toEqual(["654321"]);
  });

  it("falls back to the prompt when the environment code is rejected in a terminal", async () => {
    answers("222222");
    const { client, codes } = fakeClient(enrolled, [wrongCode, verified]);

    await authenticatorAppStepUp({ [TOTP_CODE_ENV]: "111111" })(client);

    expect(codes).toEqual(["111111", "222222"]);
  });

  it("refuses a malformed environment code without sending it", async () => {
    const { client, codes } = fakeClient(enrolled, [verified]);

    await expect(
      authenticatorAppStepUp({ [TOTP_CODE_ENV]: "abc" })(client),
    ).rejects.toThrow(`${TOTP_CODE_ENV} is not a code from an authenticator app`);
    expect(codes).toEqual([]);
  });

  it("ignores a blank environment variable", async () => {
    answers("123456");
    const { client, codes } = fakeClient(enrolled, [verified]);

    await authenticatorAppStepUp({ [TOTP_CODE_ENV]: "   " })(client);

    expect(codes).toEqual(["123456"]);
    expect(text).toHaveBeenCalledTimes(1);
  });

  it("reads process.env by default", async () => {
    vi.mocked(isInteractive).mockReturnValue(false);
    vi.stubEnv(TOTP_CODE_ENV, "987654");
    const { client, codes } = fakeClient(enrolled, [verified]);

    await authenticatorAppStepUp()(client);

    expect(codes).toEqual(["987654"]);
    vi.unstubAllEnvs();
  });
});

describe("authenticatorAppStepUp: verify errors", () => {
  async function failWith(res: ApiResponse<unknown>): Promise<Error> {
    answers("123456");
    const { client } = fakeClient(enrolled, [res]);
    return authenticatorAppStepUp({})(client).catch((e: unknown) => e as Error);
  }

  it.each([
    [1, "1 second"],
    [45, "45 seconds"],
    [60, "1 minute"],
    [61, "2 minutes"],
    [900, "15 minutes"],
  ])("reports a lockout of %i seconds as %s", async (seconds, wait) => {
    const err = await failWith(
      response(423, {
        error: "account_locked",
        message: "Too many failed authentication attempts. Try again later.",
        retryAfterSeconds: seconds,
      }),
    );
    expect(err).toBeInstanceOf(StepUpError);
    expect(err.message).toBe(
      `Your account is locked after too many failed attempts. Try again in ${wait}.`,
    );
  });

  it("reports a lockout with no wait as a few minutes", async () => {
    const err = await failWith(response(423, { error: "account_locked" }));
    expect(err.message).toMatch(/Try again in a few minutes\./);
  });

  it("reports a rate limit with its Retry-After header", async () => {
    const err = await failWith(response(429, null, { "retry-after": "120" }));
    expect(err).toBeInstanceOf(StepUpError);
    expect(err.message).toBe("Too many code attempts. Wait 2 minutes and run the command again.");
  });

  it.each([
    ["no header", {}],
    ["a blank header", { "retry-after": " " }],
    ["a date header", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }],
  ])("reports a rate limit with %s as a few minutes", async (_label, headers) => {
    const err = await failWith(response(429, { error: "Too many requests" }, headers));
    expect(err.message).toBe(
      "Too many code attempts. Wait a few minutes and run the command again.",
    );
  });

  it("reports any other failure with its status", async () => {
    const err = await failWith(response(500, { error: "boom" }));
    expect(err).toBeInstanceOf(StepUpError);
    expect(err.message).toBe("Could not verify the authenticator app code (500).");
  });
});
