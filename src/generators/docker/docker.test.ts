import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthEnv,
  configureAuthLocalEnv,
  extractSharedFromExistingEnv,
  generateDockerCompose,
  isolatedMountpoints,
  LOCAL_AUTH_ISSUER,
} from "./docker.js";
import {
  POSTGRES_IMAGE,
  SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE,
  SEAMLESS_AUTH_API_IMAGE,
} from "../../core/images.js";
import type { CollectedOAuthProvider } from "../../core/oauthProviders.js";
import { OAUTH_PROVIDER_CATALOG } from "../../core/oauthProviders.js";
import { parseEnv } from "../../core/env.js";

let tmpDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-docker-test-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  logSpy.mockRestore();
  vi.unstubAllGlobals();
});

function googleProvider(
  overrides: Partial<CollectedOAuthProvider> = {},
): CollectedOAuthProvider {
  const catalog = OAUTH_PROVIDER_CATALOG.find((p) => p.id === "google")!;
  return { catalog, clientId: "gid", clientSecret: "gsecret", ...overrides };
}

const LOCAL_KID = /^local-[0-9a-f]{12}$/;

function writeAuthEnvFixture(root: string, kidKey?: string) {
  fs.mkdirSync(path.join(root, "auth"), { recursive: true });
  const lines = ["API_SERVICE_TOKEN=existing-token"];
  if (kidKey) lines.push(`${kidKey}=existing-kid`);
  fs.writeFileSync(path.join(root, "auth", ".env"), lines.join("\n") + "\n");
}

function stubEnvExampleFetch(content: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, text: async () => content })),
  );
}

describe("buildAuthEnv", () => {
  // The auth server's .env.example ships a placeholder under the preferred name, and
  // the server refuses to start when the two names hold different values.
  it("replaces the example's service token placeholder and drops the legacy name", () => {
    const { env, shared } = buildAuthEnv(
      { SEAMLESS_SERVICE_TOKEN: "32-byte-hex-string", API_SERVICE_TOKEN: "old" },
      "docker",
    );

    expect(env.SEAMLESS_SERVICE_TOKEN).toBe(shared.apiToken);
    expect(env.SEAMLESS_SERVICE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(env).not.toHaveProperty("API_SERVICE_TOKEN");
  });

  it("wires docker-mode networking values", () => {
    const { env, shared } = buildAuthEnv({}, "docker");

    expect(env.ISSUER).toBe("http://auth:5312");
    expect(env.DB_HOST).toBe("db");
    expect(env.PORT).toBe("5312");
    expect(env.NODE_ENV).toBe("development");
    // The scaffolded stack no longer enables the bootstrap route: the first
    // admin comes from the OWNER_EMAIL grant at signup.
    expect(env.SEAMLESS_BOOTSTRAP_ENABLED).toBeUndefined();
    expect(env.SEAMLESS_BOOTSTRAP_SECRET).toBeUndefined();
    // Nothing in the ecosystem reads AUTH_MODE, so the scaffold does not write it.
    expect(env.AUTH_MODE).toBeUndefined();
    expect("bootstrapSecret" in shared).toBe(false);
    expect(env.SEAMLESS_SERVICE_TOKEN).toBe(shared.apiToken);
    expect(env.API_SERVICE_TOKEN).toBeUndefined();
    expect(env.REFRESH_TOKEN_LOOKUP_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.TOTP_SECRET_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(env.APP_ORIGINS).toBe("http://localhost:3000");
    // Defaults to API-served: the console shares the app API origin (3000).
    expect(env.ORIGINS).toBe("http://localhost:5173,http://localhost:3000");
    expect(env.SERVE_ADMIN_DASHBOARD).toBe("true");
    expect(env.LOGIN_METHODS).toBe("passkey,magic_link,email_otp");
    expect(env.ALLOW_UNCREDENTIALED_DELIVERY_SECRETS).toBe("true");
    expect(shared.kid).toMatch(LOCAL_KID);
  });

  // Adapters warn on every boot while jwksKid is exactly dev-main.
  it("scaffolds a kid other than the adapters' dev-main placeholder", () => {
    const first = buildAuthEnv({}, "docker").shared.kid;
    const second = buildAuthEnv({}, "local").shared.kid;

    expect(first).not.toBe("dev-main");
    expect(second).not.toBe("dev-main");
    expect(first).toMatch(LOCAL_KID);
    expect(first).not.toBe(second);
  });

  it("keeps a kid it is given", () => {
    const { env, shared } = buildAuthEnv(
      {},
      "docker",
      [],
      "api",
      undefined,
      false,
      "local-existing",
    );

    expect(shared.kid).toBe("local-existing");
    // The auth server never reads the service token kid.
    expect(Object.values(env)).not.toContain("local-existing");
  });

  it("adds the standalone console origin and disables serving in container mode", () => {
    const { env } = buildAuthEnv({}, "docker", [], "image");

    expect(env.ORIGINS).toBe("http://localhost:5173,http://localhost:5174");
    expect(env.SERVE_ADMIN_DASHBOARD).toBe("false");
  });

  it("lists only the web origin and disables serving when the console is omitted", () => {
    const { env } = buildAuthEnv({}, "docker", [], "none");

    expect(env.ORIGINS).toBe("http://localhost:5173");
    expect(env.SERVE_ADMIN_DASHBOARD).toBe("false");
  });

  // A full-stack web app serves the console from its own origin (5173), so the
  // api origin (3000) has no business in ORIGINS.
  it.each([
    ["api", "true"],
    ["none", "false"],
  ] as const)(
    "allows only the web origin for a full-stack app (--admin=%s)",
    (adminMode, serving) => {
      const { env } = buildAuthEnv({}, "docker", [], adminMode, undefined, true);

      expect(env.ORIGINS).toBe("http://localhost:5173");
      expect(env.SERVE_ADMIN_DASHBOARD).toBe(serving);
    },
  );

  it("wires local-mode networking values", () => {
    const { env } = buildAuthEnv({}, "local");

    expect(env.ISSUER).toBe("http://localhost:5312");
    expect(env.DB_HOST).toBe("localhost");
  });

  it("wires oauth env vars and enables the oauth login method when providers are given", () => {
    const { env } = buildAuthEnv({}, "docker", [googleProvider()]);

    expect(env.OAUTH_STATE_SECRET).toMatch(/^[0-9a-f]{64}$/);
    const providers = JSON.parse(env.OAUTH_PROVIDERS);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id: "google", enabled: true });
    expect(env.LOGIN_METHODS).toBe("passkey,magic_link,email_otp,oauth");
  });

  // The auth server's AUTH_SECRETS. From v0.20 none falls back to the service
  // token, so each must be generated, and generated apart from it.
  it.each(["local", "docker"] as const)(
    "generates each auth server secret, distinct from the service token (%s)",
    (mode) => {
      const { env } = buildAuthEnv({}, mode, [googleProvider()]);
      const names = [
        "REFRESH_TOKEN_LOOKUP_SECRET",
        "DECOY_SUBJECT_SECRET",
        "TOTP_SECRET_ENCRYPTION_KEY",
        "OAUTH_STATE_SECRET",
      ];
      const values = names.map((name) => env[name]);

      for (const value of values) {
        expect(value).toMatch(/^[0-9a-f]{64}$/);
        expect(value).not.toBe(env.SEAMLESS_SERVICE_TOKEN);
      }
      expect(new Set(values).size).toBe(names.length);
    },
  );

  it("generates DECOY_SUBJECT_SECRET without OAuth providers too", () => {
    const { env } = buildAuthEnv({}, "docker");

    expect(env.DECOY_SUBJECT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.DECOY_SUBJECT_SECRET).not.toBe(env.SEAMLESS_SERVICE_TOKEN);
  });
});

describe("extractSharedFromExistingEnv", () => {
  it("returns the kid it is given", () => {
    writeAuthEnvFixture(tmpDir);
    expect(extractSharedFromExistingEnv(tmpDir, "local-existing")).toEqual({
      apiToken: "existing-token",
      kid: "local-existing",
    });
  });

  // That variable names the auth server's RSA signing key, not the service token kid.
  it("does not take the kid from SEAMLESS_JWKS_ACTIVE_KID", () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");
    expect(extractSharedFromExistingEnv(tmpDir).kid).toMatch(LOCAL_KID);
  });

  it("reads the token under the auth server's preferred name", () => {
    fs.mkdirSync(path.join(tmpDir, "auth"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "auth", ".env"),
      "SEAMLESS_SERVICE_TOKEN=new-token\n",
    );
    expect(extractSharedFromExistingEnv(tmpDir).apiToken).toBe("new-token");
  });

  it("mints a non-default kid when none is given", () => {
    writeAuthEnvFixture(tmpDir);
    const { kid } = extractSharedFromExistingEnv(tmpDir);
    expect(kid).not.toBe("dev-main");
    expect(kid).toMatch(LOCAL_KID);
  });
});

describe("configureAuthLocalEnv", () => {
  it("throws when auth/.env.example is missing", async () => {
    fs.mkdirSync(path.join(tmpDir, "auth"), { recursive: true });

    await expect(configureAuthLocalEnv(tmpDir)).rejects.toThrow(
      ".env.example not found in auth directory",
    );
  });

  it("writes auth/.env derived from the example file and returns shared secrets", async () => {
    fs.mkdirSync(path.join(tmpDir, "auth"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "auth", ".env.example"),
      "SOME_KEY=placeholder\n# a comment\n",
    );

    const shared = await configureAuthLocalEnv(tmpDir, [googleProvider()]);

    expect(shared.kid).not.toBe("dev-main");
    expect(shared.kid).toMatch(LOCAL_KID);
    expect(shared.apiToken).toMatch(/^[0-9a-f]{64}$/);

    const written = fs.readFileSync(path.join(tmpDir, "auth", ".env"), "utf-8");
    expect(written).toContain(`SEAMLESS_SERVICE_TOKEN=${shared.apiToken}`);
    expect(written).not.toMatch(/^API_SERVICE_TOKEN=/m);
    expect(written).toContain("SOME_KEY=placeholder");
    expect(written).not.toContain("AUTH_MODE");
    expect(written).toContain("ISSUER=http://localhost:5312");
    expect(written).toContain("DB_HOST=localhost");
    expect(written.endsWith("\n")).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "writes auth/.env with mode 0600, tightening one that already exists",
    async () => {
      const authDir = path.join(tmpDir, "auth");
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, ".env.example"), "A=b\n");
      fs.writeFileSync(path.join(authDir, ".env"), "OLD=1\n", { mode: 0o644 });

      await configureAuthLocalEnv(tmpDir);

      expect(fs.statSync(path.join(authDir, ".env")).mode & 0o777).toBe(0o600);
    },
  );
});

describe("generateDockerCompose", () => {
  it("builds a local-auth compose file with an image-mode admin service", async () => {
    writeAuthEnvFixture(tmpDir);

    const shared = await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "image",
      kid: "existing-kid",
    });

    expect(shared).toEqual({ apiToken: "existing-token", kid: "existing-kid" });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );

    expect(compose).toContain(`image: ${POSTGRES_IMAGE}`);
    expect(compose).toContain("container_name: seamless-db");
    expect(compose).toContain("build:\n      context: ./auth");
    expect(compose).toContain("env_file:\n      - ./auth/.env");
    expect(compose).toContain("DB_HOST: db");
    expect(compose).toContain("ISSUER: http://auth:5312");
    expect(compose).not.toContain("existing-token");
    expect(compose).toContain("JWKS_KID: existing-kid");
    expect(compose).toContain("container_name: web");
    expect(compose).toContain(`image: ${SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE}`);
    expect(compose).not.toContain("build: ./admin");
    expect(compose).toContain("volumes:\n  pgdata:");
    expect(compose.endsWith("\n")).toBe(true);
  });

  // PostgreSQL 18+ images keep data in a major-versioned subdirectory, so a mount
  // at .../data is ignored and the container restart-loops on
  // "in 18+, these Docker images are configured to store database data in a
  // format which is compatible with pg_ctlcluster". The scaffold shipped exactly
  // that for one release cycle.
  it("mounts the database volume where PostgreSQL 18 actually stores data", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "image",
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );

    expect(compose).toContain("- pgdata:/var/lib/postgresql\n");
    expect(compose).not.toContain("/var/lib/postgresql/data");
  });

  // Publishing on 0.0.0.0 put the auth server on the LAN, and it is configured to
  // hand back OTP codes in the response for local login.
  it("publishes every port on loopback only", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "image",
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );

    for (const mapping of [
      "127.0.0.1:5432:5432",
      "127.0.0.1:5312:5312",
      "127.0.0.1:3000:3000",
      "127.0.0.1:5173:8080",
      "127.0.0.1:5174:8080",
    ]) {
      expect(compose).toContain(`- "${mapping}"`);
    }
    expect(compose).toContain('"--spider", "http://127.0.0.1:8080/health"');

    // No mapping escapes the loopback prefix.
    const published = compose.match(/^\s*- "[^"]*:\d+"$/gm) ?? [];
    expect(published.length).toBeGreaterThan(0);
    for (const line of published) {
      expect(line).toContain('"127.0.0.1:');
    }
  });

  it("omits the admin container in API-served mode and trims 5174 from the api CORS origins", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "api",
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );
    expect(compose).not.toContain("container_name: admin");
    expect(compose).toContain("UI_ORIGINS: http://localhost:5173\n");
  });

  it("omits the admin container entirely when the console is not included", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "none",
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );
    expect(compose).not.toContain("container_name: admin");
  });

  it("builds a source-mode admin service and keeps 5174 in the api CORS origins", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "source",
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );
    expect(compose).toContain("container_name: admin");
    expect(compose).toContain("build: ./admin");
    expect(compose).not.toContain("AUTH_MODE");
    expect(compose).toContain("- ./admin:/app");
    expect(compose).toContain('- "127.0.0.1:5174:8080"');
    expect(compose).toContain(
      "UI_ORIGINS: http://localhost:5173,http://localhost:5174",
    );
  });

  it("builds a docker-auth compose file using the fetched env.example and oauth wiring", async () => {
    stubEnvExampleFetch("SOME_VAR=value\n");

    const shared = await generateDockerCompose(tmpDir, {
      authMode: "docker",
      adminMode: "image",
      oauth: [googleProvider()],
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );

    expect(compose).toContain(`image: ${SEAMLESS_AUTH_API_IMAGE}`);
    expect(compose).not.toContain("build:\n      context: ./auth");
    const auth = compose.slice(compose.indexOf("\n  auth:"), compose.indexOf("\n  api:"));
    expect(auth).toContain("env_file:\n      - ./auth/.env\n");
    expect(auth).not.toContain("environment:");
    expect(compose).toContain(`JWKS_KID: ${shared.kid}`);

    const env = parseEnv(path.join(tmpDir, "auth", ".env"));
    expect(env.SEAMLESS_SERVICE_TOKEN).toBe(shared.apiToken);
    expect(env).not.toHaveProperty("API_SERVICE_TOKEN");
    expect(env.SOME_VAR).toBe("value");
    expect(JSON.parse(env.OAUTH_PROVIDERS)[0].clientSecretEnv).toBeTruthy();
  });

  it("scaffolds a docker-auth app kid that is not dev-main", async () => {
    stubEnvExampleFetch("SOME_VAR=value\n");

    const shared = await generateDockerCompose(tmpDir, {
      authMode: "docker",
      adminMode: "api",
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );
    expect(shared.kid).not.toBe("dev-main");
    expect(shared.kid).toMatch(LOCAL_KID);
    expect(compose).toContain(`JWKS_KID: ${shared.kid}`);
    expect(compose).not.toContain("dev-main");
  });

  // A local auth server writes auth/.env first and the compose call reads it back,
  // so the kid has to reach both or the app's .env and the compose file disagree.
  it("writes the same kid in both auth modes when one is given", async () => {
    stubEnvExampleFetch("SOME_VAR=value\n");
    const docker = await generateDockerCompose(tmpDir, {
      authMode: "docker",
      adminMode: "api",
      kid: "local-abc123",
    });
    expect(docker.kid).toBe("local-abc123");

    const local = await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "api",
      kid: "local-abc123",
    });
    expect(local.kid).toBe("local-abc123");
    expect(
      fs.readFileSync(path.join(tmpDir, "docker-compose.yml"), "utf-8"),
    ).toContain("JWKS_KID: local-abc123");
  });

  // #303: the compose file is committed, so no generated secret, and no OAuth
  // client secret the user typed in, may appear in it.
  it("keeps every secret out of the compose file, in the 0600 auth/.env", async () => {
    stubEnvExampleFetch("SOME_VAR=value\n");

    await generateDockerCompose(tmpDir, {
      authMode: "docker",
      adminMode: "api",
      oauth: [googleProvider({ clientSecret: "google-client-secret-value" })],
    });

    const compose = fs.readFileSync(path.join(tmpDir, "docker-compose.yml"), "utf-8");
    const envPath = path.join(tmpDir, "auth", ".env");
    const env = parseEnv(envPath);
    const secrets = [
      env.SEAMLESS_SERVICE_TOKEN,
      env.REFRESH_TOKEN_LOOKUP_SECRET,
      env.TOTP_SECRET_ENCRYPTION_KEY,
      env.DECOY_SUBJECT_SECRET,
      env.OAUTH_STATE_SECRET,
      "google-client-secret-value",
    ];
    expect(Object.values(env)).toContain("google-client-secret-value");
    for (const secret of secrets) {
      expect(secret).toBeTruthy();
      expect(compose).not.toContain(secret);
    }
    expect(compose).not.toMatch(/SERVICE_TOKEN|_SECRET|ENCRYPTION_KEY/);
    if (process.platform !== "win32") {
      expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    }
  });
});

describe("generateDockerCompose output shape", () => {
  async function render(
    authMode: "local" | "docker",
    adminMode: "api" | "image" | "source" | "none",
    fullStack: boolean,
  ) {
    const root = fs.mkdtempSync(path.join(tmpDir, `${authMode}-`));
    if (authMode === "local") writeAuthEnvFixture(root, "SEAMLESS_JWKS_ACTIVE_KID");
    else stubEnvExampleFetch("SOME_VAR=value\n");
    await generateDockerCompose(root, { authMode, adminMode, fullStack });
    renderedRoot = root;
    return fs.readFileSync(path.join(root, "docker-compose.yml"), "utf-8");
  }
  let renderedRoot = "";

  const combos = (["local", "docker"] as const).flatMap((authMode) =>
    (["api", "image", "source", "none"] as const).flatMap((adminMode) =>
      [false, true].map((fullStack) => ({ authMode, adminMode, fullStack })),
    ),
  );

  it.each(combos)(
    "separates blocks with exactly one blank line ($authMode, $adminMode, fullStack=$fullStack)",
    async ({ authMode, adminMode, fullStack }) => {
      const compose = await render(authMode, adminMode, fullStack);

      expect(compose).not.toMatch(/\n[ \t]*\n[ \t]*\n/);
      expect(compose).not.toMatch(/[ \t]+\n/);
      expect(compose.endsWith("\n")).toBe(true);
      expect(compose.endsWith("\n\n")).toBe(false);
      // Every service but the first is preceded by one blank line.
      const servicesSection = compose.slice(0, compose.indexOf("\nvolumes:"));
      const services = servicesSection.match(/^  [a-z]+:$/gm) ?? [];
      expect(services[0]).toBe("  db:");
      for (const name of services.slice(1)) {
        expect(compose).toContain(`\n\n${name}\n`);
      }
    },
  );

  // An app run on the host reads AUTH_SERVER_ISSUER from its .env; a container
  // gets the same value here, matching the URL it reaches the server at.
  it.each(combos)(
    "gives the app container an issuer equal to its auth URL ($authMode, $adminMode, fullStack=$fullStack)",
    async ({ authMode, adminMode, fullStack }) => {
      const compose = await render(authMode, adminMode, fullStack);
      const app = compose.slice(
        compose.indexOf(fullStack ? "\n  web:" : "\n  api:"),
      );

      expect(app).toContain(
        `AUTH_SERVER_URL: ${LOCAL_AUTH_ISSUER}\n      AUTH_SERVER_ISSUER: ${LOCAL_AUTH_ISSUER}\n`,
      );
      if (authMode === "docker") {
        expect(parseEnv(path.join(renderedRoot, "auth", ".env")).ISSUER).toBe(LOCAL_AUTH_ISSUER);
      } else {
        expect(compose).toContain(`ISSUER: ${LOCAL_AUTH_ISSUER}`);
      }
      expect(app).not.toContain("SERVICE_TOKEN");
    },
  );

  it("persists the docker auth server's dev signing keys on a named volume", async () => {
    const compose = await render("docker", "api", false);
    const auth = compose.slice(
      compose.indexOf("\n  auth:"),
      compose.indexOf("\n  api:"),
    );

    expect(auth).toContain("volumes:");
    expect(auth).toContain("- auth-keys:/app/keys\n");
    expect(compose).toMatch(/\nvolumes:\n  pgdata:\n  auth-keys:\n$/);
  });

  // A clone leaves validateEnvs.sh at mode 644 and has no dist/, and the bind
  // mount hides whatever the image did about either, so the image entrypoint
  // fails with "permission denied" and then MODULE_NOT_FOUND.
  it("runs the source-built auth server without the image entrypoint", async () => {
    const compose = await render("local", "api", false);
    const auth = compose.slice(compose.indexOf("\n  auth:"), compose.indexOf("\n  api:"));

    expect(auth).toContain('entrypoint: ["/bin/sh", "-c"]');
    expect(auth).toContain("sh ./syncDevDeps.sh &&");
    expect(auth).toContain("npm run migrate:up || (npm run db:create && npm run migrate:up)");
    expect(auth).toContain("npm run dev:container");
    expect(auth).not.toContain("validateEnvs.sh &&");
    expect(auth).not.toContain("dist/server.js");
  });

  // The local auth server bind-mounts ./auth over /app, so its keys already
  // land on the host and a named volume would only shadow them.
  it("declares no key volume for the source-built auth server", async () => {
    const compose = await render("local", "api", false);

    expect(compose).not.toContain("auth-keys");
    expect(compose).toMatch(/\nvolumes:\n  pgdata:\n$/);
  });
});

describe("buildAuthEnv owner grant", () => {
  it("writes OWNER_EMAIL so the first signup becomes an admin", () => {
    const { env } = buildAuthEnv({}, "docker", [], "api", "dev@example.com");
    expect(env.OWNER_EMAIL).toBe("dev@example.com");
    // withOwnerAdminRole only grants when admin is an available role, which the
    // auth server's own .env.example supplies.
    expect(env.AVAILABLE_ROLES ?? "user,admin").toContain("admin");
  });

  it("omits OWNER_EMAIL when no owner was collected", () => {
    const { env } = buildAuthEnv({}, "docker");
    expect("OWNER_EMAIL" in env).toBe(false);
  });
});

describe("generateDockerCompose for a full-stack web app", () => {
  it("runs the web app as the backend, with no api service", async () => {
    writeAuthEnvFixture(tmpDir);

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "none",
      fullStack: true,
      kid: "existing-kid",
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );
    const web = compose.slice(compose.indexOf("\n  web:"));

    expect(compose).not.toContain("\n  api:");
    expect(compose).not.toContain("\n  admin:");
    expect(web).toContain("- ./web/.env");
    expect(web).toContain("AUTH_SERVER_URL: http://auth:5312");
    expect(web).not.toContain("existing-token");
    expect(web).not.toContain("SERVICE_TOKEN");
    expect(web).toContain("JWKS_KID: existing-kid");
    expect(web).toContain('- "127.0.0.1:5173:8080"');
    expect(web).toContain("fetch('http://localhost:8080/health')");
    // The bind mount must not hide the container's dependencies or share a
    // build cache with the host.
    expect(web).toContain("- /app/node_modules");
    expect(web).toContain("- /app/.next");
    expect(web).not.toContain("depends_on:\n      - api");
    expect(web).not.toContain("API_URL");
  });

  it.each([
    ["api", "true"],
    ["none", "false"],
  ] as const)(
    "has the docker auth server serve the console only for --admin=api (%s)",
    async (adminMode, serving) => {
      stubEnvExampleFetch("SOME_VAR=value\n");

      await generateDockerCompose(tmpDir, {
        authMode: "docker",
        adminMode,
        fullStack: true,
      });

      const compose = fs.readFileSync(
        path.join(tmpDir, "docker-compose.yml"),
        "utf-8",
      );
      const auth = compose.slice(
        compose.indexOf("\n  auth:"),
        compose.indexOf("\n  web:"),
      );

      expect(auth).toContain("- ./auth/.env");
      const env = parseEnv(path.join(tmpDir, "auth", ".env"));
      expect(env.SERVE_ADMIN_DASHBOARD).toBe(serving);
      expect(env.ORIGINS).toBe("http://localhost:5173");
      // The web app proxies the console; nothing else is added for it.
      expect(compose).not.toContain("\n  api:");
      expect(compose).not.toContain("\n  admin:");
      expect(compose).not.toContain("5174");
    },
  );

  it("writes a local auth server's origins for a full-stack console", async () => {
    fs.mkdirSync(path.join(tmpDir, "auth"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "auth", ".env.example"), "A=b\n");

    await configureAuthLocalEnv(tmpDir, [], "api", undefined, true);

    const written = fs.readFileSync(path.join(tmpDir, "auth", ".env"), "utf-8");
    expect(written).toContain("ORIGINS=http://localhost:5173\n");
    expect(written).toContain("SERVE_ADMIN_DASHBOARD=true\n");
  });

  it("keeps the api and web services for a split stack", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "none",
      fullStack: false,
    });

    const compose = fs.readFileSync(
      path.join(tmpDir, "docker-compose.yml"),
      "utf-8",
    );

    expect(compose).toContain("\n  api:");
    expect(compose).toContain("API_URL: http://localhost:3000/");
  });
});

// On a Linux host Docker creates a missing mountpoint as root, and the user can then
// not `npm install` into it on the host. A directory that already exists keeps its owner.
describe("isolated mountpoints", () => {
  it("reads each anonymous volume under a bind-mounted source tree", () => {
    const compose = [
      "services:",
      "  web:",
      "    volumes:",
      "      - ./web:/app",
      "      - /app/node_modules",
      "      - /app/.next",
      "    depends_on:",
      "      - db",
      "  auth:",
      "    volumes:",
      "      - auth-keys:/app/keys",
    ].join("\n");

    expect(isolatedMountpoints(compose)).toEqual([
      "web/node_modules",
      "web/.next",
    ]);
  });

  it("creates them, as the user running init, for a split stack with a source admin", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "source",
    });

    for (const dir of [
      "auth/node_modules",
      "api/node_modules",
      "web/node_modules",
      "admin/node_modules",
    ]) {
      expect(fs.statSync(path.join(tmpDir, dir)).isDirectory()).toBe(true);
    }
  });

  it("creates .next for a full-stack web app", async () => {
    writeAuthEnvFixture(tmpDir);

    await generateDockerCompose(tmpDir, {
      authMode: "local",
      adminMode: "none",
      fullStack: true,
      kid: "existing-kid",
    });

    expect(fs.existsSync(path.join(tmpDir, "web/node_modules"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "web/.next"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "api"))).toBe(false);
  });

  it("leaves an existing directory and its contents alone", async () => {
    writeAuthEnvFixture(tmpDir, "SEAMLESS_JWKS_ACTIVE_KID");
    fs.mkdirSync(path.join(tmpDir, "api/node_modules"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "api/node_modules/keep"), "x");

    await generateDockerCompose(tmpDir, { authMode: "local", adminMode: "api" });

    expect(
      fs.readFileSync(path.join(tmpDir, "api/node_modules/keep"), "utf-8"),
    ).toBe("x");
  });
});
