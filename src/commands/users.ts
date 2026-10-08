import kleur from "kleur";
import { extractFlag } from "../core/args.js";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  deleteUser,
  getUserDetail,
  listUsers,
  prepareDeviceReplacement,
  type AdminCredential,
  type AdminUser,
} from "../core/admin.js";
import {
  pagePosition,
  parseWindow,
  reportAdminError,
} from "./adminShared.js";
import {
  confirmDestructive,
  hasForceFlag,
} from "../core/confirmAction.js";

export async function runUsers(args: string[]): Promise<void> {
  const sub = args[0];
  const { value: profileFlag, rest } = extractFlag(args.slice(1), "profile");

  try {
    const client = await createAuthClient({ profileFlag });
    switch (sub) {
      case "list":
        await usersList(client, rest);
        return;
      case "delete":
        await usersDelete(client, rest);
        return;
      case "credentials":
        await usersCredentials(client, rest);
        return;
      case "prepare-device-replacement":
        await usersPrepareDeviceReplacement(client, rest);
        return;
      default:
        console.error(kleur.red(`Unknown users subcommand: ${sub ?? "(none)"}`));
        console.log(
          "Usage: seamless users <list|delete|credentials|prepare-device-replacement>",
        );
        process.exit(1);
    }
  } catch (err) {
    reportAdminError(err);
  }
}

async function usersList(client: AuthClient, rest: string[]): Promise<void> {
  const json = rest.includes("--json");
  const { limit, offset } = parseWindow(rest);

  const { users, total } = await listUsers(client, { limit, offset });

  if (json) {
    console.log(JSON.stringify(users, null, 2));
    return;
  }

  if (users.length === 0) {
    console.log(kleur.dim("No users."));
    return;
  }

  for (const user of users) {
    printUserRow(user);
  }
  console.log(kleur.dim(pagePosition(offset, users.length, total, "user")));
}

async function usersDelete(client: AuthClient, rest: string[]): Promise<void> {
  const id = rest.find((arg) => !arg.startsWith("--"));
  if (!id) {
    console.error(kleur.red("Usage: seamless users delete <id>"));
    process.exit(1);
  }

  const proceed = await confirmDestructive({
    message: `Permanently delete user ${id}? This cannot be undone.`,
    force: hasForceFlag(rest),
    remedy: "Pass --force to delete without confirming.",
  });
  if (!proceed) {
    console.log("Cancelled.");
    return;
  }

  await deleteUser(client, id);
  console.log(kleur.green(`Deleted user ${id}.`));
}

async function usersCredentials(
  client: AuthClient,
  rest: string[],
): Promise<void> {
  const json = rest.includes("--json");
  const id = rest.find((arg) => !arg.startsWith("--"));
  if (!id) {
    console.error(kleur.red("Usage: seamless users credentials <id>"));
    process.exit(1);
  }

  const { credentials } = await getUserDetail(client, id);

  if (json) {
    console.log(JSON.stringify(credentials, null, 2));
    return;
  }

  console.log(
    `${kleur.bold(String(credentials.length))} credential${
      credentials.length === 1 ? "" : "s"
    } for user ${id}`,
  );
  for (const credential of credentials) {
    console.log(
      "  " +
        kleur.bold(credentialName(credential)) +
        kleur.dim(`  ${credential.id}`) +
        kleur.dim(`  added ${credential.createdAt}`),
    );
  }
}

async function usersPrepareDeviceReplacement(
  client: AuthClient,
  rest: string[],
): Promise<void> {
  const id = rest.find((arg) => !arg.startsWith("--"));
  if (!id) {
    console.error(
      kleur.red("Usage: seamless users prepare-device-replacement <id>"),
    );
    process.exit(1);
  }

  const opts = {
    revokeSessions: !rest.includes("--keep-sessions"),
    removePasskeys: !rest.includes("--keep-passkeys"),
    disableTotp: !rest.includes("--keep-totp"),
  };

  const actions = [
    opts.revokeSessions ? "revoke all sessions" : null,
    opts.removePasskeys ? "remove passkeys" : null,
    opts.disableTotp ? "disable TOTP" : null,
  ].filter(Boolean);

  const proceed = await confirmDestructive({
    message: `Prepare device replacement for ${id}? This will ${actions.join(", ")}.`,
    force: hasForceFlag(rest),
    remedy: "Pass --force to prepare the replacement without confirming.",
  });
  if (!proceed) {
    console.log("Cancelled.");
    return;
  }

  const result = await prepareDeviceReplacement(client, id, opts);
  console.log(kleur.green(`Prepared device replacement for ${id}.`));
  console.log(
    kleur.dim(
      `Revoked sessions: ${result.revokedSessions}, ` +
        `removed credentials: ${result.removedCredentials}, ` +
        `disabled TOTP: ${result.disabledTotpCredentials}`,
    ),
  );
}

function printUserRow(user: AdminUser): void {
  const revoked = user.revoked ? kleur.red("  revoked") : "";
  console.log(
    kleur.bold(user.email) +
      kleur.dim(`  ${user.id}`) +
      (user.roles.length ? kleur.dim(`  [${user.roles.join(", ")}]`) : "") +
      revoked,
  );
}

// The name the user gave the passkey, then what the API recorded about the device.
// `||` rather than `??`, since a blank name is no more use than a missing one.
function credentialName(credential: AdminCredential): string {
  const device = [credential.platform, credential.browser].filter(Boolean).join(" ");
  return credential.friendlyName || credential.deviceInfo || device || "passkey";
}
