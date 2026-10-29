// Gives the e2e owner an authenticator app, so the CLI's admin step-up can be driven
// against a real auth server.
//
//   node scripts/e2e-authenticator.mjs enroll <state-file>
//     Enrolls TOTP on the active profile's session and keeps the secret in the file.
//   node scripts/e2e-authenticator.mjs code <state-file>
//     Prints a code from a time step no earlier code used. The server refuses a code
//     that was already accepted, so this waits for the next step when it has to.
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { createAuthClient } from "../dist/core/authClient.js";

const [command, stateFile] = process.argv.slice(2);
if (!["enroll", "code"].includes(command) || !stateFile) {
  console.error("usage: e2e-authenticator.mjs <enroll|code> <state-file>");
  process.exit(2);
}

function base32(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("The TOTP secret is not base32.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function totp({ secret, algorithm, digits, period }, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac(algorithm.toLowerCase(), base32(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(value).padStart(digits, "0");
}

async function freshCode(state) {
  let step = Math.floor(Date.now() / 1000 / state.period);
  if (state.lastStep !== undefined && step <= state.lastStep) {
    const waitMs = (state.lastStep + 1) * state.period * 1000 - Date.now() + 250;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    step = state.lastStep + 1;
  }
  writeFileSync(stateFile, JSON.stringify({ ...state, lastStep: step }));
  return totp(state, step);
}

if (command === "enroll") {
  const client = await createAuthClient();
  const start = await client.post("/totp/enroll/start", {});
  if (!start.ok) throw new Error(`/totp/enroll/start answered ${start.status}.`);
  const { secret, algorithm, digits, period } = start.data;
  const state = { secret, algorithm, digits, period };
  writeFileSync(stateFile, JSON.stringify(state));

  const verify = await client.post("/totp/enroll/verify", { code: await freshCode(state) });
  if (!verify.ok) throw new Error(`/totp/enroll/verify answered ${verify.status}.`);
} else {
  process.stdout.write(`${await freshCode(JSON.parse(readFileSync(stateFile, "utf8")))}\n`);
}
