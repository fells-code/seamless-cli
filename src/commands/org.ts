import type {
  AddOrganizationMemberRequest,
  CreateOrganizationRequest,
  UpdateOrganizationMemberRequest,
  UpdateOrganizationRequest,
} from "@seamless-auth/types";
import kleur from "kleur";
import { extractFlag } from "../core/args.js";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  addMember,
  createOrg,
  getOrg,
  listMembers,
  listOrgs,
  removeMember,
  updateMember,
  updateOrg,
  type AdminMembership,
  type AdminOrganization,
} from "../core/admin.js";
import {
  pagePosition,
  parseList,
  parseWindow,
  reportAdminError,
} from "./adminShared.js";
import {
  confirmDestructive,
  hasForceFlag,
} from "../core/confirmAction.js";

export async function runOrg(args: string[]): Promise<void> {
  if (args[0] === "members") {
    await runOrgMembers(args.slice(1));
    return;
  }

  const sub = args[0];
  const { value: profileFlag, rest } = extractFlag(args.slice(1), "profile");

  try {
    const client = await createAuthClient({ profileFlag });
    switch (sub) {
      case "list":
        await orgList(client, rest);
        return;
      case "create":
        await orgCreate(client, rest);
        return;
      case "get":
        await orgGet(client, rest);
        return;
      case "update":
        await orgUpdate(client, rest);
        return;
      default:
        console.error(kleur.red(`Unknown org subcommand: ${sub ?? "(none)"}`));
        console.log("Usage: seamless org <list|create|get|update|members>");
        process.exit(1);
    }
  } catch (err) {
    reportAdminError(err);
  }
}

async function runOrgMembers(args: string[]): Promise<void> {
  const sub = args[0];
  const { value: profileFlag, rest } = extractFlag(args.slice(1), "profile");

  try {
    const client = await createAuthClient({ profileFlag });
    switch (sub) {
      case "list":
        await membersList(client, rest);
        return;
      case "add":
        await membersAdd(client, rest);
        return;
      case "update":
        await membersUpdate(client, rest);
        return;
      case "remove":
        await membersRemove(client, rest);
        return;
      default:
        console.error(kleur.red(`Unknown org members subcommand: ${sub ?? "(none)"}`));
        console.log("Usage: seamless org members <list|add|update|remove>");
        process.exit(1);
    }
  } catch (err) {
    reportAdminError(err);
  }
}

async function orgList(client: AuthClient, rest: string[]): Promise<void> {
  const json = rest.includes("--json");
  const { limit, offset, rest: remaining } = parseWindow(rest);
  const { value: search } = extractFlag(remaining, "search");

  const { organizations, total } = await listOrgs(client, {
    limit,
    offset,
    ...(search ? { search } : {}),
  });

  if (json) {
    console.log(JSON.stringify(organizations, null, 2));
    return;
  }
  if (organizations.length === 0) {
    console.log(kleur.dim("No organizations."));
    return;
  }
  for (const org of organizations) {
    printOrgRow(org);
  }
  console.log(
    kleur.dim(pagePosition(offset, organizations.length, total, "organization")),
  );
}

async function orgCreate(client: AuthClient, rest: string[]): Promise<void> {
  const slugFlag = extractFlag(rest, "slug");
  const nameFlag = extractFlag(slugFlag.rest, "name");
  const name = nameFlag.value ?? nameFlag.rest.find((a) => !a.startsWith("--"));
  if (!name) {
    console.error(
      kleur.red("Usage: seamless org create <name> [--slug <slug>]"),
    );
    process.exit(1);
  }

  const body: CreateOrganizationRequest = { name };
  if (slugFlag.value) body.slug = slugFlag.value;

  const org = await createOrg(client, body);
  console.log(kleur.green(`Created organization ${org.id}.`));
  printOrg(org);
}

async function orgGet(client: AuthClient, rest: string[]): Promise<void> {
  const json = rest.includes("--json");
  const id = rest.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error(kleur.red("Usage: seamless org get <id>"));
    process.exit(1);
  }
  const org = await getOrg(client, id);
  if (json) {
    console.log(JSON.stringify(org, null, 2));
    return;
  }
  printOrg(org);
}

async function orgUpdate(client: AuthClient, rest: string[]): Promise<void> {
  const nameFlag = extractFlag(rest, "name");
  const slugFlag = extractFlag(nameFlag.rest, "slug");
  const id = slugFlag.rest.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error(
      kleur.red("Usage: seamless org update <id> [--name <name>] [--slug <slug>]"),
    );
    process.exit(1);
  }

  const body: UpdateOrganizationRequest = {};
  if (nameFlag.value) body.name = nameFlag.value;
  if (slugFlag.value) body.slug = slugFlag.value;
  if (Object.keys(body).length === 0) {
    console.error(kleur.red("Nothing to update. Pass --name and/or --slug."));
    process.exit(1);
  }

  const org = await updateOrg(client, id, body);
  console.log(kleur.green(`Updated organization ${id}.`));
  printOrg(org);
}

async function membersList(client: AuthClient, rest: string[]): Promise<void> {
  const json = rest.includes("--json");
  const orgId = rest.find((a) => !a.startsWith("--"));
  if (!orgId) {
    console.error(kleur.red("Usage: seamless org members list <orgId>"));
    process.exit(1);
  }

  const { members, total } = await listMembers(client, orgId);
  if (json) {
    console.log(JSON.stringify(members, null, 2));
    return;
  }
  if (members.length === 0) {
    console.log(kleur.dim("No members."));
    return;
  }
  for (const member of members) {
    printMemberRow(member);
  }
  console.log(kleur.dim(`${total} member${total === 1 ? "" : "s"}.`));
}

async function membersAdd(client: AuthClient, rest: string[]): Promise<void> {
  const userFlag = extractFlag(rest, "user");
  const emailFlag = extractFlag(userFlag.rest, "email");
  const rolesFlag = extractFlag(emailFlag.rest, "roles");
  const scopesFlag = extractFlag(rolesFlag.rest, "scopes");
  const orgId = scopesFlag.rest.find((a) => !a.startsWith("--"));

  if (!orgId || (!userFlag.value && !emailFlag.value)) {
    console.error(
      kleur.red(
        "Usage: seamless org members add <orgId> (--user <id> | --email <email>) [--roles a,b] [--scopes a,b]",
      ),
    );
    process.exit(1);
  }

  const body: AddOrganizationMemberRequest = {};
  if (userFlag.value) body.userId = userFlag.value;
  if (emailFlag.value) body.email = emailFlag.value;
  const roles = parseList(rolesFlag.value);
  const scopes = parseList(scopesFlag.value);
  if (roles) body.roles = roles;
  if (scopes) body.scopes = scopes;

  const membership = await addMember(client, orgId, body);
  console.log(kleur.green("Added member."));
  printMemberRow(membership);
}

async function membersUpdate(client: AuthClient, rest: string[]): Promise<void> {
  const rolesFlag = extractFlag(rest, "roles");
  const scopesFlag = extractFlag(rolesFlag.rest, "scopes");
  const positional = scopesFlag.rest.filter((a) => !a.startsWith("--"));
  const [orgId, userId] = positional;

  if (!orgId || !userId) {
    console.error(
      kleur.red(
        "Usage: seamless org members update <orgId> <userId> [--roles a,b] [--scopes a,b]",
      ),
    );
    process.exit(1);
  }

  const body: UpdateOrganizationMemberRequest = {};
  const roles = parseList(rolesFlag.value);
  const scopes = parseList(scopesFlag.value);
  if (roles) body.roles = roles;
  if (scopes) body.scopes = scopes;
  if (Object.keys(body).length === 0) {
    console.error(kleur.red("Nothing to update. Pass --roles and/or --scopes."));
    process.exit(1);
  }

  const membership = await updateMember(client, orgId, userId, body);
  console.log(kleur.green("Updated member."));
  printMemberRow(membership);
}

async function membersRemove(client: AuthClient, rest: string[]): Promise<void> {
  const positional = rest.filter((a) => !a.startsWith("--"));
  const [orgId, userId] = positional;
  if (!orgId || !userId) {
    console.error(
      kleur.red("Usage: seamless org members remove <orgId> <userId>"),
    );
    process.exit(1);
  }

  const proceed = await confirmDestructive({
    message: `Remove user ${userId} from organization ${orgId}?`,
    force: hasForceFlag(rest),
    remedy: "Pass --force to remove the member without confirming.",
  });
  if (!proceed) {
    console.log("Cancelled.");
    return;
  }

  await removeMember(client, orgId, userId);
  console.log(kleur.green(`Removed user ${userId} from ${orgId}.`));
}

function printOrgRow(org: AdminOrganization): void {
  console.log(
    kleur.bold(org.name) +
      kleur.dim(`  ${org.id}`) +
      (org.slug ? kleur.dim(`  (${org.slug})`) : ""),
  );
}

function printOrg(org: AdminOrganization): void {
  const line = (label: string, value: string) =>
    console.log(kleur.dim(`${label}:`.padEnd(8)) + value);
  line("Id", org.id);
  line("Name", org.name);
  line("Slug", org.slug || "(none)");
}

function printMemberRow(member: AdminMembership): void {
  console.log(
    kleur.bold(member.userId) +
      (member.roles.length ? kleur.dim(`  roles: ${member.roles.join(", ")}`) : "") +
      (member.scopes.length ? kleur.dim(`  scopes: ${member.scopes.join(", ")}`) : ""),
  );
}
