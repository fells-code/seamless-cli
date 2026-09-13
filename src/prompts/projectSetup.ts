import { select, text } from "@clack/prompts";

import { orCancel } from "../core/cancel.js";
import { requireInteractive } from "../core/tty.js";

import type { RegistryEntry, TemplateKind } from "../core/templates.js";

export type AuthMode = "local" | "docker";
export type AdminMode = "api" | "image" | "source" | "none";

export const AUTH_MODES: AuthMode[] = ["docker", "local"];
export const ADMIN_MODES: AdminMode[] = ["api", "image", "source", "none"];

// What each question falls back to when --yes answers it. These match the
// options labelled "(recommended)" in the prompts below, so an unattended run
// gets the same stack a developer pressing Enter would.
const DEFAULT_AUTH_MODE: AuthMode = "docker";
const DEFAULT_ADMIN_MODE: AdminMode = "api";

interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

// Builds the framework choices for one layer (web or api) from the registry, so
// adding a template is a registry edit, not a code change here. coming-soon
// templates show as disabled; beta templates are selectable but labelled.
function toOptions(templates: RegistryEntry[], kind: TemplateKind): Option[] {
  const forKind = templates.filter((t) => t.kind === kind);
  if (forKind.length === 0) {
    throw new Error(`The template registry has no ${kind} templates.`);
  }
  return forKind.map((t) => ({
    value: t.id,
    label:
      t.status === "coming-soon"
        ? `${t.label} (coming soon)`
        : t.status === "beta"
          ? `${t.label} (beta)`
          : t.label,
    disabled: t.status === "coming-soon",
  }));
}

// The registry lists templates in the order the prompt shows them, so the first
// selectable one of a kind is what a developer pressing Enter would land on.
function defaultTemplateId(
  templates: RegistryEntry[],
  kind: TemplateKind,
): string {
  const entry = templates.find(
    (t) => t.kind === kind && t.status !== "coming-soon",
  );
  if (!entry) {
    throw new Error(
      `The template registry has no selectable ${kind} templates, so --yes has nothing to choose. Run \`seamless templates list\` to see what is available.`,
    );
  }
  return entry.id;
}

// Answers supplied on the command line. Any field set here replaces its prompt;
// under assumeYes the rest fall back to the recommended option, except
// ownerEmail, which has no safe default and is required instead.
export interface Preselect {
  webTemplateId?: string;
  apiTemplateId?: string;
  mobileTemplateId?: string;
  ownerEmail?: string;
  authMode?: AuthMode;
  adminMode?: AdminMode;
}

function labelFor(templates: RegistryEntry[], id: string): string {
  return templates.find((t) => t.id === id)?.label ?? id;
}

async function resolveTemplateId(
  templates: RegistryEntry[],
  kind: TemplateKind,
  preselected: string | undefined,
  message: string,
  echoLabel: string,
  assumeYes: boolean,
): Promise<string> {
  const chosen =
    preselected ?? (assumeYes ? defaultTemplateId(templates, kind) : undefined);

  if (chosen) {
    console.log(`${echoLabel}: ${labelFor(templates, chosen)}`);
    return chosen;
  }

  requireInteractive(
    message,
    `Pass --${kind}=<id> to choose one (see \`seamless templates list\`), or --yes to take the recommended template.`,
  );

  return orCancel(
    await select({ message, options: toOptions(templates, kind) }),
  ) as string;
}

const NO_MOBILE = "none";

// A mobile starter is optional, unlike the web and api layers, which every
// project gets. A flag answers outright; --yes takes none, since a native app
// brings its own prerequisites (an associated domain for passkeys) that an
// unattended run should not opt into; and a registry that predates the kind
// offers nothing, so there is no question to ask.
async function resolveOptionalTemplateId(
  templates: RegistryEntry[],
  kind: TemplateKind,
  preselected: string | undefined,
  message: string,
  echoLabel: string,
  assumeYes: boolean,
): Promise<string | undefined> {
  if (preselected) {
    console.log(`${echoLabel}: ${labelFor(templates, preselected)}`);
    return preselected;
  }

  const available = templates.filter((t) => t.kind === kind);
  if (available.length === 0) {
    return undefined;
  }

  if (assumeYes) {
    console.log(`${echoLabel}: none`);
    return undefined;
  }

  requireInteractive(
    message,
    `Pass --${kind}=<id> to include one (see \`seamless templates list\`), or --yes to scaffold without.`,
  );

  const chosen = orCancel(
    await select({
      message,
      options: [
        { value: NO_MOBILE, label: "No mobile app (recommended to start)" },
        ...toOptions(templates, kind),
      ],
      initialValue: NO_MOBILE,
    }),
  ) as string;

  return chosen === NO_MOBILE ? undefined : chosen;
}

// Managed connect only needs the web and api templates (plus the optional
// mobile one): the auth server is the developer's managed instance, so the
// auth-mode, Docker, and admin-dashboard questions (all local-stack concerns)
// do not apply.
export async function runManagedTemplatePrompts(
  templates: RegistryEntry[],
  preselect: Preselect = {},
  assumeYes = false,
) {
  const webTemplateId = await resolveTemplateId(
    templates,
    "web",
    preselect.webTemplateId,
    "Web example",
    "Web example",
    assumeYes,
  );
  const apiTemplateId = await resolveTemplateId(
    templates,
    "api",
    preselect.apiTemplateId,
    "Backend framework",
    "Backend",
    assumeYes,
  );
  const mobileTemplateId = await resolveOptionalTemplateId(
    templates,
    "mobile",
    preselect.mobileTemplateId,
    "Mobile app",
    "Mobile app",
    assumeYes,
  );

  return { webTemplateId, apiTemplateId, mobileTemplateId };
}

export async function runProjectSetupPrompts(
  templates: RegistryEntry[],
  preselect: Preselect = {},
  knownEmail?: string,
  assumeYes = false,
) {
  const webTemplateId = await resolveTemplateId(
    templates,
    "web",
    preselect.webTemplateId,
    "Web example",
    "Web example",
    assumeYes,
  );
  const apiTemplateId = await resolveTemplateId(
    templates,
    "api",
    preselect.apiTemplateId,
    "Backend framework",
    "Backend",
    assumeYes,
  );
  const mobileTemplateId = await resolveOptionalTemplateId(
    templates,
    "mobile",
    preselect.mobileTemplateId,
    "Mobile app",
    "Mobile app",
    assumeYes,
  );

  // Written to the auth server as OWNER_EMAIL, which grants the admin role to
  // this address at signup. Asking here means registering in the scaffolded app
  // is the only step between `docker compose up` and a working admin. There is
  // no sane default for it, so --yes takes it from the flag or the portal
  // session and otherwise refuses to guess.
  const ownerEmail = await resolveOwnerEmail(
    preselect.ownerEmail ?? (assumeYes ? knownEmail : undefined),
    knownEmail,
    assumeYes,
  );

  const authMode = await resolveChoice<AuthMode>(
    preselect.authMode,
    assumeYes ? DEFAULT_AUTH_MODE : undefined,
    "Auth server",
    "How would you like to run SeamlessAuth?",
    "--auth",
    AUTH_MODES,
    async () =>
      orCancel(
        await select({
          message: "How would you like to run SeamlessAuth?",
          options: [
            {
              value: "docker",
              label: "Docker container (recommended)",
            },
            {
              value: "local",
              label: "Local dev server (advanced)",
            },
          ],
        }),
      ) as AuthMode,
  );

  const adminMode = await resolveChoice<AdminMode>(
    preselect.adminMode,
    assumeYes ? DEFAULT_ADMIN_MODE : undefined,
    "Admin console",
    "How would you like to host the admin console?",
    "--admin",
    ADMIN_MODES,
    async () =>
      orCancel(
        await select({
          message: "How would you like to host the admin console?",
          options: [
            {
              value: "api",
              label: "Served by your API at /console (recommended)",
            },
            {
              value: "image",
              label: "Separate container — official Docker image",
            },
            {
              value: "source",
              label: "Separate container — clone repo for modification",
            },
            {
              value: "none",
              label: "Don't include the admin console",
            },
          ],
          initialValue: "api",
        }),
      ) as AdminMode,
  );

  return {
    web: true,
    webTemplateId,

    api: true,
    apiTemplateId,

    mobile: mobileTemplateId !== undefined,
    mobileTemplateId,

    authMode,

    adminMode,
    ownerEmail: ownerEmail.trim(),
  };
}

// A flag answers the question outright; --yes falls back to the recommended
// option. Either way the choice is echoed, so an unattended run still reports
// what it picked.
async function resolveChoice<T extends string>(
  supplied: T | undefined,
  fallback: T | undefined,
  echoLabel: string,
  question: string,
  flag: string,
  allowed: readonly T[],
  ask: () => Promise<T>,
): Promise<T> {
  const chosen = supplied ?? fallback;
  if (chosen) {
    console.log(`${echoLabel}: ${chosen}`);
    return chosen;
  }

  requireInteractive(
    question,
    `Pass ${flag}=<${allowed.join("|")}>, or --yes to take the recommended option.`,
  );

  return ask();
}

async function resolveOwnerEmail(
  supplied: string | undefined,
  knownEmail: string | undefined,
  assumeYes: boolean,
): Promise<string> {
  if (supplied) {
    console.log(`Owner email: ${supplied}`);
    return supplied;
  }

  if (assumeYes) {
    throw new Error(
      "--yes needs an owner email, which becomes the admin when you register. Pass --email <address>, or run `seamless login` so it can be taken from your portal session.",
    );
  }

  requireInteractive(
    "Your email (becomes the admin when you register)",
    "Pass --email <address>, or run `seamless login` so it can be taken from your portal session.",
  );

  return orCancel(
    await text({
      message: "Your email (becomes the admin when you register)",
      placeholder: knownEmail ?? "you@example.com",
      initialValue: knownEmail ?? "",
      validate: (value) =>
        (value ?? "").includes("@") ? undefined : "Enter a valid email address",
    }),
  ) as string;
}
