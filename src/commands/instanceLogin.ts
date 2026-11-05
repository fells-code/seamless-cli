import { intro, outro, cancel, confirm } from "@clack/prompts";
import kleur from "kleur";

import { CancelledError, orCancel } from "../core/cancel.js";
import {
  getActiveProfile,
  isLocalInstanceUrl,
  isLoopbackInstanceUrl,
  upsertProfile,
  type Profile,
} from "../core/config.js";
import {
  assertKeychainUsable,
  KEYCHAIN_REQUIRED_MESSAGE,
  KeychainUnavailableError,
  saveTokens,
} from "../core/keychain.js";
import { promptLogin } from "../core/interactiveLogin.js";
import { LoginError } from "../core/loginFlow.js";
import {
  discoverProvider,
  endSession,
  exchangeForSession,
  normalizeIssuer,
  ProviderSignInError,
  readAdvertisedProvider,
  signInWithDevice,
  signInWithLoopback,
} from "../core/providerSignIn.js";
import { isInteractive } from "../core/tty.js";

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
  console.log(`Signing in through ${issuer}.`);

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

// A token from the provider is spent at the instance, and nothing ties the two together
// except this answer. An instance can advertise a real provider it has no part in, proxy the
// real instance, and replay the token there, while every page the user sees is genuine. So an
// advertised issuer on another origin is the user's to accept, once: the sign-in saves it.
async function confirmAdvertisedIssuer(instanceUrl: string, issuer: string): Promise<void> {
  if (new URL(issuer).origin === new URL(instanceUrl).origin) return;

  if (!isInteractive()) {
    refuse(
      `${instanceUrl} says to sign in through ${issuer}, another site, and this run has no terminal to ask you. If you trust it, pass --oidc-issuer and --client-id.`,
    );
  }
  const accepted = orCancel(
    await confirm({
      message: `${instanceUrl} says to sign in through ${issuer}, another site. Continue only if you expect this provider to serve this instance.`,
      initialValue: false,
    }),
  );
  if (accepted !== true) throw new CancelledError();
}

// Flags, then what the profile saved, then what the instance advertises. A saved issuer
// never needs the advertisement, so a later response without it cannot downgrade the
// profile. With no issuer anywhere the instance has no provider this CLI can use, which is
// the one case that reaches the email code: a missing field says no more than the instance
// itself could. Over plain http anyone on the network can write the advertisement, and a
// provider saved from it would outlast their time there, so it is read only over https or
// on this machine.
async function resolveProvider(
  profile: Profile,
  opts: InstanceLoginOptions,
): Promise<{ issuer?: string; clientId?: string }> {
  let issuer = opts.oidcIssuer ?? profile.oidcIssuer;
  let clientId = opts.clientId ?? profile.oidcClientId;
  const issuerConfigured = Boolean(issuer);
  const canReadAdvertisement =
    profile.instanceUrl.startsWith("https://") || isLoopbackInstanceUrl(profile.instanceUrl);

  try {
    if (issuer) issuer = normalizeIssuer(issuer);
    if ((!issuer || !clientId) && canReadAdvertisement) {
      const advertised = await readAdvertisedProvider(profile.instanceUrl);
      if (advertised) {
        const advertisedIssuer = normalizeIssuer(advertised.issuer);
        // A client id belongs to one provider, so it comes along only for that one.
        if (!issuer || issuer === advertisedIssuer) {
          issuer = advertisedIssuer;
          clientId ??= advertised.cliClientId;
        }
      }
    }
  } catch (err) {
    if (!(err instanceof ProviderSignInError)) throw err;
    refuse(`${err.message} To sign in with an email code instead, pass --email-code.`);
  }

  if (!issuer && !clientId && !canReadAdvertisement) {
    console.log(
      kleur.dim(
        "This instance uses plain http, so a provider it advertises is not read. To sign in through one, pass --oidc-issuer and --client-id.",
      ),
    );
  }
  if (issuer && !clientId) {
    refuse(
      "This profile has an OpenID Provider issuer but no client id. Pass --client-id <id>, or --email-code to sign in with an email code.",
    );
  }
  if (clientId && !issuer) {
    refuse(
      "This profile has a client id but no OpenID Provider issuer. Pass --oidc-issuer <url>, or --email-code to sign in with an email code.",
    );
  }
  if (issuer && clientId && !issuerConfigured) {
    await confirmAdvertisedIssuer(profile.instanceUrl, issuer);
  }
  return { issuer, clientId };
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

  intro(`Log in to ${kleur.bold(profile.name)} (${profile.instanceUrl})`);

  try {
    await assertKeychainUsable();
  } catch (err) {
    if (!(err instanceof KeychainUnavailableError)) throw err;
    outro(kleur.red(err.message));
    process.exit(1);
  }

  const provider =
    opts.emailCode || opts.local ? {} : await resolveProvider(profile, opts);
  const { issuer, clientId } = provider;

  if (issuer && clientId) {
    if (opts.identifier) {
      console.log(
        kleur.dim("The identifier applies to email codes, so it is not used here. You choose the account in the browser."),
      );
    }
    try {
      await loginThroughProvider(profile, issuer, clientId, opts.device ?? false);
    } catch (err) {
      if (err instanceof KeychainUnavailableError) {
        outro(kleur.red(KEYCHAIN_REQUIRED_MESSAGE));
        process.exit(1);
      }
      if (err instanceof ProviderSignInError) {
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
