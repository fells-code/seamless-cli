import {
  AuthDeliverySchema,
  LoginSuccessResponseSchema,
  OTPVerifyTokenSuccessSchema,
  type IdentifierType,
  type LoginMethod,
} from "@seamless-auth/types";
import { z } from "zod";
import { apiRequest, isRateLimited, joinUrl, jsonBody } from "./http.js";
import { tokensFromAuthResponse } from "./authClient.js";
import type { TokenBundle } from "./keychain.js";

export const EPHEMERAL_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 3;

const EXTERNAL_DELIVERY_HEADER = "x-seamless-auth-delivery-mode";

export type LoginChannel = IdentifierType;

// The `/login` answer. A real account and a decoy are sent by the same responder, so
// this cannot tell them apart and must not try. `loginMethods` is read as strings
// rather than the LoginMethod enum: the instance validates the list against its own
// types, so a method added after this CLI was built would otherwise fail every login,
// and the check in completeLogin only needs to find the one method it asks for.
const LoginStartSchema = LoginSuccessResponseSchema.extend({
  loginMethods: z.array(z.string()).optional(),
}).loose();

const CodeSentSchema = z.object({ token: z.string().optional() }).loose();

const VerifiedSchema = OTPVerifyTokenSuccessSchema.loose();

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

export type LoginEvent =
  | { type: "code_sent"; channel: LoginChannel }
  | { type: "code_resent"; channel: LoginChannel }
  | { type: "code_expired"; channel: LoginChannel }
  | { type: "code_autofilled"; channel: LoginChannel }
  | { type: "verifying" }
  | { type: "incorrect"; attemptsLeft: number };

export interface LoginResult {
  tokens: TokenBundle;
  identity: { sub?: string; email?: string; identifierType: IdentifierType };
  channel: LoginChannel;
}

export interface CompleteLoginOptions {
  instanceUrl: string;
  identifier: string;
  maxAttempts?: number;
  now?: () => number;
  getCode: (ctx: {
    attempt: number;
    resent: boolean;
    channel: LoginChannel;
  }) => Promise<string | null>;
  notify?: (event: LoginEvent) => void;
  /**
   * Local-only escape hatch. Asks the instance for external delivery so the OTP
   * comes back in the response body instead of by email/SMS, then verifies with it
   * automatically. Requires the instance to run outside production with
   * ALLOW_UNCREDENTIALED_DELIVERY_SECRETS=true, and should be gated to local hosts.
   */
  localDelivery?: boolean;
}

interface StartedLogin {
  ephemeralToken: string;
  // Strings, not LoginMethod[]; see LoginStartSchema.
  loginMethods: string[];
  channel: LoginChannel;
  sub?: string;
  deadline: number;
}

// An SMS code arrives as a number (the API generates it with randomInt), so a check
// for a string alone dropped every phone code and failed `--local` phone logins.
function deliveryCode(data: Record<string, unknown> | null): string | undefined {
  const parsed = AuthDeliverySchema.safeParse(data?.delivery);
  if (!parsed.success) return undefined;
  const delivery = parsed.data;
  if (delivery.kind !== "otp_email" && delivery.kind !== "otp_sms") return undefined;
  const code = String(delivery.token);
  return code || undefined;
}

function apiMessage(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (typeof record.message === "string") return record.message;
  }
  return undefined;
}

function lockedMessage(
  data: Record<string, unknown> | null,
  identifier: string,
): string {
  const retryAfter = data?.retryAfterSeconds;
  const wait =
    typeof retryAfter === "number" && retryAfter > 0
      ? ` Try again in about ${Math.ceil(retryAfter / 60)} minute(s).`
      : "";
  return `Too many failed attempts for ${identifier}.${wait}`;
}

async function request(
  instanceUrl: string,
  url: string,
  init: RequestInit,
) {
  try {
    return await apiRequest<Record<string, unknown>>(url, init);
  } catch {
    throw new LoginError(
      `Could not reach ${instanceUrl}. Check the instance URL and your connection.`,
    );
  }
}

async function startLogin(
  instanceUrl: string,
  identifier: string,
  now: () => number,
): Promise<StartedLogin> {
  const res = await request(
    instanceUrl,
    joinUrl(instanceUrl, "/login"),
    jsonBody("POST", { identifier }),
  );

  if (isRateLimited(res)) {
    throw new LoginError(
      "The instance is rate limiting requests. Wait a few minutes and try again.",
    );
  }

  // `/login` never answers 401. An identifier with no usable account (unknown,
  // unverified, or with no permitted method) gets a 200 and a decoy pre-auth token, so
  // no answer here can be used to test whether an account exists. Nothing to read means
  // nothing to report: such a login fails at the code step, which `completeLogin` names.
  // Do not add a branch that reads a status as "no such user"; there is not one.
  if (!res.ok) {
    if (res.status === 400) {
      throw new LoginError(
        `"${identifier}" is not a valid email or phone number.`,
      );
    }
    if (res.status === 423) {
      // The one answer that does imply an account, and the one worth naming: it needs
      // prior failed attempts against this identifier, and waiting resolves it.
      throw new LoginError(lockedMessage(res.data, identifier));
    }
    if (res.status === 403) {
      throw new LoginError(`Login is not permitted for ${identifier}.`);
    }
    throw new LoginError(`Login request failed (${res.status}).`);
  }

  const parsed = LoginStartSchema.safeParse(res.data);
  if (!parsed.success) {
    throw new LoginError("The instance returned a login response this CLI cannot read.");
  }
  const { token, loginMethods = [], identifierType = "email", sub } = parsed.data;
  if (!token) {
    throw new LoginError("The instance did not return a login token.");
  }

  return {
    ephemeralToken: token,
    loginMethods,
    channel: identifierType,
    sub,
    deadline: now() + EPHEMERAL_WINDOW_MS,
  };
}

async function sendCode(
  instanceUrl: string,
  started: StartedLogin,
  localDelivery: boolean,
): Promise<string | undefined> {
  const path =
    started.channel === "email"
      ? "/otp/generate-login-email-otp"
      : "/otp/generate-login-phone-otp";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${started.ephemeralToken}`,
  };
  if (localDelivery) headers[EXTERNAL_DELIVERY_HEADER] = "external";

  const res = await request(instanceUrl, joinUrl(instanceUrl, path), {
    method: "GET",
    headers,
  });

  if (isRateLimited(res)) {
    throw new LoginError(
      "Too many code requests. The instance limits OTP to 10 per 15 minutes per IP. Wait and try again.",
    );
  }

  if (!res.ok) {
    if (res.status === 403) {
      const label = started.channel === "email" ? "Email" : "Phone";
      throw new LoginError(`${label} OTP login is disabled on this instance.`);
    }
    const message = apiMessage(res.data);
    throw new LoginError(
      message ? `Could not send a code: ${message}` : "Could not send a login code.",
    );
  }

  const refreshed = CodeSentSchema.safeParse(res.data).data?.token;
  if (refreshed) started.ephemeralToken = refreshed;

  return localDelivery ? deliveryCode(res.data) : undefined;
}

async function verifyCode(
  instanceUrl: string,
  started: StartedLogin,
  code: string,
) {
  const path =
    started.channel === "email"
      ? "/otp/verify-login-email-otp"
      : "/otp/verify-login-phone-otp";

  return request(
    instanceUrl,
    joinUrl(instanceUrl, path),
    jsonBody(
      "POST",
      { verificationToken: code },
      { Authorization: `Bearer ${started.ephemeralToken}` },
    ),
  );
}

function verifyFailure(
  res: { status: number; data: Record<string, unknown> | null },
  identifier: string,
): string {
  const message = apiMessage(res.data);
  if (res.status === 423) return lockedMessage(res.data, identifier);
  if (res.status === 403) {
    return "That login method was turned off on the instance mid-login.";
  }
  if (res.status >= 500) {
    return `The instance failed while verifying the code (${res.status}). This is not your code; try again shortly.${
      message ? ` It said: ${message}` : ""
    }`;
  }
  return `Could not verify the code (${res.status}).${message ? ` The instance said: ${message}` : ""}`;
}

export async function completeLogin(
  opts: CompleteLoginOptions,
): Promise<LoginResult | null> {
  const now = opts.now ?? (() => Date.now());
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const notify = opts.notify ?? (() => {});
  const localDelivery = opts.localDelivery ?? false;

  const requireLocalCode = (code: string | undefined): void => {
    if (localDelivery && !code) {
      throw new LoginError(
        "Local delivery is on, but the instance did not return the code. Start the auth API outside production with ALLOW_UNCREDENTIALED_DELIVERY_SECRETS=true so it returns OTP codes in the response.",
      );
    }
  };

  let started = await startLogin(opts.instanceUrl, opts.identifier, now);
  const channel = started.channel;
  const required: LoginMethod = channel === "email" ? "email_otp" : "phone_otp";
  if (started.loginMethods.length > 0 && !started.loginMethods.includes(required)) {
    // Deliberately not "this account cannot": the method list comes back for an unknown
    // identifier too, so saying so would report an account that may not exist.
    throw new LoginError(
      `${required.replace("_", " ")} login is not available for ${opts.identifier}. Offered: ${started.loginMethods.join(", ")}.`,
    );
  }

  let autoCode = await sendCode(opts.instanceUrl, started, localDelivery);
  notify({ type: "code_sent", channel });
  requireLocalCode(autoCode);

  let attempt = 0;
  let resent = false;
  while (attempt < maxAttempts) {
    let code: string | null;
    if (localDelivery && autoCode) {
      code = autoCode;
      autoCode = undefined;
      notify({ type: "code_autofilled", channel });
    } else {
      code = await opts.getCode({ attempt: attempt + 1, resent, channel });
    }
    resent = false;
    if (code === null) return null;

    if (now() >= started.deadline) {
      // The code just typed is dropped rather than sent: the pre-auth token it would
      // travel under has lapsed, so the instance would answer 401 and spend an attempt
      // on a code that may well have been right. Say so, because from the outside this
      // looks like the code being ignored.
      notify({ type: "code_expired", channel });
      started = await startLogin(opts.instanceUrl, opts.identifier, now);
      autoCode = await sendCode(opts.instanceUrl, started, localDelivery);
      resent = true;
      notify({ type: "code_resent", channel });
      requireLocalCode(autoCode);
      continue;
    }

    notify({ type: "verifying" });
    const res = await verifyCode(opts.instanceUrl, started, code);

    if (res.status === 200 && res.data) {
      const verified = VerifiedSchema.safeParse(res.data);
      const tokens = verified.success ? tokensFromAuthResponse(res.data) : null;
      if (!verified.success || !tokens) {
        throw new LoginError(
          "The instance returned an unexpected verification response.",
        );
      }
      return {
        tokens,
        identity: {
          sub: verified.data.sub ?? started.sub,
          email: verified.data.email,
          identifierType: channel,
        },
        channel,
      };
    }

    if (isRateLimited(res)) {
      throw new LoginError(
        "Too many attempts. The instance limits OTP to 10 per 15 minutes per IP. Wait and try again.",
      );
    }

    // Only a 401 is worth another try. The instance answers 401 both for a wrong code
    // and for a lapsed pre-auth token, so it stays an attempt; every other answer means
    // retyping the code cannot help, and spending the remaining attempts on it would
    // bury the real reason under "Could not verify a code".
    if (res.status !== 401) {
      throw new LoginError(verifyFailure(res, opts.identifier));
    }

    attempt++;
    notify({ type: "incorrect", attemptsLeft: maxAttempts - attempt });
  }

  // The instance does not say whether the identifier has an account, so neither can this.
  // A wrong code and an identifier nobody has registered both land here.
  throw new LoginError(
    `Could not verify a code for ${opts.identifier}. If that address or number has no account yet, register it first. Otherwise run seamless login to try again.`,
  );
}
