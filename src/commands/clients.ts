import { readFile } from "node:fs/promises";
import {
  OidcApplicationCreateRequestSchema,
  OidcApplicationKeysRequestSchema,
  OidcApplicationUpdateRequestSchema,
  type OidcApplication,
  type OidcApplicationKeysRequest,
  type OidcApplicationResource,
  type OidcApplicationResourceGrant,
  type OidcTokenEndpointAuthMethod,
} from "@seamless-auth/types";
import kleur from "kleur";
import type { z } from "zod";
import {
  extractFlag,
  extractRepeatedFlag,
  extractSwitch,
} from "../core/args.js";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  createApplication,
  deleteApplication,
  getApplication,
  listApplicationResources,
  listApplications,
  listResources,
  rotateApplicationSecret,
  setApplicationKeys,
  setApplicationResources,
  updateApplication,
} from "../core/admin.js";
import { confirmDestructive, hasForceFlag } from "../core/confirmAction.js";
import { parseList, reportAdminError } from "./adminShared.js";

const USAGE =
  "Usage: seamless clients <list|get|create|update|rotate-secret|keys|resources|delete>";

const SHARED_SECRET_NOTE =
  "Shared secrets are weaker than registered keys: anyone who reads one can act as the client. Prefer --auth-method private_key_jwt where the client can hold a key.";

export async function runClients(args: string[]): Promise<void> {
  const sub = args[0];
  const { value: profileFlag, rest } = extractFlag(args.slice(1), "profile");

  try {
    const client = await createAuthClient({ profileFlag });
    switch (sub) {
      case "list":
        await clientsList(client, rest);
        return;
      case "get":
        await clientsGet(client, rest);
        return;
      case "create":
        await clientsCreate(client, rest);
        return;
      case "update":
        await clientsUpdate(client, rest);
        return;
      case "rotate-secret":
        await clientsRotateSecret(client, rest);
        return;
      case "keys":
        await clientsKeys(client, rest);
        return;
      case "resources":
        await clientsResources(client, rest);
        return;
      case "delete":
        await clientsDelete(client, rest);
        return;
      default:
        console.error(kleur.red(`Unknown clients subcommand: ${sub ?? "(none)"}`));
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

function isSharedSecret(method: OidcTokenEndpointAuthMethod): boolean {
  return method === "client_secret_basic" || method === "client_secret_post";
}

/** Checks a request with the shared schema, so a refusal names the flag's field before the API is asked. */
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

function ttl(value: string | undefined, flag: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === "default") return null;

  const seconds = Number(value);
  if (!Number.isInteger(seconds)) {
    fail(`--${flag} must be a whole number of seconds, or "default".`);
  }
  return seconds;
}

async function readJwks(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    fail(`Could not read ${path}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${path} is not valid JSON.`);
  }
}

interface SettingsFlags {
  settings: Record<string, unknown>;
  rest: string[];
}

// The flags create and update share. Each is only set when given, so an update
// changes nothing it was not told to.
function readSettings(args: string[]): SettingsFlags {
  const settings: Record<string, unknown> = {};
  let rest = args;

  const take = (name: string): string | undefined => {
    const flag = extractFlag(rest, name);
    rest = flag.rest;
    return flag.value;
  };
  const takeAll = (name: string): string[] => {
    const flag = extractRepeatedFlag(rest, name);
    rest = flag.rest;
    return flag.values;
  };
  const takeSwitch = (on: string, off: string): boolean | undefined => {
    const flag = extractSwitch(rest, on, off);
    rest = flag.rest;
    return flag.value;
  };

  const name = take("name");
  if (name !== undefined) settings.name = name;

  const method = take("auth-method");
  if (method !== undefined) settings.tokenEndpointAuthMethod = method;

  const redirects = takeAll("redirect-uri");
  if (redirects.length) settings.redirectUris = redirects;

  const postLogout = takeAll("post-logout-uri");
  if (postLogout.length) settings.postLogoutRedirectUris = postLogout;

  const grants = take("grants");
  if (grants !== undefined) settings.grantTypes = parseList(grants);

  const firstParty = takeSwitch("first-party", "third-party");
  if (firstParty !== undefined) settings.firstParty = firstParty;

  const deviceFlow = takeSwitch("device-flow", "no-device-flow");
  if (deviceFlow !== undefined) settings.deviceFlowEnabled = deviceFlow;

  const notices = takeSwitch("notices", "no-notices");
  if (notices !== undefined) settings.noticesEnabled = notices;

  const logout = take("backchannel-logout-uri");
  if (logout !== undefined) {
    settings.backchannelLogoutUri = logout === "none" ? null : logout;
  }

  for (const [flag, key] of [
    ["access-token-ttl", "accessTokenTtlSeconds"],
    ["id-token-ttl", "idTokenTtlSeconds"],
    ["refresh-token-ttl", "refreshTokenTtlSeconds"],
  ] as const) {
    const value = ttl(take(flag), flag);
    if (value !== undefined) settings[key] = value;
  }

  return { settings, rest };
}

function printRow(app: OidcApplication): void {
  const type = `${app.clientType}, ${app.applicationType}`;
  const method = isSharedSecret(app.tokenEndpointAuthMethod)
    ? `${app.tokenEndpointAuthMethod} ${kleur.yellow("(weaker)")}`
    : app.tokenEndpointAuthMethod;
  const status = app.disabled ? kleur.red("disabled") : "";
  console.log(
    `${kleur.bold(app.id)}  ${app.name}  ${kleur.dim(type)}  ${method}  ${status}`.trimEnd(),
  );
}

function printApplication(app: OidcApplication): void {
  console.log(`  id:              ${app.id}`);
  console.log(`  name:            ${app.name}`);
  console.log(
    `  type:            ${app.clientType}, ${app.applicationType}${app.firstParty ? ", first-party" : ""}`,
  );
  console.log(
    `  authentication:  ${app.tokenEndpointAuthMethod}${isSharedSecret(app.tokenEndpointAuthMethod) ? kleur.yellow(" (shared secret, weaker)") : ""}`,
  );
  if (isSharedSecret(app.tokenEndpointAuthMethod)) {
    console.log(`  secret set:      ${app.hasSecret ? "yes" : "no"}`);
  }
  if (app.tokenEndpointAuthMethod === "private_key_jwt") {
    const keys = app.jwksUri
      ? app.jwksUri
      : app.jwks
        ? `${app.jwks.keys.length} key(s) registered`
        : kleur.yellow("none, register keys before this client can get tokens");
    console.log(`  keys:            ${keys}`);
  }
  console.log(`  redirect URIs:   ${app.redirectUris.join(", ") || "none"}`);
  if (app.postLogoutRedirectUris.length) {
    console.log(`  post-logout:     ${app.postLogoutRedirectUris.join(", ")}`);
  }
  const grants = [...app.grantTypes, ...(app.deviceFlowEnabled ? ["device_code"] : [])];
  console.log(`  grants:          ${grants.join(", ") || "none"}`);
  console.log(`  notices:         ${app.noticesEnabled ? "on" : "off"}`);
  if (app.backchannelLogoutUri) {
    console.log(`  logout URI:      ${app.backchannelLogoutUri}`);
  }
  console.log(`  status:          ${app.disabled ? "disabled" : "active"}`);
}

function printSecret(secret: string): void {
  console.log(kleur.yellow("Client secret (shown once, store it now):"));
  console.log(secret);
}

async function clientsList(client: AuthClient, rest: string[]): Promise<void> {
  const applications = await listApplications(client);

  if (rest.includes("--json")) {
    console.log(JSON.stringify(applications, null, 2));
    return;
  }
  if (applications.length === 0) {
    console.log(kleur.dim("No applications."));
    return;
  }
  for (const app of applications) printRow(app);
}

async function clientsGet(client: AuthClient, rest: string[]): Promise<void> {
  const id = positional(rest);
  if (!id) fail("Usage: seamless clients get <id> [--json]");

  const app = await getApplication(client, id);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(app, null, 2));
    return;
  }
  printApplication(app);
}

async function clientsCreate(client: AuthClient, args: string[]): Promise<void> {
  const json = args.includes("--json");
  const publicFlag = extractSwitch(args, "public", "confidential");
  const jwksFile = extractFlag(publicFlag.rest, "jwks-file");
  const jwksUri = extractFlag(jwksFile.rest, "jwks-uri");
  const { settings, rest } = readSettings(jwksUri.rest);

  if (settings.name === undefined) {
    const name = positional(rest.filter((arg) => arg !== "--json"));
    if (!name) {
      fail(
        "Usage: seamless clients create <name> [--public] [--redirect-uri <uri>]... (see seamless clients --help)",
      );
    }
    settings.name = name;
  }

  const body = validate(OidcApplicationCreateRequestSchema, {
    ...settings,
    clientType: publicFlag.value ? "public" : "confidential",
    ...(jwksFile.value ? { jwks: await readJwks(jwksFile.value) } : {}),
    ...(jwksUri.value ? { jwksUri: jwksUri.value } : {}),
  });

  const created = await createApplication(client, body);
  if (json) {
    console.log(JSON.stringify(created, null, 2));
    return;
  }

  const { application, clientSecret } = created;
  console.log(kleur.green(`Created application ${application.id}.`));
  printApplication(application);
  if (isSharedSecret(application.tokenEndpointAuthMethod)) {
    console.log(kleur.yellow(SHARED_SECRET_NOTE));
  }
  if (clientSecret) printSecret(clientSecret);
}

async function clientsUpdate(client: AuthClient, args: string[]): Promise<void> {
  const json = args.includes("--json");
  const disabled = extractSwitch(args, "disable", "enable");
  const { settings, rest } = readSettings(disabled.rest);
  const id = positional(rest.filter((arg) => arg !== "--json"));
  if (!id) fail("Usage: seamless clients update <id> [flags] (see seamless clients --help)");

  if (disabled.value !== undefined) settings.disabled = disabled.value;
  if (Object.keys(settings).length === 0) {
    fail("Nothing to update. Pass at least one setting (see seamless clients --help).");
  }

  const body = validate(OidcApplicationUpdateRequestSchema, settings);
  const app = await updateApplication(client, id, body);
  if (json) {
    console.log(JSON.stringify(app, null, 2));
    return;
  }
  console.log(kleur.green(`Updated application ${id}.`));
  printApplication(app);
}

async function clientsRotateSecret(client: AuthClient, rest: string[]): Promise<void> {
  const id = positional(rest);
  if (!id) fail("Usage: seamless clients rotate-secret <id> [--force] [--json]");

  const confirmed = await confirmDestructive({
    message: `Issue a new secret for application ${id}? Any current secret stops working at once.`,
    force: hasForceFlag(rest),
  });
  if (!confirmed) {
    console.log(kleur.dim("Cancelled."));
    return;
  }

  const { application, clientSecret } = await rotateApplicationSecret(client, id);
  if (rest.includes("--json")) {
    console.log(JSON.stringify({ application, clientSecret }, null, 2));
    return;
  }
  console.log(kleur.green(`Issued a new secret for ${application.name}.`));
  printSecret(clientSecret);
}

async function clientsKeys(client: AuthClient, args: string[]): Promise<void> {
  const jwksFile = extractFlag(args, "jwks-file");
  const jwksUri = extractFlag(jwksFile.rest, "jwks-uri");
  const id = positional(jwksUri.rest);
  if (!id || (jwksFile.value === undefined) === (jwksUri.value === undefined)) {
    fail("Usage: seamless clients keys <id> (--jwks-file <path> | --jwks-uri <url>)");
  }

  const body: OidcApplicationKeysRequest = validate(
    OidcApplicationKeysRequestSchema,
    jwksFile.value !== undefined
      ? { jwks: await readJwks(jwksFile.value) }
      : { jwksUri: jwksUri.value },
  );

  const app = await setApplicationKeys(client, id, body);
  console.log(kleur.green(`Registered keys for ${app.name}.`));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `<resource>[=scope,scope]`. Scope tokens may hold `:` and identifiers are URIs, but
// an identifier never holds `=` because the API refuses a query.
async function resolveGrants(
  client: AuthClient,
  values: string[],
): Promise<OidcApplicationResourceGrant[]> {
  const parsed = values.map((value) => {
    const split = value.indexOf("=");
    const ref = split === -1 ? value : value.slice(0, split);
    const scopes = split === -1 ? [] : (parseList(value.slice(split + 1)) ?? []);
    return { ref, scopes };
  });

  const needsLookup = parsed.some(({ ref }) => !UUID.test(ref));
  const resources = needsLookup ? await listResources(client) : [];

  return parsed.map(({ ref, scopes }) => {
    if (UUID.test(ref)) return { resourceId: ref, scopes };
    const match = resources.find((resource) => resource.identifier === ref);
    if (!match) fail(`No resource has the identifier ${ref}.`);
    return { resourceId: match.id, scopes };
  });
}

function printLinks(links: OidcApplicationResource[]): void {
  if (links.length === 0) {
    console.log(kleur.dim("No resources allowed."));
    return;
  }
  for (const link of links) {
    console.log(
      `${kleur.bold(link.identifier)}  ${link.name}  ${kleur.dim(link.scopes.join(" ") || "(no scopes)")}`,
    );
  }
}

async function clientsResources(client: AuthClient, args: string[]): Promise<void> {
  const json = args.includes("--json");
  const set = extractRepeatedFlag(args, "set");
  const clear = set.rest.includes("--clear");
  const id = positional(set.rest.filter((arg) => arg !== "--json" && arg !== "--clear"));
  if (!id) {
    fail(
      "Usage: seamless clients resources <id> [--set <resource>[=scope,scope]]... [--clear] [--json]",
    );
  }
  if (clear && set.values.length) fail("Pass --set or --clear, not both.");

  let links: OidcApplicationResource[];
  if (set.values.length || clear) {
    const grants = clear ? [] : await resolveGrants(client, set.values);
    links = await setApplicationResources(client, id, grants);
    if (!json) console.log(kleur.green(`Updated the resources application ${id} may use.`));
  } else {
    links = await listApplicationResources(client, id);
  }

  if (json) {
    console.log(JSON.stringify(links, null, 2));
    return;
  }
  printLinks(links);
}

async function clientsDelete(client: AuthClient, rest: string[]): Promise<void> {
  const id = positional(rest);
  if (!id) fail("Usage: seamless clients delete <id> [--force]");

  const confirmed = await confirmDestructive({
    message: `Delete application ${id}? It can no longer sign anyone in. This cannot be undone.`,
    force: hasForceFlag(rest),
  });
  if (!confirmed) {
    console.log(kleur.dim("Cancelled."));
    return;
  }

  await deleteApplication(client, id);
  console.log(kleur.green(`Deleted application ${id}.`));
}
