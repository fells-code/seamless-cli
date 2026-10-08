import fs from "fs";
import path from "path";

import { fetchEnvExample } from "../../core/fetch.js";
import { formatValue, parseEnvString } from "../../core/env.js";
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

/**
 * Writes a local auth server and its Postgres into `<root>/seamless/`: a compose
 * file, the server's environment (secrets included) in seamless/.env, and a
 * .gitignore that keeps that file out of the repository. Unlike the `init` stack it
 * names no containers and publishes no Postgres port, because an existing project
 * may run its own database, or another Seamless stack, on the same machine.
 */
export async function generateAuthStack(root: string, options: AuthStackOptions) {
  const dir = path.join(root, AUTH_STACK_DIR);
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
  fs.writeFileSync(
    path.join(dir, ".env"),
    `# The local Seamless Auth server's configuration, written by seamless add.
# It holds secrets: keep it out of version control (see .gitignore).
${envFile}
`,
  );
  fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n");

  fs.writeFileSync(
    path.join(dir, "docker-compose.yml"),
    `# A local Seamless Auth server for this project, written by seamless add.
#
#   docker compose -f ${AUTH_STACK_DIR}/docker-compose.yml up -d
#
# The auth server is published on 127.0.0.1 so it is reachable from this machine
# only: it is configured for local development, where it returns one-time codes
# to the adapter instead of sending them. Postgres is not published at all.
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

  return { dir, apiToken: shared.apiToken, kid: shared.kid };
}
