import {
  LOGIN_HOOK_MAX_TIMEOUT_MS,
  LOGIN_HOOK_MIN_TIMEOUT_MS,
  LoginHookFailureModeSchema,
  LoginHookOutcomeSchema,
  LoginHookTriggerSchema,
  SetLoginHookRequestSchema,
  type LoginHookTrigger,
} from "@seamless-auth/types";
import kleur from "kleur";
import { extractFlag, extractSwitch } from "../core/args.js";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  deleteLoginHook,
  listLoginHookInvocations,
  listLoginHooks,
  rotateLoginHookSecret,
  setLoginHook,
  testLoginHook,
  type AdminInvocation,
  type AdminLoginHook,
} from "../core/admin.js";
import { confirmDestructive, hasForceFlag } from "../core/confirmAction.js";
import {
  fail,
  parseLimit,
  positionals,
  printSigningSecret,
  reportAdminError,
  reportTestResult,
  validate,
} from "./adminShared.js";

const USAGE = "Usage: seamless hooks <list|get|set|delete|rotate-secret|test|invocations>";

const FAIL_CLOSED_NOTE =
  "This hook fails closed: while it is down, slow or answers badly, sign-ins it runs on fail. Break-glass sign-in and recovery never call a hook.";

export async function runHooks(args: string[]): Promise<void> {
  const sub = args[0];
  const { value: profileFlag, rest } = extractFlag(args.slice(1), "profile");

  try {
    const client = await createAuthClient({ profileFlag });
    switch (sub) {
      case "list":
        await hooksList(client, rest);
        return;
      case "get":
        await hooksGet(client, rest);
        return;
      case "set":
        await hooksSet(client, rest);
        return;
      case "delete":
        await hooksDelete(client, rest);
        return;
      case "rotate-secret":
        await hooksRotateSecret(client, rest);
        return;
      case "test":
        await hooksTest(client, rest);
        return;
      case "invocations":
        await hooksInvocations(client, rest);
        return;
      default:
        console.error(kleur.red(`Unknown hooks subcommand: ${sub ?? "(none)"}`));
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    reportAdminError(err);
  }
}

function triggerArg(rest: string[], usage: string): LoginHookTrigger {
  const value = positionals(rest)[0];
  if (!value) fail(usage);
  const trigger = LoginHookTriggerSchema.safeParse(value);
  if (!trigger.success) {
    fail(`The trigger is ${LoginHookTriggerSchema.options.join(" or ")}, not ${value}.`);
  }
  return trigger.data;
}

async function findHook(
  client: AuthClient,
  trigger: LoginHookTrigger,
): Promise<AdminLoginHook | undefined> {
  return (await listLoginHooks(client)).find((hook) => hook.trigger === trigger);
}

function printHook(hook: AdminLoginHook): void {
  const state = hook.enabled ? kleur.green("enabled") : kleur.yellow("disabled");
  console.log(`${kleur.bold(hook.trigger)}  ${state}`);
  console.log(`  url:      ${hook.url}`);
  console.log(`  timeout:  ${hook.timeoutMs} ms, fails ${hook.failureMode}`);
  if (hook.previousSecretExpiresAt) {
    console.log(kleur.dim(`  the previous secret signs too until ${hook.previousSecretExpiresAt}`));
  }
}

async function hooksList(client: AuthClient, rest: string[]): Promise<void> {
  const hooks = await listLoginHooks(client);

  if (rest.includes("--json")) {
    console.log(JSON.stringify(hooks, null, 2));
    return;
  }
  if (hooks.length === 0) {
    console.log(kleur.dim("No login hooks."));
    return;
  }
  for (const hook of hooks) printHook(hook);
}

async function hooksGet(client: AuthClient, rest: string[]): Promise<void> {
  const trigger = triggerArg(rest, "Usage: seamless hooks get <post_login|pre_token> [--json]");
  const hook = await findHook(client, trigger);
  if (!hook) fail(`No ${trigger} hook is set.`);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(hook, null, 2));
    return;
  }
  printHook(hook);
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < LOGIN_HOOK_MIN_TIMEOUT_MS || ms > LOGIN_HOOK_MAX_TIMEOUT_MS) {
    fail(
      `--timeout is a whole number of milliseconds between ${LOGIN_HOOK_MIN_TIMEOUT_MS} and ${LOGIN_HOOK_MAX_TIMEOUT_MS}.`,
    );
  }
  return ms;
}

// The API replaces a hook's settings whole, filling defaults for anything left out.
// Starting from the current hook means a flag changes only what it names, so
// `hooks set pre_token --disable` does not also reset the timeout.
async function hooksSet(client: AuthClient, args: string[]): Promise<void> {
  const usage =
    "Usage: seamless hooks set <post_login|pre_token> [--url <url>] [--timeout <ms>] [--failure-mode open|closed] [--enable | --disable] [--json]";
  const url = extractFlag(args, "url");
  const timeout = extractFlag(url.rest, "timeout");
  const mode = extractFlag(timeout.rest, "failure-mode");
  const enabled = extractSwitch(mode.rest, "enable", "disable");
  const rest = enabled.rest;
  const trigger = triggerArg(rest, usage);

  const timeoutMs = parseTimeout(timeout.value);
  if (mode.value !== undefined && !LoginHookFailureModeSchema.safeParse(mode.value).success) {
    fail(`--failure-mode is open or closed, not ${mode.value}.`);
  }

  const current = await findHook(client, trigger);
  if (!current && url.value === undefined) {
    fail(`No ${trigger} hook is set yet. Pass --url to create one.`);
  }
  if (
    current &&
    [url.value, timeoutMs, mode.value, enabled.value].every((value) => value === undefined)
  ) {
    fail("Nothing to change. Pass --url, --timeout, --failure-mode, --enable or --disable.");
  }

  const body = validate(SetLoginHookRequestSchema, {
    url: url.value ?? current?.url,
    timeoutMs: timeoutMs ?? current?.timeoutMs,
    failureMode: mode.value ?? current?.failureMode,
    enabled: enabled.value ?? current?.enabled,
  });

  const result = await setLoginHook(client, trigger, body);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(kleur.green(`${current ? "Updated" : "Created"} the ${trigger} hook.`));
  printHook(result.hook);
  if (result.hook.failureMode === "closed" && (!current || current.failureMode !== "closed")) {
    console.log(kleur.yellow(FAIL_CLOSED_NOTE));
  }
  if (result.secret) printSigningSecret(result.secret);
}

async function hooksDelete(client: AuthClient, rest: string[]): Promise<void> {
  const trigger = triggerArg(rest, "Usage: seamless hooks delete <post_login|pre_token> [--force]");

  const confirmed = await confirmDestructive({
    message: `Delete the ${trigger} hook and its signing secret? Setting it again issues a new secret.`,
    force: hasForceFlag(rest),
  });
  if (!confirmed) {
    console.log(kleur.dim("Cancelled."));
    return;
  }

  await deleteLoginHook(client, trigger);
  console.log(kleur.green(`Deleted the ${trigger} hook.`));
}

// As for webhooks: only a second rotation inside the overlap breaks a receiver.
async function hooksRotateSecret(client: AuthClient, rest: string[]): Promise<void> {
  const trigger = triggerArg(
    rest,
    "Usage: seamless hooks rotate-secret <post_login|pre_token> [--force] [--json]",
  );

  const current = await findHook(client, trigger);
  if (!current) fail(`No ${trigger} hook is set.`);
  if (current.previousSecretExpiresAt) {
    const confirmed = await confirmDestructive({
      message: `The ${trigger} hook is still rotating: its previous secret signs until ${current.previousSecretExpiresAt}. Rotate again and stop that secret now? A hook service still verifying with it starts failing.`,
      force: hasForceFlag(rest),
    });
    if (!confirmed) {
      console.log(kleur.dim("Cancelled."));
      return;
    }
  }

  const rotated = await rotateLoginHookSecret(client, trigger);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(rotated, null, 2));
    return;
  }
  console.log(kleur.green(`Issued a new signing secret for the ${trigger} hook.`));
  printSigningSecret(rotated.secret);
  console.log(
    kleur.dim(`The previous secret signs beside it until ${rotated.previousSecretExpiresAt}.`),
  );
}

async function hooksTest(client: AuthClient, rest: string[]): Promise<void> {
  const trigger = triggerArg(rest, "Usage: seamless hooks test <post_login|pre_token> [--json]");
  const result = await testLoginHook(client, trigger);
  reportTestResult(result, rest.includes("--json"), "Test call");
}

function printInvocation(invocation: AdminInvocation): void {
  const color =
    invocation.outcome === "allowed"
      ? kleur.green
      : invocation.outcome === "failed_open"
        ? kleur.yellow
        : kleur.red;
  const detail = [
    invocation.statusCode !== null ? String(invocation.statusCode) : undefined,
    invocation.failure ?? undefined,
    `${invocation.durationMs} ms`,
  ].filter(Boolean);
  console.log(
    `${kleur.dim(invocation.createdAt)}  ${color(invocation.outcome)}  ${invocation.userId ?? kleur.dim("no user")}  ${kleur.dim(detail.join(", "))}`,
  );
}

async function hooksInvocations(client: AuthClient, args: string[]): Promise<void> {
  const outcome = extractFlag(args, "outcome");
  const { limit, rest } = parseLimit(outcome.rest);
  const trigger = triggerArg(
    rest,
    "Usage: seamless hooks invocations <post_login|pre_token> [--outcome <outcome>] [--limit <n>] [--json]",
  );
  const parsedOutcome =
    outcome.value === undefined ? undefined : LoginHookOutcomeSchema.safeParse(outcome.value);
  if (parsedOutcome && !parsedOutcome.success) {
    fail(`--outcome is one of ${LoginHookOutcomeSchema.options.join(", ")}, not ${outcome.value}.`);
  }

  const invocations = await listLoginHookInvocations(client, trigger, {
    limit,
    outcome: parsedOutcome?.data,
  });

  if (rest.includes("--json")) {
    console.log(JSON.stringify(invocations, null, 2));
    return;
  }
  if (invocations.length === 0) {
    console.log(kleur.dim(`No ${trigger} invocations.`));
    return;
  }
  for (const invocation of invocations) printInvocation(invocation);
}
