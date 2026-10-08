import type { DetectedBackend, DetectedWeb } from "./detect.js";

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
