import {
  CreateWebhookEndpointRequestSchema,
  UpdateWebhookEndpointRequestSchema,
  WEBHOOK_EVENT_TYPES,
  WebhookDeliveryStatusSchema,
  WebhookEventTypeSchema,
  type WebhookEventType,
} from "@seamless-auth/types";
import kleur from "kleur";
import { extractFlag } from "../core/args.js";
import { createAuthClient, type AuthClient } from "../core/authClient.js";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  getWebhookDelivery,
  listWebhookDeliveries,
  listWebhooks,
  redeliverWebhook,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
  type AdminDelivery,
  type AdminDeliveryDetail,
  type AdminWebhook,
} from "../core/admin.js";
import { confirmDestructive, hasForceFlag } from "../core/confirmAction.js";
import {
  fail,
  idArg,
  parseLimit,
  parseList,
  positionals,
  printSigningSecret,
  reportAdminError,
  reportTestResult,
  validate,
} from "./adminShared.js";

const USAGE =
  "Usage: seamless webhooks <list|get|create|update|enable|disable|delete|rotate-secret|test|deliveries|delivery|redeliver>";

export async function runWebhooks(args: string[]): Promise<void> {
  const sub = args[0];
  const { value: profileFlag, rest } = extractFlag(args.slice(1), "profile");

  try {
    const client = await createAuthClient({ profileFlag });
    switch (sub) {
      case "list":
        await webhooksList(client, rest);
        return;
      case "get":
        await webhooksGet(client, rest);
        return;
      case "create":
        await webhooksCreate(client, rest);
        return;
      case "update":
        await webhooksUpdate(client, rest);
        return;
      case "enable":
      case "disable":
        await webhooksSetEnabled(client, rest, sub === "enable");
        return;
      case "delete":
        await webhooksDelete(client, rest);
        return;
      case "rotate-secret":
        await webhooksRotateSecret(client, rest);
        return;
      case "test":
        await webhooksTest(client, rest);
        return;
      case "deliveries":
        await webhooksDeliveries(client, rest);
        return;
      case "delivery":
        await webhooksDelivery(client, rest);
        return;
      case "redeliver":
        await webhooksRedeliver(client, rest);
        return;
      default:
        console.error(kleur.red(`Unknown webhooks subcommand: ${sub ?? "(none)"}`));
        console.log(USAGE);
        process.exit(1);
    }
  } catch (err) {
    reportAdminError(err);
  }
}

function parseEvents(value: string): WebhookEventType[] {
  const events = parseList(value) ?? [];
  if (events.length === 0) fail("--events needs at least one event type.");
  for (const event of events) {
    if (!WebhookEventTypeSchema.safeParse(event).success) {
      fail(`${event} is not a webhook event type. Use one of: ${WEBHOOK_EVENT_TYPES.join(", ")}.`);
    }
  }
  return [...new Set(events)] as WebhookEventType[];
}

function printWebhook(endpoint: AdminWebhook): void {
  const state = endpoint.enabled
    ? kleur.green("enabled")
    : kleur.yellow(`disabled${endpoint.disabledReason ? ` (${endpoint.disabledReason})` : ""}`);
  console.log(`${kleur.bold(endpoint.id)}  ${state}`);
  console.log(`  url:     ${endpoint.url}`);
  console.log(`  events:  ${endpoint.eventTypes.join(", ")}`);
  if (endpoint.description) console.log(`  about:   ${endpoint.description}`);
  if (endpoint.previousSecretExpiresAt) {
    console.log(kleur.dim(`  the previous secret signs too until ${endpoint.previousSecretExpiresAt}`));
  }
}

function printJsonOr(rest: string[], endpoint: AdminWebhook, message: string): void {
  if (rest.includes("--json")) {
    console.log(JSON.stringify(endpoint, null, 2));
    return;
  }
  console.log(kleur.green(message));
  printWebhook(endpoint);
}

async function webhooksList(client: AuthClient, rest: string[]): Promise<void> {
  const endpoints = await listWebhooks(client);

  if (rest.includes("--json")) {
    console.log(JSON.stringify(endpoints, null, 2));
    return;
  }
  if (endpoints.length === 0) {
    console.log(kleur.dim("No webhooks."));
    return;
  }
  for (const endpoint of endpoints) printWebhook(endpoint);
}

async function webhooksGet(client: AuthClient, rest: string[]): Promise<void> {
  const id = idArg(rest, "Usage: seamless webhooks get <id> [--json]", "webhook");
  const endpoint = await getWebhook(client, id);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(endpoint, null, 2));
    return;
  }
  printWebhook(endpoint);
}

async function webhooksCreate(client: AuthClient, args: string[]): Promise<void> {
  const usage =
    "Usage: seamless webhooks create <url> --events <type,...> [--description <text>] [--disabled] [--json]";
  const events = extractFlag(args, "events");
  const description = extractFlag(events.rest, "description");
  const rest = description.rest;
  const url = positionals(rest)[0];
  if (!url) fail(usage);
  if (events.value === undefined) {
    fail(`Name the events to send with --events. One or more of: ${WEBHOOK_EVENT_TYPES.join(", ")}.`);
  }

  const body = validate(CreateWebhookEndpointRequestSchema, {
    url,
    eventTypes: parseEvents(events.value),
    ...(description.value !== undefined ? { description: description.value } : {}),
    ...(rest.includes("--disabled") ? { enabled: false } : {}),
  });

  const created = await createWebhook(client, body);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(created, null, 2));
    return;
  }
  console.log(kleur.green(`Created webhook ${created.endpoint.id}.`));
  printWebhook(created.endpoint);
  printSigningSecret(created.secret);
}

async function webhooksUpdate(client: AuthClient, args: string[]): Promise<void> {
  const usage =
    "Usage: seamless webhooks update <id> [--url <url>] [--events <type,...>] [--description <text> | --no-description] [--json]";
  const url = extractFlag(args, "url");
  const events = extractFlag(url.rest, "events");
  const description = extractFlag(events.rest, "description");
  const rest = description.rest;
  const clear = rest.includes("--no-description");
  const id = idArg(rest, usage, "webhook");

  if (description.value !== undefined && clear) {
    fail("Pass --description or --no-description, not both.");
  }
  const changes = {
    ...(url.value !== undefined ? { url: url.value } : {}),
    ...(events.value !== undefined ? { eventTypes: parseEvents(events.value) } : {}),
    ...(description.value !== undefined ? { description: description.value } : {}),
    ...(clear ? { description: null } : {}),
  };
  if (Object.keys(changes).length === 0) {
    fail("Nothing to update. Pass --url, --events, --description or --no-description.");
  }

  const body = validate(UpdateWebhookEndpointRequestSchema, changes);
  const endpoint = await updateWebhook(client, id, body);
  printJsonOr(rest, endpoint, `Updated webhook ${endpoint.id}.`);
}

async function webhooksSetEnabled(
  client: AuthClient,
  rest: string[],
  enabled: boolean,
): Promise<void> {
  const verb = enabled ? "enable" : "disable";
  const id = idArg(rest, `Usage: seamless webhooks ${verb} <id> [--json]`, "webhook");
  const endpoint = await updateWebhook(client, id, { enabled });
  printJsonOr(rest, endpoint, `${enabled ? "Enabled" : "Disabled"} webhook ${endpoint.id}.`);
}

async function webhooksDelete(client: AuthClient, rest: string[]): Promise<void> {
  const id = idArg(rest, "Usage: seamless webhooks delete <id> [--force]", "webhook");

  const confirmed = await confirmDestructive({
    message: `Delete webhook ${id} and its delivery history? This cannot be undone.`,
    force: hasForceFlag(rest),
  });
  if (!confirmed) {
    console.log(kleur.dim("Cancelled."));
    return;
  }

  await deleteWebhook(client, id);
  console.log(kleur.green(`Deleted webhook ${id}.`));
}

// The old secret keeps signing for a day, so a rotation breaks nothing on its own.
// Rotating again inside that day drops the older secret at once, which fails any
// receiver still verifying with it, so only that case asks.
async function webhooksRotateSecret(client: AuthClient, rest: string[]): Promise<void> {
  const id = idArg(rest, "Usage: seamless webhooks rotate-secret <id> [--force] [--json]", "webhook");

  const current = await getWebhook(client, id);
  if (current.previousSecretExpiresAt) {
    const confirmed = await confirmDestructive({
      message: `Webhook ${id} is still rotating: its previous secret signs until ${current.previousSecretExpiresAt}. Rotate again and stop that secret now? A receiver still verifying with it starts failing.`,
      force: hasForceFlag(rest),
    });
    if (!confirmed) {
      console.log(kleur.dim("Cancelled."));
      return;
    }
  }

  const rotated = await rotateWebhookSecret(client, id);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(rotated, null, 2));
    return;
  }
  console.log(kleur.green(`Issued a new signing secret for webhook ${id}.`));
  printSigningSecret(rotated.secret);
  console.log(
    kleur.dim(`The previous secret signs beside it until ${rotated.previousSecretExpiresAt}.`),
  );
}

async function webhooksTest(client: AuthClient, rest: string[]): Promise<void> {
  const id = idArg(rest, "Usage: seamless webhooks test <id> [--json]", "webhook");
  const result = await testWebhook(client, id);
  reportTestResult(result, rest.includes("--json"), "Test event");
}

function printDelivery(delivery: AdminDelivery): void {
  const color =
    delivery.status === "succeeded"
      ? kleur.green
      : delivery.status === "pending"
        ? kleur.dim
        : delivery.status === "failed"
          ? kleur.yellow
          : kleur.red;
  const last = [
    delivery.lastStatusCode !== null ? String(delivery.lastStatusCode) : undefined,
    delivery.lastFailure ?? undefined,
  ].filter(Boolean);
  console.log(
    `${kleur.bold(delivery.id)}  ${color(delivery.status)}  ${delivery.eventType}  ${kleur.dim(delivery.createdAt)}`,
  );
  console.log(
    kleur.dim(
      `  endpoint ${delivery.endpointId}, ${delivery.attempts} attempt${delivery.attempts === 1 ? "" : "s"}` +
        (last.length ? `, last ${last.join(" ")}` : "") +
        (delivery.nextAttemptAt ? `, next ${delivery.nextAttemptAt}` : ""),
    ),
  );
}

async function webhooksDeliveries(client: AuthClient, args: string[]): Promise<void> {
  const endpoint = extractFlag(args, "endpoint");
  const status = extractFlag(endpoint.rest, "status");
  const event = extractFlag(status.rest, "event");
  const cursor = extractFlag(event.rest, "cursor");
  const { limit, rest } = parseLimit(cursor.rest);

  if (endpoint.value !== undefined) {
    idArg([endpoint.value], "--endpoint needs a webhook id.", "webhook");
  }
  if (status.value !== undefined && !WebhookDeliveryStatusSchema.safeParse(status.value).success) {
    fail(`--status is one of ${WebhookDeliveryStatusSchema.options.join(", ")}, not ${status.value}.`);
  }
  if (event.value !== undefined && !WebhookEventTypeSchema.safeParse(event.value).success) {
    fail(`${event.value} is not a webhook event type. Use one of: ${WEBHOOK_EVENT_TYPES.join(", ")}.`);
  }

  const page = await listWebhookDeliveries(client, {
    endpointId: endpoint.value,
    status: status.value as AdminDelivery["status"] | undefined,
    eventType: event.value,
    limit,
    cursor: cursor.value,
  });

  if (rest.includes("--json")) {
    console.log(JSON.stringify(page, null, 2));
    return;
  }
  if (page.deliveries.length === 0) {
    console.log(kleur.dim("No deliveries."));
    return;
  }
  for (const delivery of page.deliveries) printDelivery(delivery);
  if (page.nextCursor) {
    console.log(kleur.dim(`More: pass --cursor ${page.nextCursor} for the next page.`));
  }
}

function printDeliveryDetail(delivery: AdminDeliveryDetail): void {
  printDelivery(delivery);
  console.log(JSON.stringify(delivery.event, null, 2));
}

async function webhooksDelivery(client: AuthClient, rest: string[]): Promise<void> {
  const id = idArg(rest, "Usage: seamless webhooks delivery <deliveryId> [--json]", "delivery");
  const delivery = await getWebhookDelivery(client, id);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(delivery, null, 2));
    return;
  }
  printDeliveryDetail(delivery);
}

async function webhooksRedeliver(client: AuthClient, rest: string[]): Promise<void> {
  const id = idArg(rest, "Usage: seamless webhooks redeliver <deliveryId> [--json]", "delivery");
  const delivery = await redeliverWebhook(client, id);
  if (rest.includes("--json")) {
    console.log(JSON.stringify(delivery, null, 2));
    return;
  }
  console.log(
    delivery.status === "succeeded"
      ? kleur.green(`Redelivered ${id}.`)
      : kleur.yellow(`Redelivered ${id}; the attempt did not succeed.`),
  );
  printDelivery(delivery);
}
