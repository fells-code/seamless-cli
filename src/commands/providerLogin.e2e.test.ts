import { spawn, type ChildProcess } from "child_process";
import { createHash, createHmac, X509Certificate } from "crypto";
import fs from "fs";
import { createRequire } from "module";
import { connect } from "tls";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Both sign-in paths of `seamless profile login` against a real API and edge: the real CLI,
// the real OS keychain, and Chromium with a virtual authenticator standing in for the system
// browser. Skipped unless SEAMLESS_PROVIDER_E2E_DIR names the `local/` directory of a running
// seamless-auth-oidc-provider recipe whose API has POST /sessions/exchange (API v0.23, or
// compose.api-source.yaml at that commit) and whose `npm ci` has installed Playwright:
//
//   npm run build
//   NODE_EXTRA_CA_CERTS=<dir>/.generated/ca.crt SEAMLESS_PROVIDER_E2E_DIR=<dir> \
//     npx vitest run src/commands/providerLogin.e2e.test.ts
//
// The tests run in order and share one account. TOTP codes are single use, so a run waits out
// several 30 second windows. It spends a good part of the 10 per 15 minutes OTP budget of
// flow_rate_limits, and the exchange route's limit on purpose at the end, so allow a fresh window
// between runs.
const DIR = process.env.SEAMLESS_PROVIDER_E2E_DIR;
const CLI = path.resolve("dist/index.js");
const SERVICE = "seamless-cli";
const LOOPBACK_PROFILE = "provider-e2e-loopback";
const DEVICE_PROFILE = "provider-e2e-device";
const EMAIL_PROFILE = "provider-e2e-email";
const EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const REFRESH_TYPE = "urn:ietf:params:oauth:token-type:refresh_token";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// A real terminal for the prompts, wide enough that they do not wrap.
const PTY_DRIVER = `import pty,sys
sys.exit(pty.spawn(["sh","-c",'stty cols 300 rows 50; exec "$@"',"sh"]+sys.argv[1:]) >> 8)`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;
type Context = any;

interface Recipe {
  issuer: string;
  apiUrl: string;
  mailboxOwner: string;
  nativeClientId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(what: string, check: () => T | undefined | null | false, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function base32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

const lastStep = new Map<string, number>();

// A code is single use, so a second one in the same window waits for the next.
async function freshTotp(secret: string): Promise<string> {
  const current = () => Math.floor(Date.now() / 30_000);
  const last = lastStep.get(secret);
  if (last !== undefined && current() <= last) {
    await sleep((last + 1) * 30_000 - Date.now() + 500);
  }
  const step = current();
  lastStep.set(secret, step);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

interface Run {
  proc: ChildProcess;
  output: () => string;
  done: Promise<number>;
  send: (text: string) => void;
}

describe.skipIf(!DIR)("seamless profile login through the OpenID Provider", () => {
  let recipe: Recipe;
  let seedState: { ownerTotpSecret: string; lastTotpStep?: number };
  let scratch: string;
  let urlFile: string;
  let clientId: string;
  let ownerToken = "";
  let browser: any;
  let context: Context;
  let page: Page;
  let keyring: typeof import("@napi-rs/keyring");
  let totpSecret = "";
  let userId = "";
  const email = `cli+${Date.now()}@clilogin.localhost`;
  const shots = (name: string) => path.join(DIR as string, ".generated", "cli-e2e", `${name}.png`);

  const instance = () => recipe.apiUrl;

  async function api(
    method: string,
    route: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${instance()}${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  }

  async function must(method: string, route: string, opts: { token?: string; body?: unknown } = {}) {
    const res = await api(method, route, opts);
    if (res.status >= 300) {
      throw new Error(`${method} ${route}: ${res.status} ${JSON.stringify(res.json)}`);
    }
    return res.json;
  }

  const mailbox = () =>
    `http://127.0.0.1:${/MAILBOX_PORT=(\d+)/.exec(fs.readFileSync(path.join(DIR as string, "settings.env"), "utf8"))?.[1]}`;

  async function codesFor(address: string): Promise<string[]> {
    return (await fetch(`${mailbox()}/codes/${encodeURIComponent(address)}`)).json() as Promise<string[]>;
  }

  async function nextCode(address: string, before: number): Promise<string> {
    for (let i = 0; i < 80; i += 1) {
      const all = await codesFor(address);
      if (all.length > before) return all.at(-1) as string;
      await sleep(250);
    }
    throw new Error(`no code reached the mailbox for ${address}`);
  }

  async function signInOwner(): Promise<string> {
    const owner = recipe.mailboxOwner;
    const before = (await codesFor(owner)).length;
    const started = await must("POST", "/login", { body: { identifier: owner } });
    await must("GET", "/otp/generate-login-email-otp", { token: started.token });
    const done = await must("POST", "/otp/verify-login-email-otp", {
      token: started.token,
      body: { verificationToken: await nextCode(owner, before) },
    });
    await must("POST", "/totp/verify-mfa", {
      token: done.token,
      body: { code: await freshTotp(seedState.ownerTotpSecret) },
    });
    return done.token;
  }

  function cli(args: string[], opts: { env?: NodeJS.ProcessEnv; pty?: boolean } = {}): Run {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: scratch,
      BROWSER: path.join(scratch, "capture-url"),
      URL_FILE: urlFile,
      NO_COLOR: "1",
      TERM: "xterm",
      ...opts.env,
    };
    const proc = opts.pty
      ? spawn("python3", ["-c", PTY_DRIVER, process.execPath, CLI, ...args], { env, stdio: "pipe" })
      : spawn(process.execPath, [CLI, ...args], { env, stdio: "pipe" });
    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString()));
    proc.stderr?.on("data", (d) => (out += d.toString()));
    const done = new Promise<number>((resolve) => proc.on("close", (code) => resolve(code ?? 1)));
    if (!opts.pty) proc.stdin?.end();
    return { proc, output: () => out, done, send: (text) => proc.stdin?.write(text) };
  }

  async function finished(run: Run, ms = 60_000): Promise<number> {
    const timer = setTimeout(() => run.proc.kill(), ms);
    const code = await run.done;
    clearTimeout(timer);
    return code;
  }

  async function ran(args: string[], opts: { env?: NodeJS.ProcessEnv; pty?: boolean } = {}) {
    const run = cli(args, opts);
    const code = await finished(run);
    return { code, output: run.output() };
  }

  const account = (profile: string) => `${profile}::${instance()}`;

  function stored(profile: string): Record<string, unknown> {
    const raw = new keyring.Entry(SERVICE, account(profile)).getPassword();
    return JSON.parse(raw as string);
  }

  function setStored(profile: string, value: unknown): void {
    new keyring.Entry(SERVICE, account(profile)).setPassword(JSON.stringify(value));
  }

  // Refreshing is how a client loses a step-up: the new row does not carry it.
  async function dropStepUp(profile: string): Promise<void> {
    const tokens = stored(profile);
    const res = await fetch(`${instance()}/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.refreshToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    setStored(profile, { ...tokens, accessToken: body.token, refreshToken: body.refreshToken });
  }

  function takeUrls(): string[] {
    if (!fs.existsSync(urlFile)) return [];
    const urls = fs.readFileSync(urlFile, "utf8").split("\n").filter(Boolean);
    fs.rmSync(urlFile);
    return urls;
  }

  async function nextAuthorizeUrl(): Promise<URL> {
    const url = await until("the CLI to open a browser", () => takeUrls()[0]);
    return new URL(url);
  }

  async function dump(label: string): Promise<string> {
    await page.screenshot({ path: shots(`failure-${label}`) }).catch(() => {});
    const tree = await page.locator("body").ariaSnapshot().catch(() => "");
    return `${label} at ${page.url()}\n${tree}`;
  }

  async function register(address: string): Promise<void> {
    await page.getByRole("heading", { level: 2 }).first().waitFor({ timeout: 15_000 });
    await page.getByLabel(/email address/i).first().fill(address);
    const before = (await codesFor(address)).length;
    await page.getByRole("button", { name: /^register$/i }).click();
    await page.waitForURL(/verify-email-otp/);
    const code = await nextCode(address, before);
    const inputs = page.locator("input");
    if ((await inputs.count()) >= 6) {
      for (let i = 0; i < 6; i += 1) await inputs.nth(i).fill(code[i]);
    } else {
      await inputs.first().fill(code);
    }
    const verify = page.getByRole("button", { name: /verify|continue|submit/i });
    if (await verify.count()) await verify.first().click().catch(() => {});
    await page.waitForURL(/register-passkey/, { timeout: 20_000 });
    await page.getByRole("button", { name: /register|add|create|continue/i }).first().click();
    const modal = page.getByRole("button", { name: /^continue$/i });
    await modal.waitFor({ timeout: 5000 }).then(() => modal.click()).catch(() => {});
    await page.waitForURL(/recovery-codes|consent|confirm|interaction|127\.0\.0\.1/, { timeout: 20_000 }).catch(() => {});
    if (page.url().includes("recovery-codes")) {
      await page.getByLabel(/i have saved/i).check();
      await page.getByRole("button", { name: /^continue$/i }).click();
    }
  }

  async function signInWithPasskey(address: string): Promise<void> {
    await page.getByRole("heading", { level: 2 }).first().waitFor({ timeout: 15_000 });
    const toSignIn = page.getByRole("button", { name: /already have an account/i });
    if (await toSignIn.count()) await toSignIn.click();
    await page.getByLabel(/email address \/ phone number/i).fill(address);
    await page.getByRole("button", { name: /^login$/i }).click();
    const passkey = page.getByRole("button", { name: /passkey/i }).first();
    await passkey.waitFor({ timeout: 5000 }).then(() => passkey.click()).catch(() => {});
  }

  /** The X8 screen every browser sign-in for this client has to pass. */
  async function confirmSignIn(label: string): Promise<string> {
    const heading = page.getByRole("heading", { name: /^Continue to / });
    await heading.waitFor({ timeout: 30_000 });
    const text = await page.locator("main, body").first().innerText();
    await page.screenshot({ path: shots(`confirm-${label}`) });
    await page.getByRole("button", { name: /^Continue to / }).click();
    await page.getByText(/close this tab/).waitFor({ timeout: 15_000 });
    return text;
  }

  async function stepUpInLiveBrowser(run: Run): Promise<void> {
    const authorize = await nextAuthorizeUrl();
    try {
      await page.goto(authorize.href);
      const asked = page.getByRole("heading", { name: /confirm it is you/i });
      await asked.or(page.getByRole("heading", { name: /^Continue to / })).waitFor({ timeout: 15_000 });
      // Within the same second as the last authentication, max_age=0 is already met, and the
      // new session copies the browser's step-up instead (X5).
      if (await asked.isVisible()) {
        await page.screenshot({ path: shots("step-up-page") });
        await page.getByRole("button", { name: /passkey/i }).first().click();
      }
      await confirmSignIn("step-up-live");
    } catch (err) {
      throw new Error(`${(err as Error).message}\n${await dump("step-up-live")}\n${run.output()}`);
    }
  }

  beforeAll(async () => {
    if (!DIR) return;
    const generated = (name: string) => path.join(DIR, ".generated", name);
    recipe = JSON.parse(fs.readFileSync(generated("recipe.json"), "utf8"));
    seedState = JSON.parse(fs.readFileSync(generated("seed-state.json"), "utf8"));
    if (seedState.lastTotpStep) lastStep.set(seedState.ownerTotpSecret, seedState.lastTotpStep);
    fs.mkdirSync(generated("cli-e2e"), { recursive: true });

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "seamless-provider-e2e-"));
    urlFile = path.join(scratch, "urls");
    const capture = path.join(scratch, "capture-url");
    fs.writeFileSync(capture, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$URL_FILE"\n', { mode: 0o755 });

    keyring = await import("@napi-rs/keyring");

    ownerToken = await signInOwner();
    const created = await must("POST", "/admin/applications", {
      token: ownerToken,
      body: {
        name: `Seamless CLI ${Date.now()}`,
        clientType: "public",
        firstParty: true,
        tokenEndpointAuthMethod: "none",
        redirectUris: ["http://127.0.0.1/callback"],
        grantTypes: ["authorization_code"],
        deviceFlowEnabled: true,
        sessionExchangeEnabled: true,
      },
    });
    clientId = created.application.id;

    const issuer = new URL(recipe.issuer);
    const spki = await new Promise<string>((resolve, reject) => {
      const socket = connect(
        {
          host: "127.0.0.1",
          port: Number(issuer.port),
          servername: issuer.hostname,
          ca: fs.readFileSync(generated("ca.crt"), "utf8"),
        },
        () => {
          const der = new X509Certificate(socket.getPeerCertificate().raw).publicKey.export({
            type: "spki",
            format: "der",
          });
          socket.end();
          resolve(createHash("sha256").update(der).digest("base64"));
        },
      );
      socket.on("error", reject);
    });

    const { chromium } = createRequire(path.join(DIR, "package.json"))("playwright");
    browser = await chromium.launch({
      args: [`--ignore-certificate-errors-spki-list=${spki}`],
    });
    context = await browser.newContext();
    page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (!DIR) return;
    await browser?.close();
    for (const profile of [LOOPBACK_PROFILE, DEVICE_PROFILE, EMAIL_PROFILE]) {
      try {
        new keyring.Entry(SERVICE, account(profile)).deletePassword();
      } catch {
        // Not every run gets far enough to create all three.
      }
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("does not need session:exchange in scopes_supported, which is absent", async () => {
    const res = await fetch(`${recipe.issuer}/.well-known/openid-configuration`);
    const doc = (await res.json()) as { scopes_supported: string[] };
    expect(doc.scopes_supported).not.toContain("session:exchange");
  });

  it("needs a loopback or private-use redirect even for a client used only with --device", async () => {
    const res = await api("POST", "/admin/applications", {
      token: ownerToken,
      body: {
        name: `Device only ${Date.now()}`,
        clientType: "public",
        firstParty: true,
        tokenEndpointAuthMethod: "none",
        redirectUris: [],
        grantTypes: [],
        deviceFlowEnabled: true,
        sessionExchangeEnabled: true,
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
  }, 60_000);

  it("falls back to the email code on a profile with no provider", async () => {
    await ran(["profile", "add", EMAIL_PROFILE, "--instance-url", instance()]);
    const { output, code } = await ran([
      "profile", "login", EMAIL_PROFILE, "--device", "--identifier", recipe.mailboxOwner,
    ]);
    expect(output).toMatch(/Using an email code/);
    expect(output).toMatch(/a code is on its way/);
    // The next step is typing the code, which this run has no terminal for.
    expect(output).toMatch(/needs an interactive terminal/);
    expect(code).not.toBe(0);
    expect(takeUrls()).toEqual([]);
  }, 60_000);

  it("signs in through the browser: register a passkey, confirm, exchange, keychain", async () => {
    await ran(["profile", "add", LOOPBACK_PROFILE, "--instance-url", instance()]);
    const run = cli([
      "profile", "login", LOOPBACK_PROFILE,
      "--oidc-issuer", recipe.issuer,
      "--client-id", clientId,
    ]);
    const authorize = await nextAuthorizeUrl();
    expect(run.output()).toContain("Continue to");
    expect(authorize.searchParams.get("scope")).toBe("openid session:exchange");
    expect(authorize.searchParams.get("resource")).toBe(`${recipe.issuer}/seamless`);
    expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    try {
      await page.goto(authorize.href);
      await register(email);
      const confirmation = await confirmSignIn("register");
      expect(confirmation).toContain(email);
    } catch (err) {
      throw new Error(`${(err as Error).message}\n${await dump("register")}\n${run.output()}`);
    }

    expect(await finished(run)).toBe(0);
    expect(run.output()).toContain(`as ${email}`);

    const tokens = stored(LOOPBACK_PROFILE);
    expect(Object.keys(tokens).sort()).toEqual([
      "accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt", "signIn",
    ]);
    expect(tokens.signIn).toBe("loopback");
    const [header, payload] = String(tokens.accessToken).split(".").slice(0, 2).map(
      (part) => JSON.parse(Buffer.from(part, "base64url").toString()),
    );
    expect(header.typ).not.toBe("at+jwt");
    expect(payload.iss).not.toBe(recipe.issuer);

    const config = JSON.parse(fs.readFileSync(path.join(scratch, "seamless", "config.json"), "utf8"));
    expect(config.profiles[LOOPBACK_PROFILE]).toMatchObject({
      oidcIssuer: recipe.issuer,
      oidcClientId: clientId,
      email,
    });
    expect(JSON.stringify(config)).not.toContain(String(tokens.refreshToken));

    const whoami = await ran(["whoami", "--profile", LOOPBACK_PROFILE, "--json"]);
    expect(whoami.code).toBe(0);
    expect(whoami.output).toContain(email);
    userId = JSON.parse(whoami.output).sub;

    const { sessions } = await must("GET", "/sessions", { token: tokens.accessToken as string });
    const current = sessions.find((s: { current: boolean }) => s.current);
    expect(current.exchangeGrantType).toBe("authorization_code");
    expect(current.exchangeClientId).toBe(clientId);
    expect(current.parentSessionId).toBeTruthy();
  }, 120_000);

  it("signs in with the passkey, on a browser with no session", async () => {
    await context.clearCookies();
    const run = cli(["profile", "login", LOOPBACK_PROFILE]);
    const authorize = await nextAuthorizeUrl();
    try {
      await page.goto(authorize.href);
      await signInWithPasskey(email);
      await confirmSignIn("passkey");
    } catch (err) {
      throw new Error(`${(err as Error).message}\n${await dump("passkey")}\n${run.output()}`);
    }
    expect(await finished(run)).toBe(0);
    const whoami = await ran(["whoami", "--profile", LOOPBACK_PROFILE, "--json"]);
    expect(JSON.parse(whoami.output).sub).toBe(userId);
  }, 120_000);

  it("shows the confirmation even with a live browser session (X8)", async () => {
    const run = cli(["profile", "login", LOOPBACK_PROFILE]);
    const authorize = await nextAuthorizeUrl();
    await page.goto(authorize.href);
    const confirmation = await confirmSignIn("live-session");
    expect(confirmation).toContain(email);
    expect(await finished(run)).toBe(0);
  }, 60_000);

  it("grants the account admin, so admin commands have something to refuse", async () => {
    await must("PATCH", `/admin/users/${userId}`, { token: ownerToken, body: { roles: ["user", "admin"] } });
    const users = await ran(["users", "list", "--profile", LOOPBACK_PROFILE, "--json"]);
    expect(users.code, users.output).toBe(0);
    expect(users.output).toContain(email);
  }, 90_000);

  it("a passkey step-up from a browser with no session is a sign-in, says so, and works the second time", async () => {
    await context.clearCookies();
    await dropStepUp(LOOPBACK_PROFILE);
    const old = stored(LOOPBACK_PROFILE);

    const first = cli(["config", "set", "app_name", "e2e", "--profile", LOOPBACK_PROFILE], { pty: true });
    const authorize = await nextAuthorizeUrl();
    expect(authorize.searchParams.get("acr_values")).toBe("phr");
    expect(authorize.searchParams.get("max_age")).toBe("0");
    try {
      await page.goto(authorize.href);
      await signInWithPasskey(email);
      await confirmSignIn("step-up-no-session");
    } catch (err) {
      throw new Error(`${(err as Error).message}\n${await dump("step-up")}\n${first.output()}`);
    }
    expect(await finished(first), first.output()).not.toBe(0);
    expect(first.output().replace(/\s+/g, " ")).toMatch(/recorded a sign-in and not a step-up/);

    // The refused run still swapped the session, and the old one is gone.
    const swapped = stored(LOOPBACK_PROFILE);
    expect(swapped.signIn).toBe("loopback");
    expect(swapped.refreshToken).not.toBe(old.refreshToken);
    expect((await api("GET", "/users/me", { token: old.accessToken as string })).status).toBe(401);

    const second = cli(["config", "set", "app_name", "e2e", "--profile", LOOPBACK_PROFILE], { pty: true });
    await stepUpInLiveBrowser(second);
    expect(await finished(second), second.output()).toBe(0);
    expect(stored(LOOPBACK_PROFILE).refreshToken).not.toBe(swapped.refreshToken);
  }, 180_000);

  it("a passkey step-up with a browser session younger than the five minute window", async () => {
    await dropStepUp(LOOPBACK_PROFILE);
    const run = cli(["config", "set", "app_name", "e2e", "--profile", LOOPBACK_PROFILE], { pty: true });
    await stepUpInLiveBrowser(run);
    expect(await finished(run), run.output()).toBe(0);
  }, 120_000);

  it("a device session with no TOTP says why and sends the user to a browser", async () => {
    await context.clearCookies();
    await ran(["profile", "add", DEVICE_PROFILE, "--instance-url", instance(),
      "--oidc-issuer", recipe.issuer, "--client-id", clientId]);
    await deviceSignIn("device-no-totp");

    const whoami = await ran(["whoami", "--profile", DEVICE_PROFILE, "--json"]);
    expect(whoami.code, whoami.output).toBe(0);

    for (const args of [["users", "list"], ["config", "get"], ["org", "list"]]) {
      const res = await ran([...args, "--profile", DEVICE_PROFILE], { pty: true });
      expect(res.code, res.output).not.toBe(0);
      expect(res.output).toMatch(/device code/);
      expect(res.output).toMatch(/cannot enroll/);
      expect(res.output).toMatch(/browser/);
      expect(res.output).not.toMatch(/step_up_required/);
      expect(res.output).not.toMatch(/passkey/i);
    }

    const enrollment = await api("POST", "/totp/enroll/start", {
      token: stored(DEVICE_PROFILE).accessToken as string,
    });
    expect(enrollment.status).toBe(403);
    expect(enrollment.json.error).toBe("step_up_required");
  }, 120_000);

  // The provider asks first, then signs the browser in if it needs to.
  async function approveDeviceCode(userCode: string, label: string): Promise<void> {
    await page.getByRole("textbox").first().fill(userCode);
    await page.getByRole("button", { name: /continue|submit|next|verify/i }).first().click();
    const approve = page.getByRole("button", { name: /^continue$/i }).first();
    await page.getByText(/wants to sign in on a device/).waitFor({ timeout: 20_000 });
    await page.screenshot({ path: shots(`device-confirm-${label}`) });
    await approve.click();
    const done = page.getByText(/your device is signed in/i).first();
    const login = page.getByLabel(/email address/i).first();
    await done.or(login).waitFor({ timeout: 20_000 });
    if (await login.isVisible()) await signInWithPasskey(email);
    await done.waitFor({ timeout: 20_000 });
    await page.screenshot({ path: shots(`device-done-${label}`) });
  }

  async function deviceSignIn(label: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
    const run = cli(["profile", "login", DEVICE_PROFILE, "--device"], {
      env: { SSH_CONNECTION: "203.0.113.1 50000 203.0.113.2 22", DISPLAY: "", ...env },
    });
    const output = await until("the device code", () => {
      const out = run.output();
      return /enter this code:\s+(\S+)/.test(out) ? out : undefined;
    });
    const verification = /open:\s+(https:\S+)/.exec(output)?.[1] as string;
    const userCode = /enter this code:\s+(\S+)/.exec(output)?.[1] as string;
    expect(takeUrls()).toEqual([]);

    try {
      await page.goto(verification);
      await page.screenshot({ path: shots(`device-input-${label}`) });
      await approveDeviceCode(userCode, label);
    } catch (err) {
      throw new Error(`${(err as Error).message}\n${await dump(`device-${label}`)}\n${run.output()}`);
    }

    const code = await finished(run);
    expect(code, run.output()).toBe(0);
    const tokens = stored(DEVICE_PROFILE);
    expect(tokens.signIn).toBe("device");
    const { sessions } = await must("GET", "/sessions", { token: tokens.accessToken as string });
    expect(sessions.find((s: { current: boolean }) => s.current).exchangeGrantType).toBe(DEVICE_GRANT);
  }

  it("a loopback session enrolls TOTP, and then offers both ways to step up", async () => {
    await context.clearCookies();
    const tokens = stored(LOOPBACK_PROFILE);
    const started = await must("POST", "/totp/enroll/start", { token: tokens.accessToken as string });
    totpSecret = started.secret;
    await must("POST", "/totp/enroll/verify", {
      token: tokens.accessToken as string,
      body: { code: await freshTotp(totpSecret) },
    });

    await dropStepUp(LOOPBACK_PROFILE);
    const run = cli(["config", "set", "app_name", "e2e", "--profile", LOOPBACK_PROFILE], { pty: true });
    await until("the choice", () => /How do you want to do it/.test(run.output()));
    expect(run.output()).toMatch(/passkey/);
    expect(run.output()).toMatch(/authenticator app/);
    run.send("\u001b[B\r");
    await until("the code prompt", () => /Enter the code from your authenticator app/.test(run.output()));
    run.send(`${await freshTotp(totpSecret)}\r`);
    const code = await finished(run);
    expect(code, run.output()).toBe(0);
    expect(takeUrls()).toEqual([]);
  }, 120_000);

  it("a device session asks for TOTP on admin reads, org commands and config, with SEAMLESS_TOTP_CODE or a prompt", async () => {
    await deviceSignIn("device-totp");

    const refused = await ran(["users", "list", "--profile", DEVICE_PROFILE]);
    expect(refused.code).not.toBe(0);
    expect(refused.output).toMatch(/device code/);
    expect(refused.output).toMatch(/SEAMLESS_TOTP_CODE/);
    expect(refused.output).not.toMatch(/step_up_required/);

    const withCode = await ran(["users", "list", "--profile", DEVICE_PROFILE, "--json"], {
      env: { SEAMLESS_TOTP_CODE: await freshTotp(totpSecret) },
    });
    expect(withCode.code, withCode.output).toBe(0);
    expect(withCode.output).toContain(email);

    // Inside the window nothing asks again.
    const org = await ran(["org", "list", "--profile", DEVICE_PROFILE]);
    expect(org.code, org.output).toBe(0);
    const config = await ran(["config", "get", "--profile", DEVICE_PROFILE]);
    expect(config.code, config.output).toBe(0);
  }, 120_000);

  it("a refresh drops the step-up, so a device session asks again, and offers no passkey", async () => {
    await dropStepUp(DEVICE_PROFILE);
    const run = cli(["org", "list", "--profile", DEVICE_PROFILE], { pty: true });
    await until("the code prompt", () => /Enter the code from your authenticator app/.test(run.output()));
    expect(run.output()).toMatch(/device code/);
    expect(run.output()).not.toMatch(/passkey/i);
    run.send(`${await freshTotp(totpSecret)}\r`);
    const code = await finished(run);
    expect(code, run.output()).toBe(0);
    expect(takeUrls()).toEqual([]);
  }, 120_000);

  it("session revocation and logout need no step-up on a device session", async () => {
    await dropStepUp(DEVICE_PROFILE);
    const tokens = stored(DEVICE_PROFILE);
    const list = await must("GET", "/sessions", { token: tokens.accessToken as string });
    const other = list.sessions.find((s: { current: boolean }) => !s.current);
    expect(other).toBeTruthy();
    const revoke = await ran(["sessions", "revoke", other.id, "--profile", DEVICE_PROFILE]);
    expect(revoke.code, revoke.output).toBe(0);
    expect(revoke.output).not.toMatch(/authenticator app/);

    const logout = await ran(["logout", "--profile", DEVICE_PROFILE]);
    expect(logout.code, logout.output).toBe(0);
    expect(logout.output).not.toMatch(/authenticator app/);
    expect((await api("GET", "/users/me", { token: tokens.accessToken as string })).status).toBe(401);
  }, 90_000);

  it("the CLI's error path on a client without session exchange", async () => {
    await context.clearCookies();
    const run = cli([
      "profile", "login", EMAIL_PROFILE,
      "--oidc-issuer", recipe.issuer,
      "--client-id", recipe.nativeClientId,
      "--device",
    ]);
    const code = await finished(run);
    expect(code).not.toBe(0);
    expect(run.output()).toMatch(/refused/);
  }, 60_000);

  it("the browser path on a client without session exchange ends in a clear refusal", async () => {
    await context.clearCookies();
    const run = cli([
      "profile", "login", EMAIL_PROFILE,
      "--oidc-issuer", recipe.issuer,
      "--client-id", recipe.nativeClientId,
    ]);
    const authorize = await nextAuthorizeUrl();
    await page.goto(authorize.href);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: shots("client-without-exchange") });
    const code = await finished(run, 8_000);
    expect(code).not.toBe(0);
    expect(run.output()).toMatch(/refused/);
  }, 60_000);

  describe("the wire rules the CLI relies on", () => {
    async function subjectToken(): Promise<string> {
      // The device flow gives a token to this test rather than to the CLI.
      const form = (values: Record<string, string>) => ({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(values).toString(),
      });
      const started = (await (
        await fetch(`${recipe.issuer}/device/auth`, form({
          client_id: clientId,
          scope: "openid session:exchange",
          resource: `${recipe.issuer}/seamless`,
        }))
      ).json()) as { device_code: string; user_code: string; verification_uri: string };
      await page.goto(started.verification_uri);
      await approveDeviceCode(started.user_code, "wire");
      for (let i = 0; i < 20; i += 1) {
        const res = await fetch(`${recipe.issuer}/token`, form({
          client_id: clientId,
          grant_type: DEVICE_GRANT,
          device_code: started.device_code,
        }));
        const body = (await res.json()) as { access_token?: string; refresh_token?: string };
        if (body.access_token) {
          expect(body.refresh_token).toBeUndefined();
          return body.access_token;
        }
        await sleep(5500);
      }
      throw new Error("the device grant did not finish");
    }

    const exchangeBody = (subject: string) => ({
      grant_type: EXCHANGE_GRANT,
      subject_token: subject,
      subject_token_type: SUBJECT_TYPE,
      requested_token_type: REFRESH_TYPE,
    });

    it("refuses acr_values and max_age on the device request", async () => {
      const res = await fetch(`${recipe.issuer}/device/auth`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          scope: "openid session:exchange",
          resource: `${recipe.issuer}/seamless`,
          max_age: "300",
        }).toString(),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    });

    it("answers exactly invalid_request for a bad subject token, and for an extra field", async () => {
      const bad = await api("POST", "/sessions/exchange", { body: exchangeBody("not-a-token") });
      expect(bad.status).toBe(400);
      expect(bad.json).toEqual({ error: "invalid_request" });

      const extra = await api("POST", "/sessions/exchange", {
        body: { ...exchangeBody("not-a-token"), resource: "x" },
      });
      expect(extra.status).toBe(400);
      expect(extra.json.error).toBe("invalid_request");
    });

    it("revokes the session on a replay, and says token_already_used", async () => {
      const subject = await subjectToken();
      const first = await api("POST", "/sessions/exchange", { body: exchangeBody(subject) });
      expect(first.status, JSON.stringify(first.json)).toBe(200);
      expect(first.json.issued_token_type).toBe(REFRESH_TYPE);
      expect(first.json.refreshTtl).toBeLessThanOrEqual(86_400);

      const replay = await api("POST", "/sessions/exchange", { body: exchangeBody(subject) });
      expect(replay.status).toBe(400);
      expect(replay.json).toEqual({ error: "invalid_request", error_description: "token_already_used" });
      expect((await api("GET", "/users/me", { token: first.json.token })).status).toBe(401);
    }, 120_000);

    it("rate limits the route at 30 per address, which spends this run's budget", async () => {
      let limited: { status: number; json: unknown } | undefined;
      for (let i = 0; i < 40 && !limited; i += 1) {
        const res = await api("POST", "/sessions/exchange", { body: exchangeBody("x") });
        if (res.status === 429) limited = res;
      }
      expect(limited?.json).toEqual({ error: "Too many requests, please try again later" });
    }, 60_000);
  });
});
