import { HostedUiSchema, type HostedUi } from "@seamless-auth/types";
import type { z } from "zod";
import type { AuthClient } from "./authClient.js";
import {
  ConfigApiError,
  getSystemConfig,
  patchSystemConfig,
  type PatchResult,
} from "./systemConfig.js";

export type { HostedUi };

export const HOSTED_UI_KEY = "hosted_ui";

export const HOSTED_UI_COLOR_FIELDS = [
  "primary",
  "onPrimary",
  "background",
  "surface",
  "text",
  "muted",
] as const;

export type HostedUiColorField = (typeof HOSTED_UI_COLOR_FIELDS)[number];

// Every field `config hosted-ui reset <field>` can remove, as dotted paths.
export const HOSTED_UI_FIELDS = [
  "appName",
  "logoUrl",
  "fontFamily",
  "colors",
  ...HOSTED_UI_COLOR_FIELDS.map((field) => `colors.${field}` as const),
] as const;

export type HostedUiField = (typeof HOSTED_UI_FIELDS)[number];

export interface HostedUiChanges {
  appName?: string;
  logoUrl?: string;
  fontFamily?: string;
  colors?: Partial<Record<HostedUiColorField, string>>;
}

export function formatIssues(error: z.ZodError, prefix: string): string {
  return error.issues
    .map((issue) => {
      const path = [prefix, ...issue.path.map(String)].join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function validateHostedUi(value: unknown): HostedUi {
  if (value && typeof value === "object" && "logoUrl" in value) {
    const { logoUrl } = value as { logoUrl: unknown };
    if (typeof logoUrl === "string") checkLogoUrl(logoUrl);
  }
  const parsed = HostedUiSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigApiError(
      `Invalid hosted page branding. ${formatIssues(parsed.error, HOSTED_UI_KEY)}`,
    );
  }
  return parsed.data;
}

// The instance has no logo upload or hosting, and the schema takes only an https URL,
// so a path is refused here with the reason rather than as an opaque "Invalid URL".
export function checkLogoUrl(value: string): void {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined || scheme === "file" || scheme === "data") {
    throw new ConfigApiError(
      `"${value}" is not an https URL. The logo must be an https URL where the image ` +
        "is hosted; the instance does not store uploaded files. Host the file " +
        "(for example on your own site or a CDN) and pass its https URL.",
    );
  }
}

export async function getHostedUi(
  client: AuthClient,
): Promise<HostedUi | null> {
  const config = await getSystemConfig(client);
  if (!(HOSTED_UI_KEY in config)) {
    throw new ConfigApiError(
      "This instance does not support hosted page branding (hosted_ui). " +
        "It needs auth server v0.21 or later.",
    );
  }
  const value = config[HOSTED_UI_KEY];
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigApiError(
      "The instance returned hosted page branding this CLI cannot read.",
    );
  }
  return value as HostedUi;
}

function isEmpty(value: object): boolean {
  return Object.keys(value).length === 0;
}

export function mergeHostedUi(
  current: HostedUi | null,
  changes: HostedUiChanges,
): HostedUi {
  const { colors, ...rest } = changes;
  const merged: HostedUi = { ...(current ?? {}), ...rest };
  if (colors && !isEmpty(colors)) {
    merged.colors = { ...(current?.colors ?? {}), ...colors };
  }
  return merged;
}

export function removeHostedUiFields(
  current: HostedUi | null,
  fields: readonly HostedUiField[],
): HostedUi | null {
  if (!current) return null;
  const next: HostedUi = { ...current };
  if (current.colors) next.colors = { ...current.colors };

  for (const field of fields) {
    if (field.startsWith("colors.")) {
      if (next.colors) delete next.colors[field.slice(7) as HostedUiColorField];
    } else {
      delete next[field as keyof HostedUi];
    }
  }
  if (next.colors && isEmpty(next.colors)) delete next.colors;
  return isEmpty(next) ? null : next;
}

export function isHostedUiField(value: string): value is HostedUiField {
  return (HOSTED_UI_FIELDS as readonly string[]).includes(value);
}

// The API replaces hosted_ui whole, so every write sends the complete object.
export async function putHostedUi(
  client: AuthClient,
  value: HostedUi | null,
): Promise<PatchResult> {
  const body = value === null ? null : validateHostedUi(value);
  return patchSystemConfig(client, { [HOSTED_UI_KEY]: body });
}
