import cors from "@fastify/cors";
import Fastify from "fastify";
import seamlessAuth, { requireAuth } from "@seamless-auth/fastify";

// The Fastify twin of adapter-app/server.mjs. Same routes, same env contract,
// same capture transport: the point of this service is that a spec cannot tell
// which adapter answered it, so any difference in behaviour is a real one.
//
// The adapter strips OTP/magic-link secrets before responding to the browser, so
// the conformance harness can't read codes from responses. These handlers receive
// the raw delivery payloads and stash them for the harness to read via /__captured.
// The API signs as its ISSUER, which differs from AUTH_SERVER_URL when this app runs
// on the host and reaches the API through a published port. See CONFORMANCE.md.
const ISSUER = process.env.AUTH_SERVER_ISSUER ?? process.env.AUTH_SERVER_URL;

const captured = new Map();
const ok = (channel) => ({ accepted: true, provider: "capture", channel });

const handlers = {
  async sendOtpEmail({ to, token }) {
    captured.set(to, { token: String(token) });
    return ok("email");
  },
  async sendOtpSms({ to, token }) {
    captured.set(to, { token: String(token) });
    return ok("sms");
  },
  async sendMagicLinkEmail({ to, token, magicLinkUrl }) {
    captured.set(to, { token, magicLinkUrl });
    return ok("email");
  },
  async sendBootstrapInviteEmail({ to, token, inviteUrl }) {
    captured.set(to, { token, inviteUrl });
    return ok("email");
  },
};

// One trusted hop, so each conformance actor's X-Forwarded-For becomes the client
// IP the adapter forwards upstream. A blanket `true` would make the adapter drop it,
// and Fastify 5 ignores a numeric hop count (it fails closed), so trust is a
// function. That trusts whatever the immediate peer is, which is only acceptable
// because the only peer here is the Docker gateway in front of this test app.
const app = Fastify({ trustProxy: (_address, hop) => hop < 1 });

// The React app (browser) calls the adapter cross-origin with credentials, so
// CORS must echo its origin and allow cookies. WEB_ORIGIN is the React app host.
await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  credentials: true,
});

app.get("/", async () => ({ ok: true }));
app.get("/__captured/:email", async (req) => captured.get(req.params.email) ?? null);

// The conformance contract's protected endpoint: the adapter's own guard, in both
// transports, so a spec can tell a session the app accepts from one it does not.
app.get(
  "/api/me",
  {
    preHandler: requireAuth({
      cookieSecret: process.env.COOKIE_SIGNING_KEY,
      authServerUrl: process.env.AUTH_SERVER_URL,
      authServerIssuer: ISSUER,
      audience: ISSUER,
    }),
  },
  async (req) => ({ id: req.user.id }),
);

// Registered under a prefix, which is how the plugin scopes its cookie and origin
// hooks. @fastify/cookie comes with the plugin, so it is not registered here.
// There is no `issuer` option on this adapter (the Express one takes one); the
// audience is what both check the API's tokens against.
await app.register(seamlessAuth, {
  prefix: "/auth",
  authServerUrl: process.env.AUTH_SERVER_URL,
  cookieSecret: process.env.COOKIE_SIGNING_KEY,
  serviceSecret: process.env.API_SERVICE_TOKEN,
  authServerIssuer: ISSUER,
  audience: ISSUER,
  jwksKid: process.env.JWKS_KID,
  messaging: { handlers, defaults: { appName: "Seamless Verify" } },
});

const port = Number(process.env.PORT ?? 3001);
// 0.0.0.0, not the Fastify default of localhost: the port is published out of the
// container, and a listener bound to loopback inside it is unreachable from the host.
await app.listen({ port, host: "0.0.0.0" });
console.log(`verify fastify adapter listening on :${port}`);
