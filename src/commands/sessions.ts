import type { Session } from "@seamless-auth/types";
import kleur from "kleur";
import { extractFlag } from "../core/args.js";
import { createAuthClient, ReauthRequiredError, type AuthClient } from "../core/authClient.js";
import { clearLocalSession } from "../core/session.js";
import { errorMessage } from "../core/errors.js";
import {
  listSessions,
  revokeAllSessions,
  revokeSessionById,
} from "../core/sessions.js";
import {
  confirmDestructive,
  hasForceFlag,
} from "../core/confirmAction.js";

export async function runSessions(args: string[]): Promise<void> {
  const sub = args[0] === "list" || args[0] === "revoke" ? args[0] : undefined;
  const rest = sub ? args.slice(1) : args;
  const { value: profileFlag, rest: positional } = extractFlag(rest, "profile");

  try {
    const client = await createAuthClient({ profileFlag });
    if (sub === "revoke") {
      await revoke(client, positional);
    } else {
      await list(client, positional);
    }
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      console.log(kleur.yellow(err.message));
      process.exit(1);
    }
    console.error(kleur.red(errorMessage(err)));
    process.exit(1);
  }
}

async function list(client: AuthClient, positional: string[]): Promise<void> {
  const sessions = await listSessions(client);

  if (positional.includes("--json")) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log(kleur.dim("No active sessions."));
    return;
  }

  for (const session of sessions) {
    printSession(session);
  }
}

async function revoke(client: AuthClient, positional: string[]): Promise<void> {
  const all = positional.includes("--all");
  const id = positional.find((arg) => !arg.startsWith("--"));

  if (all) {
    const proceed = await confirmDestructive({
      message:
        "Revoke every session, including this one? You will be signed out here.",
      force: hasForceFlag(positional),
      remedy: "Pass --force to revoke every session without confirming.",
    });
    if (!proceed) {
      console.log("Cancelled.");
      return;
    }

    const res = await revokeAllSessions(client);
    if (!res.ok) {
      console.error(kleur.red(`Could not revoke sessions (${res.status}).`));
      process.exit(1);
    }
    await clearLocalSession(client.profile);
    console.log(kleur.green("Revoked all sessions."));
    console.log(
      kleur.dim("Local tokens cleared. Run seamless login to sign in again."),
    );
    return;
  }

  if (!id) {
    console.error(
      kleur.red("Usage: seamless sessions revoke <id> | seamless sessions revoke --all"),
    );
    process.exit(1);
  }

  const sessions = await listSessions(client);
  const isCurrent = sessions.find((session) => session.id === id)?.current ?? false;

  if (isCurrent) {
    const proceed = await confirmDestructive({
      message:
        "This is your current session. Revoking it signs you out here. Continue?",
      force: hasForceFlag(positional),
      remedy: "Pass --force to revoke it without confirming.",
    });
    if (!proceed) {
      console.log("Cancelled.");
      return;
    }
  }

  const res = await revokeSessionById(client, id);
  if (res.status === 404) {
    console.log(
      kleur.yellow(`No active session ${id}. It may already be revoked.`),
    );
    return;
  }
  if (!res.ok) {
    console.error(kleur.red(`Could not revoke session ${id} (${res.status}).`));
    process.exit(1);
  }

  console.log(kleur.green(`Revoked session ${id}.`));
  if (isCurrent) {
    await clearLocalSession(client.profile);
    console.log(
      kleur.dim(
        "That was your current session; local tokens cleared. Run seamless login to sign in again.",
      ),
    );
  }
}

function printSession(session: Session): void {
  const marker = session.current ? kleur.green("* ") : "  ";
  // `||` rather than `??`: a blank device name or ip is as unhelpful as a missing one.
  const device =
    session.deviceName || shortUserAgent(session.userAgent) || "unknown device";
  const ip = session.ipAddress || "unknown ip";
  const when = formatWhen(session.lastUsedAt);

  console.log(marker + kleur.bold(session.id));
  console.log(`    ${device}  ${kleur.dim(ip)}`);
  console.log(
    kleur.dim(`    last used ${when}${session.current ? "  (current)" : ""}`),
  );
}

function shortUserAgent(userAgent?: string | null): string | undefined {
  if (!userAgent) return undefined;
  return userAgent.length > 48 ? `${userAgent.slice(0, 45)}...` : userAgent;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
