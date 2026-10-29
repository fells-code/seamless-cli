import fs from "fs";
import path from "path";
import { fetchEnvExample } from "../../core/fetch.js";
import { parseEnv, parseEnvString, writePrivateFile } from "../../core/env.js";
import { generateSecret } from "../../core/secrets.js";
import {
  buildOAuthAuthEnv,
  withLoginMethod,
  type CollectedOAuthProvider,
} from "../../core/oauthProviders.js";
import {
  POSTGRES_IMAGE,
  SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE,
  SEAMLESS_AUTH_API_IMAGE,
} from "../../core/images.js";

// The issuer the local auth server signs with. Every container reaches it by its
// compose service name, so containers see issuer == URL. An app run on the host
// reaches it at localhost:5312 instead, and is told this issuer separately
// (AUTH_SERVER_ISSUER in its .env) so signed responses still verify.
export const LOCAL_AUTH_ISSUER = "http://auth:5312";

export async function generateDockerCompose(
  root: string,
  options: {
    authMode: "local" | "docker";
    adminMode: AdminMode;
    oauth?: CollectedOAuthProvider[];
    ownerEmail?: string;
    // The web template serves /auth itself, so there is no api service and the
    // web container gets the auth wiring the api container would have had.
    fullStack?: boolean;
  },
) {
  const { compose, shared } = await buildCompose(options, root);

  fs.writeFileSync(
    path.join(root, "docker-compose.yml"),
    compose.trim() + "\n",
  );

  // Docker creates a missing mountpoint inside a bind mount as root, which on a
  // Linux host leaves e.g. api/node_modules unwritable by the user. One that
  // already exists keeps its owner.
  for (const mountpoint of isolatedMountpoints(compose)) {
    fs.mkdirSync(path.join(root, mountpoint), { recursive: true });
  }

  console.log("Docker compose created.");
  return shared;
}

// The paths an anonymous volume keeps out of a bind-mounted source tree, relative
// to the project root: `- ./api:/app` then `- /app/node_modules` is api/node_modules.
// Read from the compose text itself so it cannot disagree with what Docker mounts.
export function isolatedMountpoints(compose: string): string[] {
  const mountpoints: string[] = [];
  let source: string | undefined;
  for (const line of compose.split("\n")) {
    const bind = line.match(/^\s+- \.\/([^:\s]+):\/app$/);
    if (bind) {
      source = bind[1];
      continue;
    }
    const isolated = line.match(/^\s+- \/app\/(\S+)$/);
    if (isolated && source) {
      mountpoints.push(`${source}/${isolated[1]}`);
      continue;
    }
    if (!/^\s+- /.test(line)) source = undefined;
  }
  return mountpoints;
}

async function buildCompose(
  options: {
    authMode: "local" | "docker";
    adminMode: AdminMode;
    oauth?: CollectedOAuthProvider[];
    ownerEmail?: string;
    fullStack?: boolean;
  },
  root: string,
) {
  const { authMode, adminMode, oauth, ownerEmail, fullStack } = options;

  const { service: authBlock, shared } = await authService(
    authMode,
    root,
    oauth,
    adminMode,
    ownerEmail,
    fullStack,
  );

  const includeAdminContainer = adminMode === "image" || adminMode === "source";

  // Each block is trimmed and joined with exactly one blank line, so an omitted
  // service leaves no gap behind.
  const services = [
    dbService(),
    authBlock,
    ...(fullStack
      ? [fullStackWebService(shared)]
      : [apiService(shared, adminMode), webService()]),
    includeAdminContainer ? adminService(adminMode) : "",
  ]
    .map((block) => block.replace(/^\n+|\s+$/g, ""))
    .filter(Boolean);

  const volumes = ["  pgdata:"];
  if (authMode === "docker") volumes.push("  auth-keys:");

  return {
    compose: `# Ports are published on 127.0.0.1 so this stack is reachable from this machine
# only. The auth server is configured to return OTP codes in the response for
# local login, which would otherwise be an authentication bypass for anyone on
# the same network. Drop the 127.0.0.1 prefix only if you know you want that.
services:
${services.join("\n\n")}

volumes:
${volumes.join("\n")}
`,
    shared,
  };
}

function dbService() {
  return `
  db:
    image: ${POSTGRES_IMAGE}
    container_name: seamless-db
    ports:
      - "127.0.0.1:5432:5432"
    environment:
      POSTGRES_USER: myuser
      POSTGRES_PASSWORD: mypassword
      POSTGRES_DB: postgres
    volumes:
      # PostgreSQL 18+ images store data in a major-versioned subdirectory
      # (/var/lib/postgresql/18/docker), so the mount goes one level up. Mounting
      # .../data instead leaves the volume unused and the container refuses to
      # start. See docker-library/postgres#1259.
      - pgdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U myuser -d postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
`;
}

async function authService(
  mode: "local" | "docker",
  root: string,
  oauth: CollectedOAuthProvider[] = [],
  adminMode: AdminMode = "api",
  ownerEmail?: string,
  fullStack = false,
) {
  if (mode === "local") {
    // auth/.env was already written by generateAuthServer (with its secrets and any
    // OAuth config). Read those values back rather than regenerating, which would mint
    // a new service token that no longer matches the one the API was given.
    const shared = extractSharedFromExistingEnv(root);

    return {
      service: `
  auth:
    container_name: seamless-auth
    build:
      context: ./auth
      dockerfile: Dockerfile.dev
    ports:
      - "127.0.0.1:5312:5312"
    # The bind mount hides the image's chmod of validateEnvs.sh, and Dockerfile.dev
    # builds no dist/, so its entrypoint cannot run here. This mirrors the auth
    # server's own docker-compose.dev.yml: sync dependencies, migrate (creating the
    # database on first boot), then watch the TypeScript sources.
    entrypoint: ["/bin/sh", "-c"]
    command:
      - >
        sh ./syncDevDeps.sh &&
        (npm run migrate:up || (npm run db:create && npm run migrate:up)) &&
        npm run dev:container
    env_file:
      - ./auth/.env
    environment:
      DB_HOST: db
      ISSUER: ${LOCAL_AUTH_ISSUER}
    volumes:
      - ./auth:/app
      - /app/node_modules
    depends_on:
      db:
        condition: service_healthy
`,
      shared,
    };
  }

  return await authServiceDocker(root, oauth, adminMode, ownerEmail, fullStack);
}

// The app API's CORS allowlist. The console is same-origin here in API-served
// mode, so 5174 only belongs when a standalone dashboard container runs there.
function apiUiOrigins(adminMode: AdminMode): string {
  const web = "http://localhost:5173";
  if (adminMode === "image" || adminMode === "source") {
    return `${web},http://localhost:5174`;
  }
  return web;
}

function apiService(shared: any, adminMode: AdminMode) {
  return `
  api:
    container_name: api
    build: ./api
    ports:
      - "127.0.0.1:3000:3000"
    env_file:
      - ./api/.env
    environment:
      AUTH_SERVER_URL: ${LOCAL_AUTH_ISSUER}
      AUTH_SERVER_ISSUER: ${LOCAL_AUTH_ISSUER}
      UI_ORIGINS: ${apiUiOrigins(adminMode)}
      DB_HOST: db
      JWKS_KID: ${shared.kid}
    volumes:
      - ./api:/app
      - /app/node_modules
    depends_on:
      db:
        condition: service_healthy
      auth:
        condition: service_started
`;
}

function webService() {
  return `
  web:
    container_name: web
    build: ./web
    ports:
      - "127.0.0.1:5173:80"
    environment:
      API_URL: http://localhost:3000/
    volumes:
      - ./web:/app
      - /app/node_modules
    depends_on:
      - api
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost/health"]
      interval: 5s
      timeout: 5s
      retries: 10
`;
}

// A full-stack web app is its own backend: it reaches the auth server inside the
// compose network and holds the service token, as the api service does. It runs
// the template's dev target, so its messaging handlers print one-time codes and
// magic links to `docker compose logs web` (the local auth server sends none).
// node_modules and .next stay in the container: the bind mount would otherwise
// hide the installed dependencies and share a build cache with the host.
function fullStackWebService(shared: any) {
  return `
  web:
    container_name: web
    build: ./web
    ports:
      - "127.0.0.1:5173:80"
    env_file:
      - ./web/.env
    environment:
      AUTH_SERVER_URL: ${LOCAL_AUTH_ISSUER}
      AUTH_SERVER_ISSUER: ${LOCAL_AUTH_ISSUER}
      JWKS_KID: ${shared.kid}
    volumes:
      - ./web:/app
      - /app/node_modules
      - /app/.next
    depends_on:
      db:
        condition: service_healthy
      auth:
        condition: service_started
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 5s
      retries: 20
`;
}

async function authServiceDocker(
  root: string,
  oauth: CollectedOAuthProvider[] = [],
  adminMode: AdminMode = "api",
  ownerEmail?: string,
  fullStack = false,
) {
  const raw = await fetchEnvExample();
  const parsed = parseEnvString(raw);

  const { env, shared } = buildAuthEnv(
    parsed,
    "docker",
    oauth,
    adminMode,
    ownerEmail,
    fullStack,
  );

  // The image needs no source tree, so auth/ holds only its environment here,
  // beside where --auth=local keeps it.
  fs.mkdirSync(path.join(root, "auth"), { recursive: true });
  writeEnvFile(path.join(root, "auth", ".env"), env);

  return {
    service: `
  auth:
    image: ${SEAMLESS_AUTH_API_IMAGE}
    container_name: seamless-auth
    ports:
      - "127.0.0.1:5312:5312"
    env_file:
      - ./auth/.env
    volumes:
      # The dev signing key pair is generated into /app/keys on first use. Without
      # a volume a recreated container mints a new pair under the same kid, and
      # every adapter that cached the old public key fails verification. The image
      # creates /app/keys owned by its runtime user, and a fresh named volume
      # copies that ownership, so the server can still write there.
      - auth-keys:/app/keys
    depends_on:
      db:
        condition: service_healthy
`,
    shared,
  };
}

// The dashboard image (and the Dockerfile `--admin=source` builds) runs
// unprivileged nginx on 8080, not 80.
function adminService(mode: "image" | "source") {
  if (mode === "source") {
    return `
  admin:
    container_name: admin
    build: ./admin
    ports:
      - "127.0.0.1:5174:8080"
    environment:
      API_URL: http://localhost:3000/
    volumes:
      - ./admin:/app
      - /app/node_modules
    depends_on:
      - api
`;
  }

  return `
  admin:
    image: ${SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE}
    container_name: admin
    ports:
      - "127.0.0.1:5174:8080"
    environment:
      API_URL: http://localhost:3000/
    depends_on:
      - api
`;
}

export type AdminMode = "api" | "image" | "source" | "none";

// WebAuthn allowed origins the auth server accepts passkey ceremonies from. The
// web app (5173) is always present; the console adds either the app API origin
// (when the API serves it at /console) or the standalone container origin (5174).
// A full-stack web app serves the console from 5173 itself, which adds nothing.
function adminOrigins(adminMode: AdminMode, fullStack = false): string {
  const web = "http://localhost:5173";
  if (adminMode === "api") {
    return fullStack ? web : `${web},http://localhost:3000`;
  }
  if (adminMode === "image" || adminMode === "source") {
    return `${web},http://localhost:5174`;
  }
  return web;
}

export function buildAuthEnv(
  env: Record<string, string>,
  mode: "local" | "docker",
  oauth: CollectedOAuthProvider[] = [],
  adminMode: AdminMode = "api",
  ownerEmail?: string,
  fullStack = false,
) {
  const apiToken = generateSecret(32);
  const kid = "dev-main";

  // The auth server grants the admin role at signup to an address listed here,
  // so registering in the scaffolded app produces a working /console admin with
  // no separate promotion step. Signup-time only: setting this after an account
  // already exists promotes nobody.
  if (ownerEmail) {
    env.OWNER_EMAIL = ownerEmail;
  }

  env.PORT = "5312";
  env.NODE_ENV = "development";

  env.ISSUER =
    mode === "docker" ? LOCAL_AUTH_ISSUER : "http://localhost:5312";

  env.DB_HOST = mode === "docker" ? "db" : "localhost";
  env.DB_PORT = "5432";

  // The auth server's preferred name since 0.19.0, which refuses to start when both
  // names are set to different values. Its .env.example carries a placeholder under
  // that name, so the legacy name is dropped rather than written beside it.
  env.SEAMLESS_SERVICE_TOKEN = apiToken;
  delete env.API_SERVICE_TOKEN;

  // The auth server's own secrets (its AUTH_SECRETS). Before v0.20 an unset one
  // fell back to the service token; v0.20 requires each one whose feature is in
  // use. OAUTH_STATE_SECRET comes from buildOAuthAuthEnv when providers are set.
  env.REFRESH_TOKEN_LOOKUP_SECRET = generateSecret(32);
  env.TOTP_SECRET_ENCRYPTION_KEY = generateSecret(32);
  env.DECOY_SUBJECT_SECRET = generateSecret(32);

  env.APP_ORIGINS = "http://localhost:3000";
  env.ORIGINS = adminOrigins(adminMode, fullStack);

  // Serve the bundled admin dashboard build only when the app's backend (the
  // api template, or a full-stack web app) proxies it at /console; otherwise
  // the console is a standalone container (or omitted).
  env.SERVE_ADMIN_DASHBOARD = adminMode === "api" ? "true" : "false";

  // Enable email OTP so `seamless login` works against a freshly scaffolded stack
  // out of the box. The auth server's own default (passkey,magic_link) has no
  // method the CLI can drive without a browser authenticator.
  env.LOGIN_METHODS = withLoginMethod(env.LOGIN_METHODS, "email_otp");

  // Let `seamless login --local` read the OTP straight from the response instead
  // of needing a mail provider. Dev-only: the auth server ignores this under a
  // production NODE_ENV, and the scaffold runs as development.
  env.ALLOW_UNCREDENTIALED_DELIVERY_SECRETS = "true";

  // When the OAuth template collected providers, wire them into the auth server
  // (OAUTH_PROVIDERS, per-provider secret env vars, OAUTH_STATE_SECRET) and enable
  // the oauth login method.
  if (oauth.length > 0) {
    const { env: oauthEnv } = buildOAuthAuthEnv(oauth);
    Object.assign(env, oauthEnv);
    env.LOGIN_METHODS = withLoginMethod(env.LOGIN_METHODS, "oauth");
  }

  return {
    env,
    shared: {
      apiToken,
      kid,
    },
  };
}

export async function configureAuthLocalEnv(
  root: string,
  oauth: CollectedOAuthProvider[] = [],
  adminMode: AdminMode = "api",
  ownerEmail?: string,
  fullStack = false,
) {
  const authDir = path.join(root, "auth");
  const envExamplePath = path.join(authDir, ".env.example");
  const envPath = path.join(authDir, ".env");

  if (!fs.existsSync(envExamplePath)) {
    throw new Error(".env.example not found in auth directory");
  }

  const raw = fs.readFileSync(envExamplePath, "utf-8");

  const parsed = parseEnvString(raw);

  const { env, shared } = buildAuthEnv(
    parsed,
    "local",
    oauth,
    adminMode,
    ownerEmail,
    fullStack,
  );

  writeEnvFile(envPath, env);

  return shared;
}

function writeEnvFile(filePath: string, env: Record<string, string>) {
  const content = Object.entries(env)
    .map(([k, v]) => {
      if (v.includes("\n")) {
        return `${k}="${escapeMultiline(v)}"`;
      }
      return `${k}=${v}`;
    })
    .join("\n");

  writePrivateFile(filePath, content + "\n");
}

function escapeMultiline(value: string) {
  return value.replace(/\n/g, "\\n");
}

export function extractSharedFromExistingEnv(root: string) {
  const env = parseEnv(path.join(root, "auth", ".env"));

  return {
    apiToken: env.SEAMLESS_SERVICE_TOKEN || env.API_SERVICE_TOKEN,
    kid: env.SEAMLESS_JWKS_ACTIVE_KID || env.JWKS_ACTIVE_KID || "dev-main",
  };
}
