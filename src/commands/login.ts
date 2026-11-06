import { intro, outro, cancel } from "@clack/prompts";
import kleur from "kleur";

import { extractFlag } from "../core/args.js";
import {
  getPortalAuthUrl,
  getPortalSession,
  isLocalInstanceUrl,
  PORTAL_PROFILE_NAME,
  savePortalSession,
} from "../core/config.js";
import {
  assertKeychainUsable,
  KEYCHAIN_REQUIRED_MESSAGE,
  KeychainUnavailableError,
  saveTokens,
} from "../core/keychain.js";
import { promptLogin } from "../core/interactiveLogin.js";
import { LoginError } from "../core/loginFlow.js";
import { loginToInstance } from "./instanceLogin.js";

export async function runLogin(args: string[]): Promise<void> {
  const local = args.includes("--local");
  const profileFlag = extractFlag(
    args.filter((a) => a !== "--local"),
    "profile",
  );
  const idFlag = extractFlag(profileFlag.rest, "identifier");
  const identifier = (idFlag.value ?? idFlag.rest[0])?.trim();

  // `login --profile <name>` used to be the only way to reach an auth instance.
  // TODO(#125): drop this shim one minor version after release.
  if (profileFlag.value) {
    console.log(
      kleur.yellow(
        `"seamless login --profile ${profileFlag.value}" is deprecated. Use: seamless profile login ${profileFlag.value}`,
      ),
    );
    await loginToInstance({
      profileName: profileFlag.value,
      identifier,
      local,
    });
    return;
  }

  await loginToPortal({ identifier, local });
}

// Signs in to the Seamless portal, the managed control plane's own account. The
// session it stores is what authorizes api.seamlessauth.com, and it is deliberately
// kept out of the profile map: profiles are auth instances, of which there are
// many, while there is exactly one portal.
async function loginToPortal(opts: {
  identifier?: string;
  local?: boolean;
}): Promise<void> {
  const instanceUrl = getPortalAuthUrl();

  if (opts.local && !isLocalInstanceUrl(instanceUrl)) {
    console.error(
      kleur.red(
        `--local only works against a local portal, not ${instanceUrl}. Set SEAMLESS_PORTAL_AUTH_URL to a local instance to develop against one.`,
      ),
    );
    process.exit(1);
  }

  const existing = getPortalSession();

  intro(`Sign in to the ${kleur.bold("Seamless portal")} (${instanceUrl})`);

  try {
    await assertKeychainUsable();
  } catch (err) {
    if (!(err instanceof KeychainUnavailableError)) throw err;
    outro(kleur.red(err.message));
    process.exit(1);
  }

  if (opts.local) {
    console.log(
      kleur.dim("Local delivery on: reading the OTP from the instance response."),
    );
  }

  try {
    const result = await promptLogin({
      instanceUrl,
      identifier: opts.identifier,
      knownEmail: existing?.email,
      localDelivery: opts.local,
    });

    if (!result) {
      cancel("Cancelled.");
      return;
    }

    await saveTokens(
      { name: PORTAL_PROFILE_NAME, instanceUrl },
      result.tokens,
    );
    savePortalSession({
      instanceUrl,
      sub: result.identity.sub,
      email: result.identity.email,
      identifierType: result.identity.identifierType,
    });

    outro(
      kleur.green(
        `Signed in to the Seamless portal as ${result.identity.email ?? result.identifier}.`,
      ),
    );
  } catch (err) {
    if (err instanceof KeychainUnavailableError) {
      outro(kleur.red(KEYCHAIN_REQUIRED_MESSAGE));
      process.exit(1);
    }
    if (err instanceof LoginError) {
      outro(kleur.red(err.message));
      process.exit(1);
    }
    throw err;
  }
}
