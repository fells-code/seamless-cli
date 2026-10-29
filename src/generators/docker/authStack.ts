import fs from "fs";
import path from "path";

import { fetchEnvExample } from "../../core/fetch.js";
import { formatValue, parseEnvString, writePrivateFile } from "../../core/env.js";
import { ensureGitignore } from "../../core/gitignore.js";
import { POSTGRES_IMAGE, SEAMLESS_AUTH_API_IMAGE } from "../../core/images.js";
import { buildAuthEnv } from "./docker.js";

// Where `seamless add --local` keeps the auth server for an existing repository, so
// nothing at the repository root changes and the whole stack is one folder to
// delete or ignore.
export const AUTH_STACK_DIR = "seamless";

export interface AuthStackOptions {
  // The adopter's backend origin, which calls the auth server.
  apiOrigin: string;
  // The browser origin(s) passkey ceremonies start from.
  webOrigins: string[];
  // Whether the backend serves the admin dashboard at /console.
  serveConsole: boolean;
  ownerEmail?: string;
}

const COMPOSE_NAME_LINE = /^name:\s*["']?([a-z0-9][a-z0-9_-]*)["']?\s*$/m;

/**
 * The Compose project name for a repository's stack: the repository directory's
 * name, reduced to what Compose accepts (lowercase letters, digits, dashes and
 * underscores, starting with a letter or digit), plus "-seamless".
 */
export function composeProjectName(root: string): string {
  const base = path
    .basename(path.resolve(root))
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+|[-_]+$/g, "");
  return `${base || "app"}-seamless`;
}

// The name an earlier run wrote, so a re-run (or a hand edit) keeps its volumes.
function existingProjectName(compose: string): string | undefined {
  if (!fs.existsSync(compose)) return undefined;
  return COMPOSE_NAME_LINE.exec(fs.readFileSync(compose, "utf-8"))?.[1];
}

/**
 * Writes a local auth server and its Postgres into `<root>/seamless/`: a compose
 * file, the server's environment (secrets included) in seamless/.env, and a
 * .gitignore that keeps that file out of the repository. Unlike the `init` stack it
 * names no containers and publishes no Postgres port, because an existing project
 * may run its own database, or another Seamless stack, on the same machine.
 *
 * The compose file names its project. Without that, Compose would name it after the
 * folder, which is "seamless" in every repository, and every repository on the
 * machine would share one database and one signing key.
 */
export async function generateAuthStack(root: string, options: AuthStackOptions) {
  const dir = path.join(root, AUTH_STACK_DIR);
  const composePath = path.join(dir, "docker-compose.yml");
  const replacing = fs.existsSync(composePath);
  const previousName = existingProjectName(composePath);
  const projectName = previousName ?? composeProjectName(root);
  fs.mkdirSync(dir, { recursive: true });

  const example = parseEnvString(await fetchEnvExample());
  const { env, shared } = buildAuthEnv(
    example,
    "docker",
    [],
    options.serveConsole ? "api" : "none",
    options.ownerEmail,
  );
  // The adopter's own origins, rather than the starters' fixed ports.
  env.APP_ORIGINS = options.apiOrigin;
  env.ORIGINS = [
    ...options.webOrigins,
    ...(options.serveConsole ? [options.apiOrigin] : []),
  ].join(",");

  const envFile = Object.entries(env)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join("\n");
  writePrivateFile(
    path.join(dir, ".env"),
    `# The local Seamless Auth server's configuration, written by seamless add.
# It holds secrets: keep it out of version control (see .gitignore).
${envFile}
`,
  );
  ensureGitignore(dir, [".env"]);

  fs.writeFileSync(
    composePath,
    `# A local Seamless Auth server for this project, written by seamless add.
#
#   docker compose -f ${AUTH_STACK_DIR}/docker-compose.yml up -d
#
# The auth server is published on 127.0.0.1 so it is reachable from this machine
# only: it is configured for local development, where it returns one-time codes
# to the adapter instead of sending them. Postgres is not published at all.
#
# The project name keeps this repository's database and signing keys apart from
# any other Seamless Auth stack on this machine. Keep it unique if you change it.
name: ${projectName}

services:
  db:
    image: ${POSTGRES_IMAGE}
    environment:
      POSTGRES_USER: myuser
      POSTGRES_PASSWORD: mypassword
      POSTGRES_DB: postgres
    volumes:
      # PostgreSQL 18+ images store data in a major-versioned subdirectory, so the
      # mount goes one level up. See docker-library/postgres#1259.
      - pgdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U myuser -d postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  auth:
    image: ${SEAMLESS_AUTH_API_IMAGE}
    ports:
      - "127.0.0.1:5312:5312"
    env_file:
      - .env
    volumes:
      # The dev signing key pair is generated into /app/keys on first use. Without
      # a volume a recreated container mints a new pair under the same kid, and
      # every adapter that cached the old public key fails verification.
      - auth-keys:/app/keys
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
  auth-keys:
`,
  );

  return {
    dir,
    apiToken: shared.apiToken,
    kid: shared.kid,
    projectName,
    // A stack from before the compose file named its project ran as "seamless".
    replacedUnnamed: replacing && previousName === undefined,
  };
}
