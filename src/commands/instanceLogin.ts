import { intro, outro, cancel } from "@clack/prompts";
import kleur from "kleur";

import {
  getActiveProfile,
  isLocalInstanceUrl,
  upsertProfile,
  type Profile,
} from "../core/config.js";
import { KeychainUnavailableError, saveTokens } from "../core/keychain.js";
import { promptLogin } from "../core/interactiveLogin.js";
import { LoginError } from "../core/loginFlow.js";
import {
  discoverProvider,
  endSession,
  exchangeForSession,
  normalizeIssuer,
  ProviderSignInError,
  signInWithDevice,
  signInWithLoopback,
} from "../core/providerSignIn.js";

export interface InstanceLoginOptions {
  profileName?: string;
  identifier?: string;
  local?: boolean;
  device?: boolean;
  emailCode?: boolean;
  oidcIssuer?: string;
  clientId?: string;
}

function refuse(message: string): never {
  console.error(kleur.red(message));
  process.exit(1);
}

// A browser or device sign-in at the provider, then the exchange. Keeps nothing from the
// provider: the access token is spent on the exchange, and only the instance's own
// first-party tokens are stored.
async function loginThroughProvider(
  profile: Profile,
  issuer: string,
  clientId: string,
  device: boolean,
): Promise<void> {
  let metadata;
  try {
    metadata = await discoverProvider(issuer);
  } catch (err) {
    // A provider someone configured and cannot be read is not the same as no provider.
    // Falling back here would let whoever blocks discovery choose the weaker sign-in.
    if (err instanceof ProviderSignInError) {
      outro(kleur.red(`${err.message} To sign in with an email code instead, pass --email-code.`));
      process.exit(1);
    }
    throw err;
  }

  const say = (line: string): void => console.log(line);
  const subject = device
    ? await signInWithDevice({ metadata, clientId, say })
    : await signInWithLoopback({ metadata, clientId, say });

  const exchanged = await exchangeForSession(profile.instanceUrl, subject.accessToken);

  if (exchanged.sub !== subject.sub) {
    await endSession(profile.instanceUrl, exchanged.tokens.accessToken);
    throw new ProviderSignInError(
      "The instance issued a session for a different account than the provider signed in, so it was refused. Check that the profile's instance and issuer belong together.",
    );
  }

  try {
    await saveTokens(profile, {
      ...exchanged.tokens,
      signIn: device ? "device" : "loopback",
    });
  } catch (err) {
    await endSession(profile.instanceUrl, exchanged.tokens.accessToken);
    throw err;
  }

  upsertProfile({
    ...profile,
    oidcIssuer: issuer,
    oidcClientId: clientId,
    sub: exchanged.sub ?? profile.sub,
    email: exchanged.email ?? profile.email,
  });

  outro(
    kleur.green(
      `Logged in to ${profile.name} as ${exchanged.email ?? exchanged.sub ?? "your account"}.`,
    ),
  );
}

// Signs in to an auth instance a developer administers, which is what authorizes
// the /admin routes behind `users`, `config`, `org`, and `sessions`. Distinct
// from the portal session: that account lives on the control plane, this one
// lives in the instance's own user pool.
export async function loginToInstance(
  opts: InstanceLoginOptions = {},
): Promise<void> {
  const profile = getActiveProfile({ profileFlag: opts.profileName });
  if (!profile) {
    console.error(kleur.red("No active profile is configured."));
    console.log(
      "Add one with: " +
        kleur.cyan("seamless profile add <name> --instance-url <url>"),
    );
    process.exit(1);
  }

  if (opts.local && !isLocalInstanceUrl(profile.instanceUrl)) {
    console.error(
      kleur.red(
        `--local only works against a local instance, not ${profile.instanceUrl}.`,
      ),
    );
    process.exit(1);
  }

  if (opts.device && (opts.emailCode || opts.local)) {
    refuse(`--device cannot be combined with ${opts.local ? "--local" : "--email-code"}.`);
  }

  const emailOnly = opts.emailCode || opts.local;
  let issuer: string | undefined;
  const clientId = opts.clientId ?? profile.oidcClientId;
  if (!emailOnly) {
    const configuredIssuer = opts.oidcIssuer ?? profile.oidcIssuer;
    if (configuredIssuer && !clientId) {
      refuse(
        "This profile has an OpenID Provider issuer but no client id. Pass --client-id <id>, or --email-code to sign in with an email code.",
      );
    }
    if (clientId && !configuredIssuer) {
      refuse(
        "This profile has a client id but no OpenID Provider issuer. Pass --oidc-issuer <url>, or --email-code to sign in with an email code.",
      );
    }
    try {
      issuer = configuredIssuer ? normalizeIssuer(configuredIssuer) : undefined;
    } catch (err) {
      refuse((err as Error).message);
    }
  }

  intro(`Log in to ${kleur.bold(profile.name)} (${profile.instanceUrl})`);

  if (issuer && clientId) {
    if (opts.identifier) {
      console.log(
        kleur.dim("The identifier applies to email codes, so it is not used here. You choose the account in the browser."),
      );
    }
    try {
      await loginThroughProvider(profile, issuer, clientId, opts.device ?? false);
    } catch (err) {
      if (err instanceof ProviderSignInError || err instanceof KeychainUnavailableError) {
        outro(kleur.red(err.message));
        process.exit(1);
      }
      throw err;
    }
    return;
  }

  if (opts.device) {
    console.log(
      kleur.yellow(
        "This profile has no OpenID Provider, so --device is not available. Using an email code instead.",
      ),
    );
  }
  if (opts.local) {
    console.log(
      kleur.dim("Local delivery on: reading the OTP from the instance response."),
    );
  }

  try {
    const result = await promptLogin({
      instanceUrl: profile.instanceUrl,
      identifier: opts.identifier,
      knownEmail: profile.email,
      localDelivery: opts.local,
    });

    if (!result) {
      cancel("Cancelled.");
      return;
    }

    await saveTokens(profile, result.tokens);
    upsertProfile({
      ...profile,
      sub: result.identity.sub ?? profile.sub,
      email: result.identity.email ?? profile.email,
      identifierType: result.identity.identifierType,
    });

    outro(
      kleur.green(
        `Logged in to ${profile.name} as ${result.identity.email ?? result.identifier}.`,
      ),
    );
  } catch (err) {
    if (err instanceof LoginError || err instanceof KeychainUnavailableError) {
      outro(kleur.red(err.message));
      process.exit(1);
    }
    throw err;
  }
}
