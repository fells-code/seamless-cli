import { addPackagesCommand, type DetectedBackend, type DetectedWeb } from "./detect.js";
import { nativeBackendSnippet } from "./nativeSnippets.js";

// What `seamless add` prints for the adopter to paste. It never edits their files:
// these follow the reference apps the conformance suite runs (verify/adapter-app,
// verify/adapter-fastify-app), with the starters' development-only code logging.

// The env reads both adapters take. `!` only where TypeScript would otherwise
// object, so the JavaScript version is still valid JavaScript.
function seamlessOptions(ts: boolean): string {
  const bang = ts ? "!" : "";
  return `const issuer = process.env.AUTH_SERVER_ISSUER || process.env.AUTH_SERVER_URL${bang};
const seamless = {
  authServerUrl: process.env.AUTH_SERVER_URL${bang},
  authServerIssuer: issuer,
  audience: issuer,
  cookieSecret: process.env.COOKIE_SIGNING_KEY${bang},
  serviceSecret: process.env.API_SERVICE_TOKEN${bang},
  jwksKid: process.env.JWKS_KID${bang},
  // Development only: log one-time codes and magic links instead of sending them,
  // so you can sign in without a mail or SMS provider. Replace before deploying.
  messaging:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          handlers: {
            sendOtpEmail: async ({ to, token }${ts ? ": { to: string; token: string }" : ""}) => {
              console.log(\`Dev OTP to=\${to} code=\${token}\`);
              return { accepted: true, provider: "console", channel: "email" as const };
            },
            sendOtpSms: async ({ to, token }${ts ? ": { to: string; token: string }" : ""}) => {
              console.log(\`Dev OTP to=\${to} code=\${token}\`);
              return { accepted: true, provider: "console", channel: "sms" as const };
            },
            sendMagicLinkEmail: async ({ to, magicLinkUrl }${ts ? ": { to: string; magicLinkUrl: string }" : ""}) => {
              console.log(\`Dev magic link to=\${to} url=\${magicLinkUrl}\`);
              return { accepted: true, provider: "console", channel: "email" as const };
            },
          },
        },
};`.replace(/ as const/g, ts ? " as const" : "");
}

export function backendSnippet(
  backend: DetectedBackend,
  opts: { webOrigin: string; serveConsole: boolean },
): string {
  if (backend.ecosystem !== "node") return nativeBackendSnippet(backend, opts);
  const ts = backend.typescript;
  if (backend.framework === "express") {
    const typing = ts
      ? `
// requireAuth puts the signed-in user on req.user.
declare global {
  namespace Express {
    interface Request {
      user?: SeamlessAuthUser;
    }
  }
}
`
      : "";
    return `import cookieParser from "cookie-parser";
import cors from "cors";
import createSeamlessAuthServer, {${opts.serveConsole ? "\n  createSeamlessConsoleProxy," : ""}
  requireAuth,${ts ? "\n  type SeamlessAuthUser," : ""}
} from "@seamless-auth/express";
${typing}
${seamlessOptions(ts)}
${
  opts.serveConsole
    ? `
// The admin dashboard at /console, ahead of CORS: it is same-origin static content.
if (process.env.SERVE_ADMIN_CONSOLE === "true") {
  app.use("/console", createSeamlessConsoleProxy({ authServerUrl: seamless.authServerUrl }));
}
`
    : ""
}
// Your web app calls /auth on this server with cookies, so it needs credentialed CORS.
app.use(cors({ origin: process.env.UI_ORIGINS?.split(",") ?? "${opts.webOrigin}", credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use("/auth", createSeamlessAuthServer(seamless));

// Protect a route. req.user is the signed-in user.
const signedIn = requireAuth({
  cookieSecret: seamless.cookieSecret,
  authServerUrl: seamless.authServerUrl,
  authServerIssuer: issuer,
  audience: issuer,
});
app.get("/api/me", signedIn, (req, res) => res.json({ id: req.user${ts ? "!" : ""}.id }));`;
  }

  return `import cors from "@fastify/cors";
import seamlessAuth, { requireAuth${opts.serveConsole ? ", seamlessConsoleProxy" : ""} } from "@seamless-auth/fastify";

${seamlessOptions(ts)}
${
  opts.serveConsole
    ? `
// The admin dashboard at /console.
if (process.env.SERVE_ADMIN_CONSOLE === "true") {
  await app.register(seamlessConsoleProxy, { prefix: "/console", authServerUrl: seamless.authServerUrl });
}
`
    : ""
}
// Your web app calls /auth on this server with cookies, so it needs credentialed CORS.
await app.register(cors, { origin: process.env.UI_ORIGINS?.split(",") ?? "${opts.webOrigin}", credentials: true });
await app.register(seamlessAuth, { prefix: "/auth", ...seamless });

// Protect a route. req.user is the signed-in user.
const signedIn = requireAuth({
  cookieSecret: seamless.cookieSecret,
  authServerUrl: seamless.authServerUrl,
  authServerIssuer: issuer,
  audience: issuer,
});
app.get("/api/me", { preHandler: signedIn }, async (req) => ({ id: req.user${ts ? "!" : ""}.id }));`;
}

/** The environment variable a React build reads the backend URL from. */
export function webApiUrlVariable(web: DetectedWeb): string {
  return web.bundler === "react-scripts" ? "REACT_APP_API_URL" : "VITE_API_URL";
}

export function webSnippet(web: DetectedWeb): string {
  const variable = webApiUrlVariable(web);
  const read =
    web.bundler === "react-scripts"
      ? `process.env.${variable}`
      : `import.meta.env.${variable}`;
  return `import { AuthProvider, useAuth } from "@seamless-auth/react";

// Wrap your app once, at the root. It talks to your backend's /auth routes.
<AuthProvider apiHost={${read}}>
  <App />
</AuthProvider>

// Anywhere below it:
const { isAuthenticated, user, logout } = useAuth();`;
}

const FRAMEWORK_NAMES: Record<DetectedBackend["framework"], string> = {
  express: "Express",
  fastify: "Fastify",
  nethttp: "Go (net/http)",
  gin: "Gin",
  chi: "chi",
  echo: "Echo",
  axum: "Axum",
  fastapi: "FastAPI",
  django: "Django",
};

export function frameworkName(framework: DetectedBackend["framework"]): string {
  return FRAMEWORK_NAMES[framework];
}

/** How the backend gets the values written to its .env, when it does not already. */
export function envLoadingHint(backend: DetectedBackend): string {
  switch (backend.ecosystem) {
    case "node":
      return 'if your app does not load .env yet, start it with node --env-file=.env (Node 20.6+) or import "dotenv/config" first.';
    case "go":
      return "Go does not read .env on its own: export the values, or load them with github.com/joho/godotenv at startup.";
    case "rust":
      return "Rust does not read .env on its own: call dotenvy::dotenv() at startup (the dotenvy crate).";
    default:
      return backend.framework === "django"
        ? "load it at the top of settings.py with python-dotenv (from dotenv import load_dotenv; load_dotenv())."
        : "load it at startup with python-dotenv (load_dotenv()), or run uvicorn with --env-file .env.";
  }
}

export interface PackageInstall {
  command: string;
  args: string[];
  // How it is shown, quoted for a shell.
  display: string;
  // False when seamless add cannot know it would install into the right place
  // (pip, with no project tool to say which environment), so it only prints it.
  run: boolean;
}

function install(command: string, args: string[], run = true): PackageInstall {
  const display = [command, ...args.map((a) => (/[[\]\s]/.test(a) ? `"${a}"` : a))].join(" ");
  return { command, args, display, run };
}

/** The backend's own install commands, for its ecosystem's tool. */
export function backendInstalls(backend: DetectedBackend): PackageInstall[] {
  switch (backend.ecosystem) {
    case "node": {
      const { deps, dev } = backendPackages(backend);
      const manager = backend.packageManager as Parameters<typeof addPackagesCommand>[0];
      return [
        ...(deps.length ? [addPackagesCommand(manager, deps)] : []),
        ...(dev.length ? [addPackagesCommand(manager, dev, true)] : []),
      ].map(({ command, args }) => install(command, args));
    }
    case "go":
      return [install("go", ["get", "github.com/fells-code/seamless-auth-go@latest"])];
    case "rust":
      return [install("cargo", ["add", "seamless-auth"])];
    default: {
      const pkg = `seamless-auth[${backend.framework === "django" ? "django" : "fastapi"}]>=0.2`;
      if (backend.packageManager === "uv") return [install("uv", ["add", pkg])];
      if (backend.packageManager === "poetry") return [install("poetry", ["add", pkg])];
      return [install("pip", ["install", pkg], false)];
    }
  }
}

/** What to install in each half, with dev dependencies listed apart. */
export function backendPackages(backend: DetectedBackend): { deps: string[]; dev: string[] } {
  if (backend.framework === "express") {
    return {
      deps: ["@seamless-auth/express", "cookie-parser", "cors"],
      dev: backend.typescript ? ["@types/cookie-parser", "@types/cors"] : [],
    };
  }
  return { deps: ["@seamless-auth/fastify", "@fastify/cors"], dev: [] };
}

export const WEB_PACKAGES = ["@seamless-auth/react"];
