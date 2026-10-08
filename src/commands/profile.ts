import { intro, outro, text, isCancel, cancel } from "@clack/prompts";
import { IdentifierTypeSchema } from "@seamless-auth/types";
import kleur from "kleur";
import { extractFlag } from "../core/args.js";
import {
  assertUsableProfileName,
  DEFAULT_PROFILE_NAME,
  loadConfig,
  normalizeInstanceUrl,
  removeProfile,
  resolveActiveProfileName,
  setActiveProfile,
  upsertProfile,
} from "../core/config.js";
import { deleteTokens, KeychainUnavailableError } from "../core/keychain.js";
import { loginToInstance } from "./instanceLogin.js";
import { requireInteractive } from "../core/tty.js";

export async function runProfile(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "list":
      profileList();
      return;
    case "add":
      await profileAdd(rest);
      return;
    case "use":
      profileUse(rest);
      return;
    case "remove":
      await profileRemove(rest);
      return;
    case "login":
      await profileLogin(rest);
      return;
    default:
      console.error(
        kleur.red(`Unknown profile subcommand: ${sub ?? "(none)"}`),
      );
      console.log("Usage: seamless profile <list|add|use|remove|login>");
      process.exit(1);
  }
}

function profileList(): void {
  const config = loadConfig();
  const active = resolveActiveProfileName({}, config);
  const names = Object.keys(config.profiles);

  if (names.length === 0) {
    console.log(kleur.dim("No profiles yet. Add one with:"));
    console.log(kleur.cyan("  seamless profile add <name> --instance-url <url>"));
    return;
  }

  for (const name of names) {
    const profile = config.profiles[name];
    const marker = name === active ? kleur.green("* ") : "  ";
    const email = profile.email ? kleur.dim(` (${profile.email})`) : "";
    console.log(
      marker + kleur.bold(name) + kleur.dim(`  ${profile.instanceUrl}`) + email,
    );
  }
}

async function profileAdd(rest: string[]): Promise<void> {
  const urlFlag = extractFlag(rest, "instance-url");
  const typeFlag = extractFlag(urlFlag.rest, "identifier-type");
  let name = typeFlag.rest[0];
  let instanceUrl = urlFlag.value;

  const parsedType = IdentifierTypeSchema.safeParse(typeFlag.value ?? "email");
  if (!parsedType.success) {
    console.error(
      kleur.red(`Invalid --identifier-type "${typeFlag.value}". Use email or phone.`),
    );
    process.exit(1);
  }
  const identifierType = parsedType.data;

  intro("Add a Seamless profile");

  if (!name) {
    requireInteractive(
      "Profile name",
      "Pass the name positionally: seamless profile add <name> --instance-url <url>.",
    );
    const answer = await text({
      message: "Profile name",
      placeholder: DEFAULT_PROFILE_NAME,
      defaultValue: DEFAULT_PROFILE_NAME,
    });
    if (isCancel(answer)) {
      cancel("Cancelled.");
      return;
    }
    name = (answer as string) || DEFAULT_PROFILE_NAME;
  }

  try {
    assertUsableProfileName(name);
  } catch (err) {
    outro(kleur.red((err as Error).message));
    process.exit(1);
  }

  if (!instanceUrl) {
    requireInteractive(
      "Instance URL",
      "Pass --instance-url <url>.",
    );
    const answer = await text({
      message: "Instance URL",
      placeholder: "https://auth.example.com",
      validate: (value) => {
        if (!value) return "Instance URL is required";
        try {
          normalizeInstanceUrl(value);
        } catch (err) {
          return (err as Error).message;
        }
      },
    });
    if (isCancel(answer)) {
      cancel("Cancelled.");
      return;
    }
    instanceUrl = answer as string;
  }

  let normalized: string;
  try {
    normalized = normalizeInstanceUrl(instanceUrl);
  } catch (err) {
    outro(kleur.red((err as Error).message));
    process.exit(1);
  }

  const existing = loadConfig().profiles[name];
  upsertProfile({
    name,
    instanceUrl: normalized,
    identifierType,
    sub: existing?.sub,
    email: existing?.email,
  });

  outro(kleur.green(`Profile "${name}" saved (${normalized})`));
}

// Signs in to a profile's instance without switching the active profile, so a
// one-off admin command against another instance does not disturb the default.
async function profileLogin(rest: string[]): Promise<void> {
  const local = rest.includes("--local");
  const withoutLocal = rest.filter((a) => a !== "--local");
  const idFlag = extractFlag(withoutLocal, "identifier");
  const positional = idFlag.rest.filter((a) => !a.startsWith("-"));

  await loginToInstance({
    profileName: positional[0],
    identifier: idFlag.value ?? positional[1],
    local,
  });
}

function profileUse(rest: string[]): void {
  const name = rest[0];
  if (!name) {
    console.error(kleur.red("Usage: seamless profile use <name>"));
    process.exit(1);
  }

  try {
    setActiveProfile(name);
  } catch (err) {
    console.error(kleur.red((err as Error).message));
    process.exit(1);
  }

  console.log(kleur.green(`Active profile set to "${name}".`));
}

async function profileRemove(rest: string[]): Promise<void> {
  const name = rest[0];
  if (!name) {
    console.error(kleur.red("Usage: seamless profile remove <name>"));
    process.exit(1);
  }

  const profile = loadConfig().profiles[name];

  try {
    removeProfile(name);
  } catch (err) {
    console.error(kleur.red((err as Error).message));
    process.exit(1);
  }

  if (profile) {
    try {
      await deleteTokens(profile);
    } catch (err) {
      if (err instanceof KeychainUnavailableError) {
        console.log(
          kleur.dim("No keychain available; no stored tokens to clear."),
        );
      } else {
        console.log(
          kleur.yellow(`Could not clear stored tokens: ${(err as Error).message}`),
        );
      }
    }
  }

  console.log(kleur.green(`Profile "${name}" removed.`));
}
