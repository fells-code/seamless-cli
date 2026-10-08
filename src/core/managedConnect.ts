import { confirm } from "@clack/prompts";
import kleur from "kleur";

import type { AuthClient } from "./authClient.js";
import { CancelledError, orCancel } from "./cancel.js";
import { fetchActiveJwksKid } from "./jwksKid.js";
import { resolveAppInstanceUrl, rotateServiceToken, type PortalApp } from "./portal.js";
import { requireInteractive } from "./tty.js";

// Shared by `seamless init` and `seamless add`, which both connect a project to a
// managed application.

// Only reached when the instance cannot be asked. Adapters resolve the signing key
// from the token header through the remote JWKS, so this value verifies nothing, but
// they warn on boot while it is the dev default, so the real kid is worth fetching.
export const FALLBACK_JWKS_KID = "dev-main";

// Asked of the instance rather than assumed: instances pin their kid per tier
// (trialkey1, paidkey1), so writing the dev default made every managed scaffold boot
// an app warning that it was misconfigured.
export async function resolveJwksKid(authServerUrl: string): Promise<string> {
  const kid = await fetchActiveJwksKid(authServerUrl);
  if (kid) return kid;

  console.log(
    kleur.yellow(
      `Could not read the signing key id from ${authServerUrl}, so JWKS_KID is set to "${FALLBACK_JWKS_KID}".`,
    ),
  );
  console.log(
    kleur.dim(
      "  Nothing verifies against it, the SDK resolves the key from the token, but your adapter will warn on boot until it matches. Read it from /.well-known/jwks.json once the instance is up.",
    ),
  );
  return FALLBACK_JWKS_KID;
}

// Issues the app's service token, confirming first when one already exists so a
// scaffold does not silently break an app that is already deployed. Declining
// cancels the whole command, so nothing is left half-wired.
export async function issueServiceToken(
  client: AuthClient,
  app: PortalApp,
  opts: { yes?: boolean; force?: boolean },
): Promise<string> {
  if (app.hasServiceToken) {
    // Rotation breaks whatever is running on the old token, so it confirms like
    // the overwrite step does.
    if (opts.yes) {
      if (!opts.force) {
        throw new Error(
          `"${app.name}" already has a service token, and issuing a new one invalidates it (breaking anything already deployed with it). Re-run with --force to rotate it anyway.`,
        );
      }
      console.log(
        kleur.yellow(
          `Rotating the existing service token for "${app.name}" (--force).`,
        ),
      );
    } else {
      requireInteractive(
        `"${app.name}" already has a service token. Issue a new one?`,
        "Pass --force to rotate it, which invalidates the existing token.",
      );
      const proceed = orCancel(
        await confirm({
          message: `"${app.name}" already has a service token. Issuing a new one invalidates the existing token. Continue?`,
          initialValue: false,
        }),
      );
      if (!proceed) {
        throw new CancelledError("Cancelled. No token was issued.");
      }
    }
  }
  return rotateServiceToken(client, app.id);
}

// connectable() filters out applications with no auth server, so this throwing means
// the filtered list and the selection disagreed, not that one is simply not ready yet.
export function requireInstanceUrl(app: PortalApp): string {
  const url = resolveAppInstanceUrl(app);
  if (!url) {
    throw new Error(
      `Application "${app.name}" has no auth instance URL yet. Run seamless apps list to check whether it has finished provisioning.`,
    );
  }
  return url;
}

// listApplications reports applications that have not finished provisioning too,
// because `seamless apps list` has to show them. Managed connect needs an auth
// server to point at, so it keeps considering only the ones that have one.
//
// Asked through resolveAppInstanceUrl rather than of `domain` directly: an
// application served at an instanceUrl its stale domain column never carried would
// otherwise be filtered out here and never offered.
export function connectable(apps: PortalApp[]): PortalApp[] {
  return apps.filter((app) => resolveAppInstanceUrl(app) !== undefined);
}
