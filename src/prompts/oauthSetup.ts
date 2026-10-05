import { multiselect, password, text } from "@clack/prompts";

import { orCancel } from "../core/cancel.js";
import {
  OAUTH_PROVIDER_CATALOG,
  tenantProblem,
  type CollectedOAuthProvider,
} from "../core/oauthProviders.js";

// Runs when the selected web template opts into OAuth setup. Lets the user pick
// providers and paste each one's client id and secret, so the scaffolded auth
// server has OAuth working right after `docker compose up`. Blank credentials are
// allowed (the provider is scaffolded disabled for the user to fill in later).
export async function runOAuthSetupPrompts(): Promise<CollectedOAuthProvider[]> {
  const chosen = orCancel(
    await multiselect({
      message: "Which OAuth providers do you want to enable? (space to select)",
      options: OAUTH_PROVIDER_CATALOG.map((p) => ({ value: p.id, label: p.label })),
      required: false,
    }),
  ) as string[];

  if (!Array.isArray(chosen) || chosen.length === 0) {
    return [];
  }

  const collected: CollectedOAuthProvider[] = [];

  for (const id of chosen) {
    const catalog = OAUTH_PROVIDER_CATALOG.find((p) => p.id === id);
    if (!catalog) continue;

    const clientId = orCancel(
      await text({
        message: `${catalog.label} client ID`,
        placeholder: "leave blank to configure later",
      }),
    ) as string;

    const clientSecret = orCancel(
      await password({
        message: `${catalog.label} client secret`,
      }),
    ) as string;

    const tenant = catalog.tenanted
      ? (orCancel(
          await text({
            message: `${catalog.label} directory (tenant) ID`,
            placeholder: "leave blank to configure later",
            validate: (value) => tenantProblem(value ?? ""),
          }),
        ) as string)
      : undefined;

    collected.push({
      catalog,
      clientId: (clientId ?? "").trim(),
      clientSecret: (clientSecret ?? "").trim(),
      ...(tenant !== undefined ? { tenant: tenant.trim() } : {}),
    });
  }

  return collected;
}
