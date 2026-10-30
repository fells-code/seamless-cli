import fs from "fs";
import path from "path";

import { readCommand, runCommand } from "../../core/exec.js";
import {
  SEAMLESS_AUTH_API_COMMIT,
  SEAMLESS_AUTH_API_VERSION,
} from "../../core/images.js";
import { configureAuthLocalEnv } from "../docker/docker.js";
import type { CollectedOAuthProvider } from "../../core/oauthProviders.js";
import type { AdminMode } from "../docker/docker.js";

const AUTH_REPO = "https://github.com/fells-code/seamless-auth-api";

export async function generateAuthServer(
  root: string,
  oauth: CollectedOAuthProvider[] = [],
  adminMode: AdminMode = "api",
  ownerEmail?: string,
  fullStack = false,
) {
  console.log("Cloning SeamlessAuth server...");

  await runCommand(
    "git",
    ["clone", "--branch", SEAMLESS_AUTH_API_VERSION, AUTH_REPO, "auth"],
    root,
  );
  await verifyAuthCommit(root);

  console.log("Writing auth environment...");

  const shared = await configureAuthLocalEnv(
    root,
    oauth,
    adminMode,
    ownerEmail,
    fullStack,
  );

  console.log("Auth server ready in /auth");
  return shared;
}

// The clone is built and run on the developer's machine, so a tag that has been
// moved must stop the scaffold before anything in it executes.
async function verifyAuthCommit(root: string): Promise<void> {
  const dir = path.join(root, "auth");
  const head = await readCommand("git", ["rev-parse", "HEAD"], dir);
  if (head === SEAMLESS_AUTH_API_COMMIT) return;

  fs.rmSync(dir, { recursive: true, force: true });
  throw new Error(
    `seamless-auth-api ${SEAMLESS_AUTH_API_VERSION} resolved to commit ${head || "(unknown)"}, but this CLI pins it to ${SEAMLESS_AUTH_API_COMMIT}. The tag may have been moved, so the clone was removed and nothing in it was run. Re-run with --auth=docker, or update the CLI.`,
  );
}
