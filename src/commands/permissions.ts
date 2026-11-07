import {
  CreatePermissionRequestSchema,
  PermissionNameSchema,
  UpdatePermissionRequestSchema,
} from "@seamless-auth/types";
import kleur from "kleur";
import { extractFlag } from "../core/args.js";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  createPermission,
  deletePermission,
  listPermissions,
  updatePermission,
  type AdminPermission,
} from "../core/admin.js";
import { confirmDestructive, hasForceFlag } from "../core/confirmAction.js";
import { fail, positionals, reportAdminError, validate } from "./adminShared.js";

const USAGE = "Usage: seamless permissions <list|create|update|delete>";

export async function runPermissions(args: string[]): Promise<void> {
  const sub = args[0];
  const { value: profileFlag, rest } = extractFlag(args.slice(1), "profile");

  try {
    const client = await createAuthClient({ profileFlag });
    switch (sub) {
      case "list":
        await permissionsList(client, rest);
        return;
      case "create":
        await permissionsCreate(client, rest);
        return;
      case "update":
        await permissionsUpdate(client, rest);
        return;
      case "delete":
        await permissionsDelete(client, rest);
        return;
      default:
        console.error(kleur.red(`Unknown permissions subcommand: ${sub ?? "(none)"}`));
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    reportAdminError(err);
  }
}

function printPermission(permission: AdminPermission): void {
  console.log(
    kleur.bold(permission.name) +
      (permission.description ? kleur.dim(`  ${permission.description}`) : ""),
  );
}

/**
 * Fails on a name the API would refuse, saying what a name may hold. The schema's
 * own message is the raw pattern, which reads as noise.
 */
export function checkName(name: string, what: string): string {
  const result = PermissionNameSchema.safeParse(name);
  if (result.success) return result.data;
  fail(
    `${name} is not a valid ${what} name. Use letters, digits and hyphens, in segments separated by colons (such as invoices:read), up to 80 characters.`,
  );
}

function permissionName(rest: string[], usage: string): string {
  const name = positionals(rest)[0];
  if (!name) fail(usage);
  return checkName(name, "permission");
}

async function permissionsList(client: AuthClient, rest: string[]): Promise<void> {
  const { permissions, total } = await listPermissions(client);

  if (rest.includes("--json")) {
    console.log(JSON.stringify(permissions, null, 2));
    return;
  }
  if (permissions.length === 0) {
    console.log(kleur.dim("No permissions."));
    return;
  }
  for (const permission of permissions) printPermission(permission);
  console.log(kleur.dim(`${total} permission${total === 1 ? "" : "s"}.`));
}

async function permissionsCreate(client: AuthClient, args: string[]): Promise<void> {
  const description = extractFlag(args, "description");
  const name = positionals(description.rest)[0];
  if (!name) {
    fail("Usage: seamless permissions create <name> [--description <text>] [--json]");
  }

  const body = validate(CreatePermissionRequestSchema, {
    name: checkName(name, "permission"),
    ...(description.value !== undefined ? { description: description.value } : {}),
  });
  const permission = await createPermission(client, body);
  if (description.rest.includes("--json")) {
    console.log(JSON.stringify(permission, null, 2));
    return;
  }
  console.log(kleur.green(`Created permission ${permission.name}.`));
  printPermission(permission);
}

async function permissionsUpdate(client: AuthClient, args: string[]): Promise<void> {
  const usage =
    "Usage: seamless permissions update <name> (--description <text> | --no-description) [--json]";
  const description = extractFlag(args, "description");
  const clear = description.rest.includes("--no-description");
  const name = permissionName(description.rest, usage);

  if (description.value === undefined && !clear) {
    fail("Nothing to update. Pass --description <text>, or --no-description to clear it.");
  }
  if (description.value !== undefined && clear) {
    fail("Pass --description or --no-description, not both.");
  }

  const body = validate(UpdatePermissionRequestSchema, {
    description: clear ? null : description.value,
  });
  const permission = await updatePermission(client, name, body);
  if (description.rest.includes("--json")) {
    console.log(JSON.stringify(permission, null, 2));
    return;
  }
  console.log(kleur.green(`Updated permission ${permission.name}.`));
  printPermission(permission);
}

async function permissionsDelete(client: AuthClient, rest: string[]): Promise<void> {
  const name = permissionName(rest, "Usage: seamless permissions delete <name> [--force]");

  const confirmed = await confirmDestructive({
    message: `Delete permission ${name}? This cannot be undone.`,
    force: hasForceFlag(rest),
  });
  if (!confirmed) {
    console.log(kleur.dim("Cancelled."));
    return;
  }

  await deletePermission(client, name);
  console.log(kleur.green(`Deleted permission ${name}.`));
}
