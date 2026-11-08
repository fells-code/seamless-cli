import { readFile } from "node:fs/promises";
import {
  CUSTOM_CLAIM_NAME_PATTERN,
  CustomClaimSourceKindSchema,
  SetCustomClaimsRequestSchema,
  isReservedClaimName,
  type CustomClaimSourceKind,
} from "@seamless-auth/types";
import kleur from "kleur";
import { extractFlag } from "../core/args.js";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  deleteCustomClaims,
  getCustomClaims,
  listCustomClaims,
  setCustomClaims,
  type AdminClaimSource,
} from "../core/admin.js";
import { confirmDestructive, hasForceFlag } from "../core/confirmAction.js";
import { fail, positionals, reportAdminError, validate } from "./adminShared.js";

const USAGE = "Usage: seamless claims <list|get|set|delete>";

const KINDS = CustomClaimSourceKindSchema.options.join("|");

export async function runClaims(args: string[]): Promise<void> {
  const sub = args[0];
  const { value: profileFlag, rest } = extractFlag(args.slice(1), "profile");

  try {
    const client = await createAuthClient({ profileFlag });
    switch (sub) {
      case "list":
        await claimsList(client, rest);
        return;
      case "get":
        await claimsGet(client, rest);
        return;
      case "set":
        await claimsSet(client, rest);
        return;
      case "delete":
        await claimsDelete(client, rest);
        return;
      default:
        console.error(kleur.red(`Unknown claims subcommand: ${sub ?? "(none)"}`));
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    reportAdminError(err);
  }
}

function sourceArgs(
  rest: string[],
  usage: string,
): { kind: CustomClaimSourceKind; name: string; extra: string[] } {
  const [kindArg, name, ...extra] = positionals(rest);
  if (!kindArg || !name) fail(usage);
  const kind = CustomClaimSourceKindSchema.safeParse(kindArg);
  if (!kind.success) {
    fail(`The source kind is one of ${CustomClaimSourceKindSchema.options.join(", ")}, not ${kindArg}.`);
  }
  return { kind: kind.data, name, extra };
}

function printSource(source: AdminClaimSource): void {
  console.log(`${kleur.bold(`${source.sourceKind} ${source.sourceName}`)}  ${kleur.dim(source.updatedAt)}`);
  for (const [name, value] of Object.entries(source.claims)) {
    console.log(`  ${name}: ${JSON.stringify(value)}`);
  }
}

async function claimsList(client: AuthClient, rest: string[]): Promise<void> {
  const list = await listCustomClaims(client);

  if (rest.includes("--json")) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.sources.length === 0) {
    console.log(kleur.dim("No custom claims."));
  }
  for (const source of list.sources) printSource(source);
  console.log(
    kleur.dim(
      `Token budget: ${list.budgetBytes} bytes, shared with permissions and organization roles.`,
    ),
  );
}

async function claimsGet(client: AuthClient, rest: string[]): Promise<void> {
  const { kind, name } = sourceArgs(rest, `Usage: seamless claims get <${KINDS}> <name> [--json]`);
  const source = await getCustomClaims(client, kind, name);
  if (!source) fail(`No custom claims are set for ${kind} ${name}.`);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(source, null, 2));
    return;
  }
  printSource(source);
}

async function readClaims(inline: string | undefined, file: string | undefined): Promise<unknown> {
  let text = inline;
  const from = file ?? "the claims argument";
  if (file !== undefined) {
    try {
      text = await readFile(file, "utf8");
    } catch {
      fail(`Could not read ${file}.`);
    }
  }
  try {
    return JSON.parse(text ?? "");
  } catch {
    fail(`${from} is not valid JSON.`);
  }
}

// The schema's own messages for a bad name are the raw pattern, so names are
// checked here first and the rest (depth, size) is left to the schema.
function checkClaims(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail('Claims are a JSON object of names to values, such as {"tier":"gold"}.');
  }
  const claims = value as Record<string, unknown>;
  for (const name of Object.keys(claims)) {
    if (!CUSTOM_CLAIM_NAME_PATTERN.test(name)) {
      fail(
        `${name} is not a valid claim name. Use lower case letters, digits and underscores, starting with a letter, up to 64 characters.`,
      );
    }
    if (isReservedClaimName(name)) {
      fail(`${name} is a reserved claim name. Seamless or the token standards set it.`);
    }
  }
  return validate(SetCustomClaimsRequestSchema, { claims }).claims;
}

// The API replaces the whole set, so a claim left off disappears from every
// holder's next token. As with roles set, what is about to go is named first.
async function claimsSet(client: AuthClient, args: string[]): Promise<void> {
  const usage = `Usage: seamless claims set <${KINDS}> <name> (<json> | --file <path>) [--force] [--json]`;
  const file = extractFlag(args, "file");
  const rest = file.rest;
  const { kind, name, extra } = sourceArgs(rest, usage);
  const inline = extra[0];
  if ((inline === undefined) === (file.value === undefined)) {
    fail(`${usage}\nGive the claims inline or with --file, not both.`);
  }

  const claims = checkClaims(await readClaims(inline, file.value));

  const current = await getCustomClaims(client, kind, name);
  const removed = current ? Object.keys(current.claims).filter((key) => !(key in claims)) : [];
  if (removed.length > 0) {
    const confirmed = await confirmDestructive({
      message: `Remove ${removed.join(", ")} from ${kind} ${name}? Holders lose ${removed.length === 1 ? "it" : "them"} on their next access token.`,
      force: hasForceFlag(rest),
    });
    if (!confirmed) {
      console.log(kleur.dim("Cancelled."));
      return;
    }
  }

  const source = await setCustomClaims(client, kind, name, claims);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(source, null, 2));
    return;
  }
  console.log(kleur.green(`Set the custom claims of ${kind} ${name}.`));
  printSource(source);
}

async function claimsDelete(client: AuthClient, rest: string[]): Promise<void> {
  const { kind, name } = sourceArgs(rest, `Usage: seamless claims delete <${KINDS}> <name> [--force]`);

  const confirmed = await confirmDestructive({
    message: `Delete every custom claim of ${kind} ${name}? Holders lose them on their next access token.`,
    force: hasForceFlag(rest),
  });
  if (!confirmed) {
    console.log(kleur.dim("Cancelled."));
    return;
  }

  await deleteCustomClaims(client, kind, name);
  console.log(kleur.green(`Deleted the custom claims of ${kind} ${name}.`));
}
