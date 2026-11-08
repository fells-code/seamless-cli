import {
  CreateAuditSinkRequestSchema,
  UpdateAuditSinkRequestSchema,
} from "@seamless-auth/types";
import kleur from "kleur";
import { extractFlag, extractRepeatedFlag, extractSwitch } from "../core/args.js";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  createAuditSink,
  deleteAuditSink,
  getAuditSink,
  listAuditSinks,
  testAuditSink,
  updateAuditSink,
  type AdminAuditSink,
} from "../core/admin.js";
import { confirmDestructive, hasForceFlag } from "../core/confirmAction.js";
import {
  fail,
  idArg,
  positionals,
  reportAdminError,
  reportTestResult,
  validate,
} from "./adminShared.js";

const USAGE = "Usage: seamless audit-sinks <list|get|create|update|delete|test>";

const KINDS = ["otlp", "syslog"] as const;

export async function runAuditSinks(args: string[]): Promise<void> {
  const sub = args[0];
  const { value: profileFlag, rest } = extractFlag(args.slice(1), "profile");

  try {
    const client = await createAuthClient({ profileFlag });
    switch (sub) {
      case "list":
        await sinksList(client, rest);
        return;
      case "get":
        await sinksGet(client, rest);
        return;
      case "create":
        await sinksCreate(client, rest);
        return;
      case "update":
        await sinksUpdate(client, rest);
        return;
      case "delete":
        await sinksDelete(client, rest);
        return;
      case "test":
        await sinksTest(client, rest);
        return;
      default:
        console.error(kleur.red(`Unknown audit-sinks subcommand: ${sub ?? "(none)"}`));
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    reportAdminError(err);
  }
}

function wholeNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) fail(`--${flag} must be a whole number.`);
  return number;
}

// Each flag maps to one settings field, set only when given, so an update
// changes nothing it was not told to.
const STRING_SETTINGS = {
  endpoint: "endpoint",
  "service-name": "serviceName",
  host: "host",
  transport: "transport",
  "app-name": "appName",
  "tls-ca-env": "tlsCaEnv",
  "tls-client-cert-env": "tlsClientCertEnv",
  "tls-client-key-env": "tlsClientKeyEnv",
} as const;

const NUMBER_SETTINGS = { port: "port", facility: "facility" } as const;

interface SettingsFlags {
  kind?: string;
  settings: Record<string, unknown>;
  rest: string[];
}

function readSettings(args: string[]): SettingsFlags {
  const settings: Record<string, unknown> = {};
  const kindFlag = extractFlag(args, "kind");
  let rest = kindFlag.rest;

  if (kindFlag.value !== undefined && !(KINDS as readonly string[]).includes(kindFlag.value)) {
    fail(`--kind is otlp or syslog, not ${kindFlag.value}.`);
  }

  for (const [flag, field] of Object.entries(STRING_SETTINGS)) {
    const extracted = extractFlag(rest, flag);
    if (extracted.value !== undefined) settings[field] = extracted.value;
    rest = extracted.rest;
  }
  for (const [flag, field] of Object.entries(NUMBER_SETTINGS)) {
    const extracted = extractFlag(rest, flag);
    const value = wholeNumber(extracted.value, flag);
    if (value !== undefined) settings[field] = value;
    rest = extracted.rest;
  }

  const headers = extractRepeatedFlag(rest, "header");
  rest = headers.rest;
  if (headers.values.length > 0) {
    const headersFromEnv: Record<string, string> = {};
    for (const pair of headers.values) {
      const split = pair.indexOf("=");
      if (split <= 0 || split === pair.length - 1) {
        fail(`--header takes Name=ENV_VAR, such as DD-API-KEY=DD_AUDIT_SINK_SECRET, not ${pair}.`);
      }
      headersFromEnv[pair.slice(0, split)] = pair.slice(split + 1);
    }
    settings.headersFromEnv = headersFromEnv;
  }

  return { kind: kindFlag.value, settings, rest };
}

function destination(sink: AdminAuditSink): string {
  const settings = sink.settings as Record<string, unknown>;
  if (settings.kind === "otlp") return `otlp ${String(settings.endpoint)}`;
  if (settings.kind === "syslog") {
    return `syslog ${String(settings.host)}:${String(settings.port)} (${String(settings.transport)})`;
  }
  return String(settings.kind);
}

function printSink(sink: AdminAuditSink): void {
  const state = sink.enabled ? kleur.green("enabled") : kleur.yellow("disabled");
  console.log(`${kleur.bold(sink.name)}  ${state}  ${kleur.dim(sink.id)}`);
  console.log(`  to:      ${destination(sink)}`);
  const { status } = sink;
  const behind =
    status.lagEvents === null ? "unknown" : `${status.lagEvents} event${status.lagEvents === 1 ? "" : "s"}`;
  console.log(
    `  behind:  ${behind}` +
      (status.lastDeliveredAt ? kleur.dim(`, last delivered ${status.lastDeliveredAt}`) : ""),
  );
  if (status.lastFailure) {
    console.log(
      kleur.yellow(
        `  failing: ${status.lastFailure}${status.lastFailureAt ? ` at ${status.lastFailureAt}` : ""}`,
      ),
    );
  }
}

function printJsonOr(rest: string[], sink: AdminAuditSink, message: string): void {
  if (rest.includes("--json")) {
    console.log(JSON.stringify(sink, null, 2));
    return;
  }
  console.log(kleur.green(message));
  printSink(sink);
}

async function sinksList(client: AuthClient, rest: string[]): Promise<void> {
  const sinks = await listAuditSinks(client);

  if (rest.includes("--json")) {
    console.log(JSON.stringify(sinks, null, 2));
    return;
  }
  if (sinks.length === 0) {
    console.log(kleur.dim("No audit sinks."));
    return;
  }
  for (const sink of sinks) printSink(sink);
}

async function sinksGet(client: AuthClient, rest: string[]): Promise<void> {
  const id = idArg(rest, "Usage: seamless audit-sinks get <id> [--json]", "audit sink");
  const sink = await getAuditSink(client, id);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(sink, null, 2));
    return;
  }
  printSink(sink);
}

async function sinksCreate(client: AuthClient, args: string[]): Promise<void> {
  const startAfter = extractFlag(args, "start-after-seq");
  const { kind, settings, rest } = readSettings(startAfter.rest);
  const name = positionals(rest)[0];
  if (!name || !kind) {
    fail(
      "Usage: seamless audit-sinks create <name> --kind otlp|syslog [settings] (see seamless audit-sinks --help)",
    );
  }

  const startAfterSeq = wholeNumber(startAfter.value, "start-after-seq");
  const body = validate(CreateAuditSinkRequestSchema, {
    name,
    settings: { ...settings, kind },
    enabled: !rest.includes("--disabled"),
    ...(startAfterSeq !== undefined ? { startAfterSeq } : {}),
  });

  const sink = await createAuditSink(client, body);
  printJsonOr(rest, sink, `Created audit sink ${sink.name}.`);
}

// Settings are replaced whole by the API, so flags are laid over the sink's
// current settings. Changing --kind starts from nothing, since the two kinds
// share no fields.
async function sinksUpdate(client: AuthClient, args: string[]): Promise<void> {
  const nameFlag = extractFlag(args, "name");
  const enabled = extractSwitch(nameFlag.rest, "enable", "disable");
  const { kind, settings, rest } = readSettings(enabled.rest);
  const id = idArg(
    rest,
    "Usage: seamless audit-sinks update <id> [--name <name>] [--enable | --disable] [settings] [--json]",
    "audit sink",
  );

  const changes: Record<string, unknown> = {
    ...(nameFlag.value !== undefined ? { name: nameFlag.value } : {}),
    ...(enabled.value !== undefined ? { enabled: enabled.value } : {}),
  };
  if (kind !== undefined || Object.keys(settings).length > 0) {
    const current = await getAuditSink(client, id);
    const currentKind = String((current.settings as Record<string, unknown>).kind);
    const base = kind === undefined || kind === currentKind ? current.settings : {};
    changes.settings = { ...base, ...settings, kind: kind ?? currentKind };
  }
  if (Object.keys(changes).length === 0) {
    fail("Nothing to update. Pass --name, --enable, --disable or a setting.");
  }

  const body = validate(UpdateAuditSinkRequestSchema, changes);
  const sink = await updateAuditSink(client, id, body);
  printJsonOr(rest, sink, `Updated audit sink ${sink.name}.`);
}

async function sinksDelete(client: AuthClient, rest: string[]): Promise<void> {
  const id = idArg(rest, "Usage: seamless audit-sinks delete <id> [--force]", "audit sink");

  const confirmed = await confirmDestructive({
    message: `Delete audit sink ${id}? Its cursor goes with it, and events stop streaming there.`,
    force: hasForceFlag(rest),
  });
  if (!confirmed) {
    console.log(kleur.dim("Cancelled."));
    return;
  }

  await deleteAuditSink(client, id);
  console.log(kleur.green(`Deleted audit sink ${id}.`));
}

async function sinksTest(client: AuthClient, rest: string[]): Promise<void> {
  const id = idArg(rest, "Usage: seamless audit-sinks test <id> [--json]", "audit sink");
  const result = await testAuditSink(client, id);
  reportTestResult(result, rest.includes("--json"), "Test record");
}
