import {
  CreateOrganizationRoleRequestSchema,
  RoleKindSchema,
  SetRolePermissionsRequestSchema,
  UpdateOrganizationRoleRequestSchema,
  type RoleKind,
} from "@seamless-auth/types";
import kleur from "kleur";
import { extractFlag } from "../core/args.js";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  createOrganizationRole,
  deleteOrganizationRole,
  listRoles,
  setRolePermissions,
  updateOrganizationRole,
  type AdminRole,
} from "../core/admin.js";
import { confirmDestructive, hasForceFlag } from "../core/confirmAction.js";
import {
  fail,
  parseList,
  positionals,
  reportAdminError,
  validate,
} from "./adminShared.js";
import { checkName } from "./permissions.js";

const USAGE = "Usage: seamless roles <list|set|create|update|delete>";

const KIND_LABEL: Record<RoleKind, string> = {
  instance: "Instance roles",
  organization: "Organization roles",
};

export async function runRoles(args: string[]): Promise<void> {
  const sub = args[0];
  const { value: profileFlag, rest } = extractFlag(args.slice(1), "profile");

  try {
    const client = await createAuthClient({ profileFlag });
    switch (sub) {
      case "list":
        await rolesList(client, rest);
        return;
      case "set":
        await rolesSet(client, rest);
        return;
      case "create":
        await rolesCreate(client, rest);
        return;
      case "update":
        await rolesUpdate(client, rest);
        return;
      case "delete":
        await rolesDelete(client, rest);
        return;
      default:
        console.error(kleur.red(`Unknown roles subcommand: ${sub ?? "(none)"}`));
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    reportAdminError(err);
  }
}

function parseKind(value: string | undefined, usage: string): RoleKind {
  if (value === undefined) fail(usage);
  const kind = RoleKindSchema.safeParse(value);
  if (!kind.success) fail(`The role kind is instance or organization, not ${value}.`);
  return kind.data;
}

function printRole(role: AdminRole): void {
  console.log(
    kleur.bold(role.name) +
      (role.builtIn ? kleur.dim("  (built in)") : "") +
      (role.description ? kleur.dim(`  ${role.description}`) : ""),
  );
  console.log(
    kleur.dim("  permissions: ") +
      (role.permissions.length ? role.permissions.join(", ") : kleur.dim("none")),
  );
}

function printJsonOr(rest: string[], role: AdminRole, message: string): void {
  if (rest.includes("--json")) {
    console.log(JSON.stringify(role, null, 2));
    return;
  }
  console.log(kleur.green(message));
  printRole(role);
}

async function rolesList(client: AuthClient, args: string[]): Promise<void> {
  const kindFlag = extractFlag(args, "kind");
  const kind =
    kindFlag.value === undefined
      ? undefined
      : parseKind(kindFlag.value, "Usage: seamless roles list [--kind instance|organization] [--json]");

  const roles = (await listRoles(client)).filter((role) => !kind || role.kind === kind);

  if (kindFlag.rest.includes("--json")) {
    console.log(JSON.stringify(roles, null, 2));
    return;
  }
  if (roles.length === 0) {
    console.log(kleur.dim("No roles."));
    return;
  }

  for (const group of RoleKindSchema.options) {
    const inGroup = roles.filter((role) => role.kind === group);
    if (inGroup.length === 0) continue;
    console.log(kleur.underline(KIND_LABEL[group]));
    for (const role of inGroup) printRole(role);
  }
}

// The API replaces the whole mapping, so a permission left off is taken away from
// every holder on their next token. Reading the current mapping first lets the
// command say what is about to go, and ask before it does.
async function rolesSet(client: AuthClient, args: string[]): Promise<void> {
  const usage =
    "Usage: seamless roles set <instance|organization> <role> (<permission>... | --none) [--force] [--json]";
  const none = args.includes("--none");
  const [kindArg, name, ...listed] = positionals(args);
  const kind = parseKind(kindArg, usage);
  if (!name) fail(usage);

  const permissions = listed.flatMap((item) => parseList(item) ?? []);
  if (permissions.length === 0 && !none) {
    fail(
      `Name the permissions ${name} should grant, or pass --none to grant nothing. The list replaces what it grants now.`,
    );
  }
  if (permissions.length > 0 && none) {
    fail("Pass permissions or --none, not both.");
  }
  for (const permission of permissions) checkName(permission, "permission");
  const body = validate(SetRolePermissionsRequestSchema, {
    permissions: [...new Set(permissions)],
  });

  const current = (await listRoles(client)).find(
    (role) => role.kind === kind && role.name === name,
  );
  const removed = current
    ? current.permissions.filter((p) => !body.permissions.includes(p))
    : [];

  if (removed.length > 0) {
    const confirmed = await confirmDestructive({
      message: `Take ${removed.join(", ")} away from the ${kind} role ${name}? Holders lose ${removed.length === 1 ? "it" : "them"} on their next access token.`,
      force: hasForceFlag(args),
    });
    if (!confirmed) {
      console.log(kleur.dim("Cancelled."));
      return;
    }
  }

  const role = await setRolePermissions(client, kind, name, body.permissions);
  printJsonOr(args, role, `Set the permissions of the ${kind} role ${name}.`);
}

async function rolesCreate(client: AuthClient, args: string[]): Promise<void> {
  const description = extractFlag(args, "description");
  const permissionsFlag = extractFlag(description.rest, "permissions");
  const name = positionals(permissionsFlag.rest)[0];
  if (!name) {
    fail(
      "Usage: seamless roles create <name> [--description <text>] [--permissions a,b] [--json]",
    );
  }

  const permissions = parseList(permissionsFlag.value);
  for (const permission of permissions ?? []) checkName(permission, "permission");
  const body = validate(CreateOrganizationRoleRequestSchema, {
    name: checkName(name, "role"),
    ...(description.value !== undefined ? { description: description.value } : {}),
    ...(permissions?.length ? { permissions: [...new Set(permissions)] } : {}),
  });

  const role = await createOrganizationRole(client, body);
  printJsonOr(permissionsFlag.rest, role, `Created organization role ${role.name}.`);
}

async function rolesUpdate(client: AuthClient, args: string[]): Promise<void> {
  const description = extractFlag(args, "description");
  const clear = description.rest.includes("--no-description");
  const name = positionals(description.rest)[0];
  if (!name) {
    fail(
      "Usage: seamless roles update <name> (--description <text> | --no-description) [--json]",
    );
  }
  if (description.value === undefined && !clear) {
    fail("Nothing to update. Pass --description <text>, or --no-description to clear it.");
  }
  if (description.value !== undefined && clear) {
    fail("Pass --description or --no-description, not both.");
  }

  const body = validate(UpdateOrganizationRoleRequestSchema, {
    description: clear ? null : description.value,
  });
  const role = await updateOrganizationRole(client, name, body);
  printJsonOr(description.rest, role, `Updated organization role ${role.name}.`);
}

async function rolesDelete(client: AuthClient, args: string[]): Promise<void> {
  const name = positionals(args)[0];
  if (!name) fail("Usage: seamless roles delete <name> [--force]");

  const confirmed = await confirmDestructive({
    message: `Delete organization role ${name} and what it grants? This cannot be undone.`,
    force: hasForceFlag(args),
  });
  if (!confirmed) {
    console.log(kleur.dim("Cancelled."));
    return;
  }

  await deleteOrganizationRole(client, name);
  console.log(kleur.green(`Deleted organization role ${name}.`));
}
