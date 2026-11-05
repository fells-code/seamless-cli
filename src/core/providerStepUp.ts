import { isCancel, select } from "@clack/prompts";
import { TotpStatusSchema } from "@seamless-auth/types";
import kleur from "kleur";
import type { AuthClient } from "./authClient.js";
import { CancelledError } from "./cancel.js";
import {
  discoverProvider,
  endSession,
  exchangeForSession,
  ProviderSignInError,
  signInWithLoopback,
} from "./providerSignIn.js";
import {
  authenticatorAppStepUp,
  StepUpError,
  TOTP_CODE_ENV,
  type StepUpHandler,
  type StepUpSession,
} from "./stepUp.js";
import { isInteractive } from "./tty.js";

const PASSKEY_ACR = "phr";
// Not the 300 the five minute window suggests. requireStepUp reads a step-up record, and the
// hosted page only writes one when the request's requirements are unmet, so a browser that
// signed in during the last 300 seconds would pass with no record and the retry would refuse.
const PASSKEY_MAX_AGE_SECONDS = 0;

export const DEVICE_STEP_UP_REQUIRED_MESSAGE = `This session was signed in with a device code, so this command needs a recent code from your authenticator app, even for a read. Run the command in an interactive terminal to enter one, or set ${TOTP_CODE_ENV} to a current code.`;

export const DEVICE_NO_AUTHENTICATOR_MESSAGE =
  "This session was signed in with a device code, so this command needs a code from your authenticator app, and your account has none enrolled. A device session cannot enroll one. Enroll one from a browser, in the admin dashboard or your app, then run seamless profile login --device again.";

const DEVICE_PROMPT =
  "This session was signed in with a device code, so this command needs a fresh code from your authenticator app, even for a read. A refresh also clears it, so you may be asked again.";

export const SIGN_IN_NOT_STEP_UP_MESSAGE =
  "You signed in, but your browser had no session, so the instance recorded a sign-in and not a step-up. Run the command again: your browser now has a session, and will ask you to confirm with your passkey.";

const LOOPBACK_STEP_UP_REQUIRED_MESSAGE = `This action needs a recent step-up. Run the command in an interactive terminal to sign in again with a passkey or enter an authenticator app code, or set ${TOTP_CODE_ENV} to a current code.`;

async function hasAuthenticator(client: AuthClient): Promise<boolean> {
  const res = await client.get<unknown>("/totp/status");
  // Only a definite "not enrolled" rules the app out, as in authenticatorAppStepUp.
  if (!res.ok) return true;
  const parsed = TotpStatusSchema.loose().safeParse(res.data);
  return !parsed.success || parsed.data.enabled;
}

function say(line: string): void {
  // stderr keeps stdout clean for commands printing --json.
  process.stderr.write(`${line}\n`);
}

async function passkeyStepUp(
  client: AuthClient,
  session: StepUpSession,
  issuer: string,
  clientId: string,
): Promise<void> {
  try {
    const metadata = await discoverProvider(issuer);
    const subject = await signInWithLoopback({
      metadata,
      clientId,
      say,
      acrValues: PASSKEY_ACR,
      maxAge: PASSKEY_MAX_AGE_SECONDS,
    });
    const { instanceUrl, sub: currentSub } = client.profile;
    const exchanged = await exchangeForSession(instanceUrl, subject.accessToken);
    if (currentSub && exchanged.sub !== currentSub) {
      await endSession(instanceUrl, exchanged.tokens.accessToken);
      throw new StepUpError(
        "The browser signed in to another account, so this session was left as it was. Sign in to the same account to step up.",
      );
    }
    await session.replace({ ...exchanged.tokens, signIn: "loopback" });

    const status = await client.get<{ fresh?: boolean }>("/step-up/status");
    if (status.ok && status.data?.fresh === false) {
      throw new StepUpError(SIGN_IN_NOT_STEP_UP_MESSAGE);
    }
  } catch (err) {
    if (err instanceof ProviderSignInError) throw new StepUpError(err.message);
    throw err;
  }
}

/**
 * Steps up by how the session signed in. A device session uses the authenticator app and
 * nothing else: a terminal cannot run a passkey ceremony, and a device session cannot
 * enroll a factor. A browser session can also sign in again. Anything else, a session from
 * an email code or SEAMLESS_REFRESH_TOKEN, keeps the authenticator app.
 */
export function sessionStepUp(env: NodeJS.ProcessEnv = process.env): StepUpHandler {
  const app = authenticatorAppStepUp(env);
  const deviceApp = authenticatorAppStepUp(env, {
    requiredMessage: DEVICE_STEP_UP_REQUIRED_MESSAGE,
    noAuthenticatorMessage: DEVICE_NO_AUTHENTICATOR_MESSAGE,
    prompt: DEVICE_PROMPT,
  });
  const loopbackApp = authenticatorAppStepUp(env, {
    requiredMessage: LOOPBACK_STEP_UP_REQUIRED_MESSAGE,
  });
  let envCodeUsed = false;

  return async (client, session) => {
    const signIn = session?.signIn();
    if (signIn === "device") return deviceApp(client, session);

    const { oidcIssuer: issuer, oidcClientId: clientId } = client.profile;
    if (signIn !== "loopback" || !session || !issuer || !clientId) return app(client, session);

    if (env[TOTP_CODE_ENV]?.trim() && !envCodeUsed) {
      envCodeUsed = true;
      return loopbackApp(client, session);
    }
    if (!isInteractive()) throw new StepUpError(LOOPBACK_STEP_UP_REQUIRED_MESSAGE);

    if (!(await hasAuthenticator(client))) {
      say(kleur.yellow("This action needs a fresh step-up, so you will sign in again with a passkey."));
      return passkeyStepUp(client, session, issuer, clientId);
    }

    const choice = await select({
      message: "This action needs a fresh step-up. How do you want to do it?",
      options: [
        { value: "passkey", label: "Sign in again with a passkey, in your browser" },
        { value: "totp", label: "Enter a code from your authenticator app" },
      ],
      output: process.stderr,
    });
    if (isCancel(choice)) throw new CancelledError();
    if (choice === "totp") return loopbackApp(client, session);
    return passkeyStepUp(client, session, issuer, clientId);
  };
}
