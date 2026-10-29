import { isCancel, text } from "@clack/prompts";
import { TotpStatusSchema, TotpVerifyRequestSchema } from "@seamless-auth/types";
import kleur from "kleur";
import type { AuthClient } from "./authClient.js";
import { CancelledError } from "./cancel.js";
import type { ApiResponse } from "./http.js";
import { PermissionError } from "./permissionError.js";
import { isInteractive } from "./tty.js";

export const TOTP_CODE_ENV = "SEAMLESS_TOTP_CODE";

export const MAX_CODE_ATTEMPTS = 3;

export const STEP_UP_REQUIRED_MESSAGE = `This action needs a recent step-up: a code from your authenticator app, verified on this session within the last few minutes. Run the command in an interactive terminal to enter one, or set ${TOTP_CODE_ENV} to a current code.`;

export const NO_AUTHENTICATOR_MESSAGE =
  "This action needs a step-up with an authenticator app, and your account has none enrolled. Enroll one from the admin dashboard or your app, then run this again, or make this change from the dashboard.";

// Raised for every step-up failure. It is a PermissionError so the commands that
// already report one print its message rather than a stack trace.
export class StepUpError extends PermissionError {
  constructor(message: string) {
    super(message);
    this.name = "StepUpError";
  }
}

export type StepUpHandler = (client: AuthClient) => Promise<void>;

function errorCode(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const error = (data as Record<string, unknown>).error;
    if (typeof error === "string") return error;
  }
  return undefined;
}

// A missing admin role is also a 403, so only the error code tells the two apart.
export function isStepUpRequired(res: Pick<ApiResponse, "status" | "data">): boolean {
  return res.status === 403 && errorCode(res.data) === "step_up_required";
}

// A 401 that rejects a submitted code is an answer about the code, not about the
// access token, so it must not be treated as an expired session.
export function isFactorRejection(res: Pick<ApiResponse, "status" | "data">): boolean {
  return res.status === 401 && errorCode(res.data) === "totp_verification_failed";
}

export function forbidden(res: Pick<ApiResponse, "status" | "data">): PermissionError {
  return isStepUpRequired(res)
    ? new StepUpError(STEP_UP_REQUIRED_MESSAGE)
    : new PermissionError();
}

function describeWait(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return "a few minutes";
  }
  if (seconds < 60) {
    const s = Math.ceil(seconds);
    return `${s} second${s === 1 ? "" : "s"}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function retryAfterSeconds(res: ApiResponse<unknown>): number | undefined {
  if (res.data && typeof res.data === "object") {
    const value = (res.data as Record<string, unknown>).retryAfterSeconds;
    if (typeof value === "number") return value;
  }
  const header = res.headers.get("retry-after");
  return header === null || header.trim() === "" ? undefined : Number(header);
}

// Authenticator apps often show a code as "123 456".
function normalizeCode(raw: string): string {
  return raw.replace(/\s+/g, "");
}

const codeShape = TotpVerifyRequestSchema.shape.code;

function isWellFormed(code: string): boolean {
  return codeShape.safeParse(code).success;
}

async function requireEnrolledAuthenticator(client: AuthClient): Promise<void> {
  const res = await client.get<unknown>("/totp/status");
  // Only a definite "not enrolled" stops here. Anything else is left to the verify
  // call, which reports its own failures.
  if (!res.ok) return;
  const parsed = TotpStatusSchema.loose().safeParse(res.data);
  if (parsed.success && !parsed.data.enabled) {
    throw new StepUpError(NO_AUTHENTICATOR_MESSAGE);
  }
}

/**
 * Steps up the session with a code from the user's authenticator app, read from
 * SEAMLESS_TOTP_CODE once and otherwise from a prompt.
 *
 * The environment code is used at most once per process. A code is single use, so
 * a second step-up in the same run (a long migrate outlasting the window) needs a
 * new one, which only a terminal can supply.
 */
export function authenticatorAppStepUp(
  env: NodeJS.ProcessEnv = process.env,
): StepUpHandler {
  let envCode = env[TOTP_CODE_ENV]?.trim() || undefined;

  const nextCode = async (
    attempt: number,
  ): Promise<{ code: string; fromEnv: boolean }> => {
    if (envCode !== undefined) {
      const code = normalizeCode(envCode);
      envCode = undefined;
      if (!isWellFormed(code)) {
        throw new StepUpError(
          `${TOTP_CODE_ENV} is not a code from an authenticator app. Set it to the 6 digits the app shows.`,
        );
      }
      return { code, fromEnv: true };
    }

    if (!isInteractive()) throw new StepUpError(STEP_UP_REQUIRED_MESSAGE);

    if (attempt === 1) {
      process.stderr.write(
        `${kleur.yellow("This action needs a fresh step-up on your session.")}\n`,
      );
    }
    const answer = await text({
      message:
        attempt === 1
          ? "Enter the code from your authenticator app"
          : "Enter a new code from your authenticator app",
      placeholder: "123456",
      validate: (value) =>
        isWellFormed(normalizeCode(value ?? ""))
          ? undefined
          : "Enter the 6 digits your authenticator app shows",
      // Keeps stdout clean for commands printing --json.
      output: process.stderr,
    });
    if (isCancel(answer)) throw new CancelledError();
    return { code: normalizeCode(answer), fromEnv: false };
  };

  return async (client) => {
    await requireEnrolledAuthenticator(client);

    for (let attempt = 1; ; attempt++) {
      const { code, fromEnv } = await nextCode(attempt);
      const res = await client.post<unknown>("/totp/verify-mfa", { code });

      if (res.ok) return;

      if (isFactorRejection(res)) {
        if (attempt >= MAX_CODE_ATTEMPTS) {
          throw new StepUpError(
            `None of the ${MAX_CODE_ATTEMPTS} codes was accepted. Check that your device clock is correct and that the code is from this instance's entry in your authenticator app, then run the command again.`,
          );
        }
        if (fromEnv && !isInteractive()) {
          throw new StepUpError(
            `The code in ${TOTP_CODE_ENV} was not accepted. It may have expired or already been used; set a current one and run the command again.`,
          );
        }
        process.stderr.write(
          `${kleur.red("That code was not accepted. Codes are single use and change every 30 seconds.")}\n`,
        );
        continue;
      }

      if (res.status === 423) {
        throw new StepUpError(
          `Your account is locked after too many failed attempts. Try again in ${describeWait(retryAfterSeconds(res))}.`,
        );
      }

      if (res.status === 429) {
        throw new StepUpError(
          `Too many code attempts. Wait ${describeWait(retryAfterSeconds(res))} and run the command again.`,
        );
      }

      throw new StepUpError(
        `Could not verify the authenticator app code (${res.status}).`,
      );
    }
  };
}
