import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import createSeamlessAuthServer, { requireAuth } from "@seamless-auth/express";

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

const app = express();
// One trusted hop, so each conformance actor's X-Forwarded-For becomes the client
// IP the adapter forwards upstream. A blanket `true` would make the adapter drop it.
app.set("trust proxy", 1);
// The React app (browser) calls the adapter cross-origin with credentials, so
// CORS must echo its origin and allow cookies. WEB_ORIGIN is the React app host.
app.use(
  cors({
    origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

app.get("/", (_req, res) => res.json({ ok: true }));
app.get("/__captured/:email", (req, res) =>
  res.json(captured.get(req.params.email) ?? null),
);

// The conformance contract's protected endpoint: the adapter's own guard, in both
// transports, so a spec can tell a session the app accepts from one it does not.
app.get(
  "/api/me",
  requireAuth({
    cookieSecret: process.env.COOKIE_SIGNING_KEY,
    authServerUrl: process.env.AUTH_SERVER_URL,
    authServerIssuer: ISSUER,
    audience: ISSUER,
  }),
  (req, res) => res.json({ id: req.user.id }),
);

app.use(
  "/auth",
  createSeamlessAuthServer({
    authServerUrl: process.env.AUTH_SERVER_URL,
    cookieSecret: process.env.COOKIE_SIGNING_KEY,
    serviceSecret: process.env.API_SERVICE_TOKEN,
    issuer: process.env.APP_ORIGIN,
    authServerIssuer: ISSUER,
    audience: ISSUER,
    jwksKid: process.env.JWKS_KID,
    messaging: { handlers, defaults: { appName: "Seamless Verify" } },
  }),
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`verify adapter listening on :${port}`));
