import fs from "fs";
import path from "path";
import { VERSION } from "../../index.js";
import {
  SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE,
  SEAMLESS_AUTH_API_IMAGE,
} from "../../core/images.js";

export interface ManagedConfig {
  instanceUrl: string;
  applicationId: string;
  applicationName: string;
}

export function generateSeamlessConfig(
  root: string,
  options: {
    projectName?: string;
    webFramework: string;
    apiFramework: string;
    mobileFramework?: string;
    authMode: "local" | "docker" | "managed";
    adminMode: "api" | "image" | "source" | "none";
    managed?: ManagedConfig;
  },
) {
  const managed = options.authMode === "managed";

  const auth = managed
    ? {
        mode: "managed" as const,
        instanceUrl: options.managed?.instanceUrl ?? null,
        applicationId: options.managed?.applicationId ?? null,
        applicationName: options.managed?.applicationName ?? null,
        image: null,
        path: null,
      }
    : {
        mode: options.authMode,
        image: options.authMode === "docker" ? SEAMLESS_AUTH_API_IMAGE : null,
        path: options.authMode === "local" ? "./auth" : null,
      };

  // A managed instance hosts its own admin dashboard, so no admin service is
  // scaffolded locally.
  const admin = managed
    ? { mode: "hosted" as const, image: null, path: null, url: null }
    : {
        mode: options.adminMode,
        // API-served: the app API proxies the console at /console (no separate
        // image or checkout). Container modes carry an image or a source path.
        image:
          options.adminMode === "image"
            ? SEAMLESS_AUTH_ADMIN_DASHBOARD_IMAGE
            : null,
        path: options.adminMode === "source" ? "./admin" : null,
        url:
          options.adminMode === "api" ? "http://localhost:3000/console" : null,
      };

  const config = {
    version: VERSION,
    projectName: options.projectName || path.basename(root),
    createdAt: new Date().toISOString(),

    services: {
      web: {
        framework: options.webFramework,
        path: "./web",
      },
      api: {
        framework: options.apiFramework,
        path: "./api",
      },
      ...(options.mobileFramework
        ? { mobile: { framework: options.mobileFramework, path: "./mobile" } }
        : {}),
      auth,
      admin,
      database: {
        type: "postgres",
      },
    },

    // Managed projects have no local compose file; the auth stack runs remotely.
    docker: managed ? null : { composeFile: "docker-compose.yml" },
  };

  fs.writeFileSync(
    path.join(root, "seamless.config.json"),
    JSON.stringify(config, null, 2),
  );

  console.log("Seamless config created.");
}
