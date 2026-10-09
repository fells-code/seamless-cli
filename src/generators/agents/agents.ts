import fs from "fs";
import path from "path";
import { apiDevCommand } from "../../core/output.js";
import type { AdminMode } from "../docker/docker.js";

export const LLMS_TXT_URL = "https://docs.seamlessauth.com/llms.txt";

// Claude Code reads CLAUDE.md, and the `@` form makes it load the referenced
// file rather than just mention it, so AGENTS.md stays the one source.
export const CLAUDE_MD = "See @AGENTS.md\n";

export interface AgentsTemplate {
  id: string;
  label: string;
  framework: string;
  // Relative to the project root, as the template manifest's targetDir.
  dir: string;
  // Whether the template shipped its own AGENTS.md. Templates releases before
  // fells-code/seamless-templates#115 did not, and a link to nothing misleads.
  hasGuide?: boolean;
}

export interface AgentsDocOptions {
  projectName: string;
  web: AgentsTemplate & { fullStack?: boolean };
  api?: AgentsTemplate;
  mobile?: AgentsTemplate;
  authMode: "docker" | "local" | "managed";
  adminMode: AdminMode;
  ownerEmail?: string;
  managed?: { instanceUrl: string; applicationName: string };
}

// The root AGENTS.md for a scaffolded project. Each template directory ships
// its own guide; this one says how they fit together, using what init chose.
export function buildAgentsMd(opts: AgentsDocOptions): string {
  const { web, api, mobile, authMode, adminMode } = opts;
  const managed = authMode === "managed";
  const fullStack = Boolean(web.fullStack);
  const backend = fullStack ? web : api;
  const backendUrl = fullStack ? "http://localhost:5173" : "http://localhost:3000";
  const lines: string[] = [];
  const add = (...l: string[]) => lines.push(...l);

  add(
    `# Agent guide: ${opts.projectName}`,
    "",
    "Scaffolded by `seamless init`. Sign-in, sessions and roles come from",
    "[Seamless Auth](https://docs.seamlessauth.com), open source passwordless auth (passkeys, email",
    "or SMS codes, magic links). Auth is already wired end to end. Your job when extending this",
    "project is to keep using it, not to rebuild it.",
    "",
    "## Layout",
    "",
  );
  const layer = (t: AgentsTemplate, role: string) => {
    const guide = t.hasGuide === false ? "README.md" : "AGENTS.md";
    add(
      `- \`${t.dir}/\`: ${role}, from the \`${t.id}\` template, "${t.label}".`,
      `  Read [${t.dir}/${guide}](${t.dir}/${guide}) before changing it.`,
    );
  };
  layer(web, fullStack ? "the web app and its own backend (serves `/auth`)" : "the web app");
  if (api) layer(api, "the API, the web app's backend");
  if (mobile) layer(mobile, "the mobile app");
  if (authMode === "local") {
    add(
      "- `auth/`: a clone of the Seamless Auth server source, run in development mode by compose",
      "  (`auth/Dockerfile.dev`, source mounted). Its settings are in `auth/.env`.",
    );
  }
  if (adminMode === "source") {
    add("- `admin/`: the admin console source, built by compose. Yours to edit.");
  }
  if (!managed) {
    add("- `docker-compose.yml`: the whole local stack. Ports are bound to 127.0.0.1 only.");
  }
  add("- `seamless.config.json`: the choices init made. `seamless check` reads it.", "", "## Services", "");

  add(`- Web: http://localhost:5173`);
  if (api) add(`- API: http://localhost:3000 (forwards \`/auth/*\` to the auth server)`);
  if (managed) {
    add(
      `- Auth server: ${opts.managed?.instanceUrl} (managed application "${opts.managed?.applicationName}").`,
      "  Users, roles and OAuth providers are managed from the dashboard.",
    );
  } else {
    add(
      authMode === "local"
        ? "- Auth server: http://localhost:5312, built from `auth/` (compose service `auth`)"
        : "- Auth server: http://localhost:5312, the Seamless Auth Docker image (compose service `auth`)",
      "  (containers reach it as http://auth:5312, which is also its token issuer)",
      "- Postgres: localhost:5432 (compose service `db`)",
    );
    const consoleLine: Record<AdminMode, string | null> = {
      api: `- Admin console: ${backendUrl}/console, served by ${fullStack ? "the web app" : "the API"}`,
      image: "- Admin console: http://localhost:5174 (compose service `admin`, Docker image)",
      source: "- Admin console: http://localhost:5174 (compose service `admin`, built from `admin/`)",
      none: null,
    };
    const line = consoleLine[adminMode];
    if (line) add(line);
  }

  add("", "## Run", "");
  if (managed) {
    if (api) add(`- API: \`${apiDevCommand(api.framework)}\``);
    add("- Web: `cd web && npm install && npm run dev`");
  } else {
    add("- `docker compose up` from this directory starts everything above.");
    if (fullStack) {
      add("- One-time codes and sign-in links print in `docker compose logs web`.");
    }
  }
  if (mobile) {
    add(
      `- Mobile: \`cd ${mobile.dir} && npm install && npx expo start\`. An Android emulator reaches the`,
      "  API at http://10.0.2.2:3000. Passkeys need an associated domain; see its README.",
    );
  }
  add(
    "- `seamless check` validates the project, Docker and the running services (`--strict` exits",
    "  non-zero on failure). `seamless --help` lists every other command.",
  );

  if (!managed && opts.ownerEmail) {
    const where =
      authMode === "local" ? "`auth/.env`" : "the `auth` service of `docker-compose.yml`";
    add(
      "",
      "## First admin",
      "",
      `\`${opts.ownerEmail}\` is the owner: registering with it grants the admin role. The grant`,
      `happens at signup, so change \`OWNER_EMAIL\` in ${where}`,
      "before registering if it is wrong.",
    );
  }

  add(
    "",
    "## Rules",
    "",
    "- Do not write your own JWT, password, session cookie or login endpoint code. Seamless Auth",
    "  is passwordless and already issues and checks sessions.",
    fullStack
      ? `- Use the SDK in \`${web.dir}/\`: it serves \`/auth\` and resolves sessions on the server.`
      : `- Use the SDK in \`${web.dir}/\` and the adapter in \`${backend?.dir ?? "api"}/\`. The browser never calls the auth server.`,
    "- Guard every protected route on the server; client-side checks are for display only.",
    managed
      ? "- The `.env` files hold a live service token. Keep them out of version control."
      : "- The secrets in `.env` files and `docker-compose.yml` are for local development only.",
    "",
    "## Docs",
    "",
    "- https://docs.seamlessauth.com",
    `- Everything, for agents: ${LLMS_TXT_URL}`,
  );

  return lines.join("\n") + "\n";
}

// Written unconditionally, like the compose file and seamless.config.json: init
// only scaffolds into a non-empty directory under --force or an explicit choice.
export function generateAgentsFiles(root: string, opts: AgentsDocOptions) {
  fs.writeFileSync(path.join(root, "AGENTS.md"), buildAgentsMd(opts));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), CLAUDE_MD);
  console.log("Agent guides created.");
}
