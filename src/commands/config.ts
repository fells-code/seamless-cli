import { missingOAuthProviderEndpoints } from "@seamless-auth/types";
import fs from "fs";
import kleur from "kleur";
import { extractFlag } from "../core/args.js";
import { createAuthClient, ReauthRequiredError, type AuthClient } from "../core/authClient.js";
import {
  checkValue,
  ConfigApiError,
  createOAuthProvider,
  deleteOAuthProvider,
  diffConfig,
  filterWritable,
  getRoles,
  getSystemConfig,
  listOAuthProviders,
  isKnownKey,
  isWritableKey,
  parseValue,
  patchSystemConfig,
  PermissionError,
  refreshOAuthProviderDiscovery,
  updateOAuthProvider,
  type ConfigChange,
  type OAuthProviderInput,
  type SystemConfig,
  type SystemConfigInput,
  WRITABLE_KEYS,
} from "../core/systemConfig.js";
import {
  confirmDestructive,
  hasForceFlag,
} from "../core/confirmAction.js";
import {
  checkLogoUrl,
  getHostedUi,
  HOSTED_UI_FIELDS,
  HOSTED_UI_KEY,
  isHostedUiField,
  mergeHostedUi,
  putHostedUi,
  removeHostedUiFields,
  validateHostedUi,
  type HostedUi,
  type HostedUiChanges,
  type HostedUiColorField,
} from "../core/hostedUi.js";

export async function runConfig(args: string[]): Promise<void> {
  const sub = args[0];
  const { value: profileFlag, rest } = extractFlag(args.slice(1), "profile");

  try {
    const client = await createAuthClient({ profileFlag });
    switch (sub) {
      case "get":
        await configGet(client, rest);
        return;
      case "set":
        await configSet(client, rest);
        return;
      case "roles":
        await configRoles(client, rest);
        return;
      case "diff":
        await configDiff(client, rest);
        return;
      case "apply":
        await configApply(client, rest);
        return;
      case "oauth-providers":
      case "oauth":
        await configOAuthProviders(client, rest);
        return;
      case "hosted-ui":
      case "branding":
        await configHostedUi(client, rest);
        return;
      default:
        console.error(kleur.red(`Unknown config subcommand: ${sub ?? "(none)"}`));
        console.log(
          "Usage: seamless config <get|set|roles|diff|apply|oauth-providers|hosted-ui>",
        );
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      console.log(kleur.yellow(err.message));
      process.exit(1);
    }
    if (err instanceof PermissionError || err instanceof ConfigApiError) {
      console.error(kleur.red(err.message));
      process.exit(1);
    }
    throw err;
  }
}

async function configGet(client: AuthClient, rest: string[]): Promise<void> {
  const json = rest.includes("--json");
  const key = rest.find((arg) => !arg.startsWith("--"));
  const config = await getSystemConfig(client);

  if (key) {
    if (!(key in config)) {
      console.error(kleur.red(`No such config key: ${key}`));
      process.exit(1);
    }
    const value = config[key];
    console.log(
      json
        ? JSON.stringify(value, null, 2)
        : typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2),
    );
    return;
  }

  if (json) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  printConfig(config);
}

async function configSet(client: AuthClient, rest: string[]): Promise<void> {
  const positional = rest.filter((arg) => !arg.startsWith("--"));
  const [key, ...valueParts] = positional;
  if (!key || valueParts.length === 0) {
    console.error(kleur.red("Usage: seamless config set <key> <value>"));
    process.exit(1);
  }

  if (!isWritableKey(key)) {
    console.error(kleur.red(`"${key}" is not a writable config key.`));
    console.error(kleur.dim(`Writable keys: ${WRITABLE_KEYS.join(", ")}`));
    process.exit(1);
  }

  let value = parseValue(valueParts.join(" "), key);
  checkValue(key, value);
  if (key === HOSTED_UI_KEY && value !== null) value = validateHostedUi(value);
  const result = await patchSystemConfig(client, { [key]: value });

  if (result.updatedKeys.length) {
    console.log(kleur.green(`Updated: ${result.updatedKeys.join(", ")}`));
  } else {
    console.log(kleur.dim("No changes."));
  }
}

async function configRoles(client: AuthClient, rest: string[]): Promise<void> {
  const json = rest.includes("--json");
  const roles = await getRoles(client);

  if (json) {
    console.log(JSON.stringify(roles, null, 2));
    return;
  }
  if (roles.length === 0) {
    console.log(kleur.dim("No roles."));
    return;
  }
  for (const role of roles) {
    console.log("  " + role);
  }
}

async function configDiff(client: AuthClient, rest: string[]): Promise<void> {
  const file = rest.find((arg) => !arg.startsWith("--"));
  if (!file) {
    console.error(kleur.red("Usage: seamless config diff <file>"));
    process.exit(1);
  }

  const local = readConfigFile(file);
  reportUnknownKeys(local);
  const remote = await getSystemConfig(client);
  const changes = diffConfig(local, remote);

  if (changes.length === 0) {
    console.log(kleur.green("In sync. No differences."));
    return;
  }
  printChanges(changes);
}

async function configApply(client: AuthClient, rest: string[]): Promise<void> {
  const dryRun = rest.includes("--dry-run");
  const file = rest.find((arg) => !arg.startsWith("--"));
  if (!file) {
    console.error(kleur.red("Usage: seamless config apply <file> [--dry-run]"));
    process.exit(1);
  }

  const local = readConfigFile(file);
  const { patch, readOnly, unknown } = filterWritable(local);
  if (readOnly.length) {
    console.log(kleur.dim(`Ignoring read-only keys: ${readOnly.join(", ")}`));
  }
  if (unknown.length) {
    console.log(kleur.yellow(`Ignoring unknown keys: ${unknown.join(", ")}`));
  }

  const remote = await getSystemConfig(client);
  const changes = diffConfig(patch, remote);

  if (changes.length === 0) {
    console.log(kleur.green("Already in sync. Nothing to apply."));
    return;
  }

  printChanges(changes);

  if (dryRun) {
    console.log(kleur.dim("Dry run: no changes applied."));
    return;
  }

  const proceed = await confirmDestructive({
    message: `Apply ${changes.length} change${
      changes.length === 1 ? "" : "s"
    } to ${client.profile.instanceUrl}?`,
    force: hasForceFlag(rest),
    remedy: "Pass --force to apply without confirming.",
  });
  if (!proceed) {
    console.log("Cancelled.");
    return;
  }

  const body = Object.fromEntries(changes.map((change) => [change.key, change.to]));
  const result = await patchSystemConfig(client, body);
  console.log(
    kleur.green(
      `Applied. Updated: ${result.updatedKeys.join(", ") || "(none reported)"}`,
    ),
  );
}

async function configOAuthProviders(
  client: AuthClient,
  rest: string[],
): Promise<void> {
  const action = rest[0];
  const args = rest.slice(1);

  switch (action) {
    case "list":
      await oauthProvidersList(client, args);
      return;
    case "add":
      await oauthProvidersAdd(client, args);
      return;
    case "update":
      await oauthProvidersUpdate(client, args);
      return;
    case "refresh":
    case "discover":
      await oauthProvidersRefresh(client, args);
      return;
    case "remove":
    case "delete":
      await oauthProvidersRemove(client, args);
      return;
    default:
      console.error(
        kleur.red(
          `Unknown config oauth-providers subcommand: ${action ?? "(none)"}`,
        ),
      );
      console.log(
        "Usage: seamless config oauth-providers <list|add|update|refresh|remove>",
      );
      process.exit(1);
  }
}

async function oauthProvidersList(
  client: AuthClient,
  rest: string[],
): Promise<void> {
  const json = rest.includes("--json");
  const providers = await listOAuthProviders(client);

  if (json) {
    console.log(JSON.stringify(providers, null, 2));
    return;
  }
  if (providers.length === 0) {
    console.log(kleur.dim("No OAuth providers configured."));
    return;
  }
  for (const provider of providers) {
    const name = provider.name ?? "";
    const status =
      provider.enabled === false
        ? kleur.yellow("disabled")
        : kleur.green("enabled");
    const issuer = provider.issuer ? `  ${kleur.dim(provider.issuer)}` : "";
    console.log(
      `  ${kleur.bold(provider.id)}  ${kleur.dim(name)}  ${status}${issuer}`,
    );
  }
}

async function oauthProvidersAdd(
  client: AuthClient,
  rest: string[],
): Promise<void> {
  const { value: issuer, rest: withoutIssuer } = extractFlag(rest, "issuer");
  const { value: file, rest: positional } = extractFlag(withoutIssuer, "file");
  const input = readProviderInput(
    file,
    positional.filter((arg) => !arg.startsWith("--")).join(" "),
  );
  if (issuer !== undefined) input.issuer = issuer;

  const missing = missingOAuthProviderEndpoints(input);
  if (missing.length) {
    throw new ConfigApiError(
      `Missing ${missing.join(", ")}. A provider without an issuer must name its endpoints; pass --issuer <url> to discover them instead.`,
    );
  }

  const provider = await createOAuthProvider(client, input);
  console.log(kleur.green(`Added OAuth provider: ${String(provider.id ?? "")}`));
}

async function oauthProvidersUpdate(
  client: AuthClient,
  rest: string[],
): Promise<void> {
  const { value: issuer, rest: withoutIssuer } = extractFlag(rest, "issuer");
  const { value: file, rest: positional } = extractFlag(withoutIssuer, "file");
  const nonFlag = positional.filter((arg) => !arg.startsWith("--"));
  const id = nonFlag[0];
  if (!id) {
    console.error(
      kleur.red(
        "Usage: seamless config oauth-providers update <id> <json|--file <path>> [--issuer <url>]",
      ),
    );
    process.exit(1);
  }

  const inlineJson = nonFlag.slice(1).join(" ");
  const updates =
    issuer !== undefined && !file && !inlineJson.trim()
      ? {}
      : readProviderInput(file, inlineJson);
  if (issuer !== undefined) updates.issuer = issuer;
  // The id is immutable and comes from the path; the API rejects it in the body.
  delete updates.id;

  const provider = await updateOAuthProvider(client, id, updates);
  console.log(kleur.green(`Updated OAuth provider: ${String(provider.id ?? id)}`));
}

async function oauthProvidersRefresh(
  client: AuthClient,
  rest: string[],
): Promise<void> {
  const id = rest.find((arg) => !arg.startsWith("-"));
  if (!id) {
    console.error(
      kleur.red("Usage: seamless config oauth-providers refresh <id> [--json]"),
    );
    process.exit(1);
  }

  const provider = await refreshOAuthProviderDiscovery(client, id);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(provider, null, 2));
    return;
  }
  console.log(kleur.green(`Refreshed discovery for OAuth provider: ${id}`));
  const rows = DISCOVERED_FIELDS.map(
    (field) => [field, provider[field]] as const,
  );
  const width = rows.reduce((max, [field]) => Math.max(max, field.length), 0);
  for (const [field, value] of rows) {
    console.log(
      "  " +
        kleur.dim(field.padEnd(width) + "  ") +
        (typeof value === "string" ? value : kleur.dim("(none)")),
    );
  }
}

const DISCOVERED_FIELDS = [
  "issuer",
  "authorizationUrl",
  "tokenUrl",
  "userInfoUrl",
  "jwksUri",
] as const;

async function oauthProvidersRemove(
  client: AuthClient,
  rest: string[],
): Promise<void> {
  const id = rest.find((arg) => !arg.startsWith("-"));
  if (!id) {
    console.error(
      kleur.red("Usage: seamless config oauth-providers remove <id> [--force]"),
    );
    process.exit(1);
  }

  const proceed = await confirmDestructive({
    message: `Remove OAuth provider "${id}" from ${client.profile.instanceUrl}?`,
    // This subcommand shipped with --yes before --force was the convention, so
    // hasForceFlag keeps accepting it.
    force: hasForceFlag(rest),
    remedy: "Pass --force to remove it without confirming.",
  });
  if (!proceed) {
    console.log("Cancelled.");
    return;
  }

  await deleteOAuthProvider(client, id);
  console.log(kleur.green(`Removed OAuth provider: ${id}`));
}

async function configHostedUi(client: AuthClient, rest: string[]): Promise<void> {
  const action = rest[0];
  const args = rest.slice(1);

  switch (action) {
    case "get":
      await hostedUiGet(client, args);
      return;
    case "set":
      await hostedUiSet(client, args);
      return;
    case "reset":
      await hostedUiReset(client, args);
      return;
    default:
      console.error(
        kleur.red(`Unknown config hosted-ui subcommand: ${action ?? "(none)"}`),
      );
      console.log("Usage: seamless config hosted-ui <get|set|reset>");
      process.exit(1);
  }
}

async function hostedUiGet(client: AuthClient, rest: string[]): Promise<void> {
  const hostedUi = await getHostedUi(client);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(hostedUi, null, 2));
    return;
  }
  printHostedUi(hostedUi);
}

const COLOR_FLAGS: Record<string, HostedUiColorField> = {
  primary: "primary",
  "on-primary": "onPrimary",
  background: "background",
  surface: "surface",
  text: "text",
  muted: "muted",
};

const HOSTED_UI_SET_USAGE =
  "Usage: seamless config hosted-ui set [--app-name <name>] [--logo <https-url>] " +
  "[--font-family <stack>] [--primary|--on-primary|--background|--surface|--text|--muted <hex>]";

function takeFlag(
  args: string[],
  name: string,
): { present: boolean; value?: string; rest: string[] } {
  const present = args.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  const { value, rest } = extractFlag(args, name);
  if (present && value === undefined) {
    throw new ConfigApiError(`--${name} needs a value.`);
  }
  return { present, value, rest };
}

function parseHostedUiChanges(args: string[]): HostedUiChanges {
  const changes: HostedUiChanges = {};
  let remaining = args;

  const scalar = (flag: string): string | undefined => {
    const taken = takeFlag(remaining, flag);
    remaining = taken.rest;
    return taken.value;
  };

  const appName = scalar("app-name");
  if (appName !== undefined) changes.appName = appName;
  const logo = scalar("logo");
  if (logo !== undefined) {
    checkLogoUrl(logo);
    changes.logoUrl = logo;
  }
  const fontFamily = scalar("font-family");
  if (fontFamily !== undefined) changes.fontFamily = fontFamily;

  for (const [flag, field] of Object.entries(COLOR_FLAGS)) {
    const color = scalar(flag);
    if (color !== undefined) changes.colors = { ...changes.colors, [field]: color };
  }

  if (remaining.length) {
    throw new ConfigApiError(
      `Unexpected argument: ${remaining.join(" ")}. ${HOSTED_UI_SET_USAGE}`,
    );
  }
  if (Object.keys(changes).length === 0) {
    throw new ConfigApiError(`Nothing to set. ${HOSTED_UI_SET_USAGE}`);
  }
  return changes;
}

async function hostedUiSet(client: AuthClient, rest: string[]): Promise<void> {
  const changes = parseHostedUiChanges(rest);
  const current = await getHostedUi(client);
  const merged = validateHostedUi(mergeHostedUi(current, changes));

  await putHostedUi(client, merged);
  console.log(kleur.green("Updated hosted page branding."));
  printHostedUi(merged);
}

async function hostedUiReset(client: AuthClient, rest: string[]): Promise<void> {
  const fields = rest.filter((arg) => !arg.startsWith("-"));
  const unknown = fields.filter((field) => !isHostedUiField(field));
  if (unknown.length) {
    throw new ConfigApiError(
      `Not a hosted page branding field: ${unknown.join(", ")}. ` +
        `Fields: ${HOSTED_UI_FIELDS.join(", ")}`,
    );
  }

  const current = await getHostedUi(client);
  if (!current) {
    console.log(kleur.dim("No hosted page branding is set. Nothing to reset."));
    return;
  }

  if (fields.length === 0) {
    const proceed = await confirmDestructive({
      message: `Clear all hosted page branding on ${client.profile.instanceUrl}?`,
      force: hasForceFlag(rest),
      remedy: "Pass --force to clear it without confirming.",
    });
    if (!proceed) {
      console.log("Cancelled.");
      return;
    }
    await putHostedUi(client, null);
    console.log(kleur.green("Cleared hosted page branding."));
    return;
  }

  const next = removeHostedUiFields(current, fields.filter(isHostedUiField));
  await putHostedUi(client, next);
  console.log(kleur.green(`Reset: ${fields.join(", ")}`));
  printHostedUi(next);
}

function printHostedUi(hostedUi: HostedUi | null): void {
  if (!hostedUi || Object.keys(hostedUi).length === 0) {
    console.log(kleur.dim("No hosted page branding is set."));
    return;
  }
  const { colors, ...rest } = hostedUi;
  const rows: [string, string][] = Object.entries(rest).map(([key, value]) => [
    key,
    String(value),
  ]);
  for (const [key, value] of Object.entries(colors ?? {})) {
    rows.push([`colors.${key}`, String(value)]);
  }
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  for (const [key, value] of rows) {
    console.log("  " + kleur.dim(key.padEnd(width) + "  ") + value);
  }
}

function readProviderInput(
  file: string | undefined,
  inlineJson: string,
): OAuthProviderInput {
  let raw: string;
  if (file) {
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      throw new ConfigApiError(`Could not read file: ${file}`);
    }
  } else if (inlineJson.trim()) {
    raw = inlineJson;
  } else {
    throw new ConfigApiError("Provide a JSON provider object, or --file <path>.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigApiError("Provider input is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigApiError("Provider input must be a JSON object.");
  }
  return parsed as OAuthProviderInput;
}

function readConfigFile(file: string): SystemConfigInput {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    throw new ConfigApiError(`Could not read file: ${file}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigApiError(`${file} is not valid JSON.`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigApiError(`${file} must contain a JSON object.`);
  }
  return parsed as SystemConfigInput;
}

// A key no version of the config this CLI knows has is most often a typo, which
// would otherwise read as a value the instance simply has not set.
function reportUnknownKeys(local: SystemConfigInput): void {
  const unknown = Object.keys(local).filter((key) => !isKnownKey(key));
  if (unknown.length) {
    console.log(kleur.yellow(`Not a config key this CLI knows: ${unknown.join(", ")}`));
  }
}

function inline(value: unknown): string {
  return value === undefined ? "(unset)" : JSON.stringify(value);
}

function printConfig(config: SystemConfig): void {
  const keys = Object.keys(config).sort();
  const width = keys.reduce((max, key) => Math.max(max, key.length), 0);
  for (const key of keys) {
    console.log(kleur.dim(key.padEnd(width) + "  ") + inline(config[key]));
  }
}

function printChanges(changes: ConfigChange[]): void {
  for (const change of changes) {
    console.log(kleur.bold(change.key));
    console.log("  " + kleur.red(`- ${inline(change.from)}`));
    console.log("  " + kleur.green(`+ ${inline(change.to)}`));
  }
}
