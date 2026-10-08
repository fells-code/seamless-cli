import fs from "fs";
import kleur from "kleur";
import { extractFlag } from "../core/args.js";
import { createAuthClient, ReauthRequiredError, type AuthClient } from "../core/authClient.js";
import {
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
      default:
        console.error(kleur.red(`Unknown config subcommand: ${sub ?? "(none)"}`));
        console.log(
          "Usage: seamless config <get|set|roles|diff|apply|oauth-providers>",
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

  const value = parseValue(valueParts.join(" "), key);
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
        "Usage: seamless config oauth-providers <list|add|update|remove>",
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
    console.log(`  ${kleur.bold(provider.id)}  ${kleur.dim(name)}  ${status}`);
  }
}

async function oauthProvidersAdd(
  client: AuthClient,
  rest: string[],
): Promise<void> {
  const { value: file, rest: positional } = extractFlag(rest, "file");
  const input = readProviderInput(
    file,
    positional.filter((arg) => !arg.startsWith("--")).join(" "),
  );

  const provider = await createOAuthProvider(client, input);
  console.log(kleur.green(`Added OAuth provider: ${String(provider.id ?? "")}`));
}

async function oauthProvidersUpdate(
  client: AuthClient,
  rest: string[],
): Promise<void> {
  const { value: file, rest: positional } = extractFlag(rest, "file");
  const nonFlag = positional.filter((arg) => !arg.startsWith("--"));
  const id = nonFlag[0];
  if (!id) {
    console.error(
      kleur.red(
        "Usage: seamless config oauth-providers update <id> <json|--file <path>>",
      ),
    );
    process.exit(1);
  }

  const updates = readProviderInput(file, nonFlag.slice(1).join(" "));
  // The id is immutable and comes from the path; the API rejects it in the body.
  delete updates.id;

  const provider = await updateOAuthProvider(client, id, updates);
  console.log(kleur.green(`Updated OAuth provider: ${String(provider.id ?? id)}`));
}

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
