import {
  OidcResourceCreateRequestSchema,
  OidcResourceUpdateRequestSchema,
  type OidcResource,
} from "@seamless-auth/types";
import kleur from "kleur";
import type { z } from "zod";
import { extractFlag } from "../core/args.js";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  createResource,
  deleteResource,
  getResource,
  listResources,
  updateResource,
} from "../core/admin.js";
import { confirmDestructive, hasForceFlag } from "../core/confirmAction.js";
import { parseList, reportAdminError } from "./adminShared.js";

const USAGE = "Usage: seamless resources <list|get|create|update|delete>";

export async function runResources(args: string[]): Promise<void> {
  const sub = args[0];
  const { value: profileFlag, rest } = extractFlag(args.slice(1), "profile");

  try {
    const client = await createAuthClient({ profileFlag });
    switch (sub) {
      case "list":
        await resourcesList(client, rest);
        return;
      case "get":
        await resourcesGet(client, rest);
        return;
      case "create":
        await resourcesCreate(client, rest);
        return;
      case "update":
        await resourcesUpdate(client, rest);
        return;
      case "delete":
        await resourcesDelete(client, rest);
        return;
      default:
        console.error(kleur.red(`Unknown resources subcommand: ${sub ?? "(none)"}`));
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    reportAdminError(err);
  }
}

function fail(message: string): never {
  console.error(kleur.red(message));
  process.exit(1);
}

function positional(rest: string[]): string | undefined {
  return rest.find((arg) => !arg.startsWith("-"));
}

function validate<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  fail(
    result.error.issues
      .map((issue) => {
        const where = issue.path.join(".");
        return where ? `${where}: ${issue.message}` : issue.message;
      })
      .join("\n"),
  );
}

interface ResourceFlags {
  settings: Record<string, unknown>;
  rest: string[];
}

function readSettings(args: string[]): ResourceFlags {
  const settings: Record<string, unknown> = {};
  const name = extractFlag(args, "name");
  const scopes = extractFlag(name.rest, "scopes");
  const ttl = extractFlag(scopes.rest, "access-token-ttl");

  if (name.value !== undefined) settings.name = name.value;
  if (scopes.value !== undefined) settings.scopes = parseList(scopes.value);
  if (ttl.value !== undefined) {
    if (ttl.value === "default") {
      settings.accessTokenTtlSeconds = null;
    } else {
      const seconds = Number(ttl.value);
      if (!Number.isInteger(seconds)) {
        fail('--access-token-ttl must be a whole number of seconds, or "default".');
      }
      settings.accessTokenTtlSeconds = seconds;
    }
  }

  return { settings, rest: ttl.rest };
}

function printRow(resource: OidcResource): void {
  console.log(
    `${kleur.bold(resource.id)}  ${resource.identifier}  ${resource.name}  ${kleur.dim(resource.scopes.join(" ") || "(no scopes)")}`,
  );
}

function printResource(resource: OidcResource): void {
  console.log(`  id:          ${resource.id}`);
  console.log(`  identifier:  ${resource.identifier}`);
  console.log(`  name:        ${resource.name}`);
  console.log(`  scopes:      ${resource.scopes.join(" ") || "none"}`);
  console.log(
    `  token TTL:   ${resource.accessTokenTtlSeconds === null ? "default" : `${resource.accessTokenTtlSeconds}s`}`,
  );
}

async function resourcesList(client: AuthClient, rest: string[]): Promise<void> {
  const resources = await listResources(client);

  if (rest.includes("--json")) {
    console.log(JSON.stringify(resources, null, 2));
    return;
  }
  if (resources.length === 0) {
    console.log(kleur.dim("No resources."));
    return;
  }
  for (const resource of resources) printRow(resource);
}

async function resourcesGet(client: AuthClient, rest: string[]): Promise<void> {
  const id = positional(rest);
  if (!id) fail("Usage: seamless resources get <id> [--json]");

  const resource = await getResource(client, id);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(resource, null, 2));
    return;
  }
  printResource(resource);
}

async function resourcesCreate(client: AuthClient, args: string[]): Promise<void> {
  const { settings, rest } = readSettings(args);
  const identifier = positional(rest);
  if (!identifier || settings.name === undefined) {
    fail(
      "Usage: seamless resources create <identifier> --name <name> [--scopes a,b] [--access-token-ttl <seconds>]",
    );
  }

  const body = validate(OidcResourceCreateRequestSchema, { identifier, ...settings });
  const resource = await createResource(client, body);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(resource, null, 2));
    return;
  }
  console.log(kleur.green(`Created resource ${resource.id}.`));
  printResource(resource);
}

async function resourcesUpdate(client: AuthClient, args: string[]): Promise<void> {
  const { settings, rest } = readSettings(args);
  const id = positional(rest);
  if (!id) {
    fail(
      "Usage: seamless resources update <id> [--name <name>] [--scopes a,b] [--access-token-ttl <seconds|default>]",
    );
  }
  if (Object.keys(settings).length === 0) {
    fail("Nothing to update. Pass --name, --scopes or --access-token-ttl.");
  }

  const body = validate(OidcResourceUpdateRequestSchema, settings);
  const resource = await updateResource(client, id, body);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(resource, null, 2));
    return;
  }
  console.log(kleur.green(`Updated resource ${id}.`));
  printResource(resource);
}

async function resourcesDelete(client: AuthClient, rest: string[]): Promise<void> {
  const id = positional(rest);
  if (!id) fail("Usage: seamless resources delete <id> [--force]");

  const confirmed = await confirmDestructive({
    message: `Delete resource ${id}? Every application allowed it loses access. This cannot be undone.`,
    force: hasForceFlag(rest),
  });
  if (!confirmed) {
    console.log(kleur.dim("Cancelled."));
    return;
  }

  await deleteResource(client, id);
  console.log(kleur.green(`Deleted resource ${id}.`));
}
