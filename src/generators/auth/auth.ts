import { runCommand } from "../../core/exec.js";
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

  await runCommand("git", ["clone", AUTH_REPO, "auth"], root);

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
