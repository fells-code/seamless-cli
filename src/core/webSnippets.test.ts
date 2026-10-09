import path from "path";
import { describe, expect, it } from "vitest";

import type { DetectedWeb } from "./detect.js";
import {
  webApiUrlVariable,
  webFrameworkName,
  webPackages,
  webStepFile,
  webSteps,
} from "./webSnippets.js";

const web = (overrides: Partial<DetectedWeb>): DetectedWeb => ({
  framework: "react",
  bundler: "vite",
  dir: "web",
  typescript: true,
  missingPeers: [],
  packageManager: "npm",
  ...overrides,
});
const api = { apiOrigin: "http://localhost:3000" };
const code = (w: DetectedWeb) => webSteps(w, api).map((s) => s.code).join("\n");

describe("React", () => {
  it("reads the API URL the way the bundler exposes it", () => {
    expect(webApiUrlVariable(web({ bundler: "vite" }))).toBe("VITE_API_URL");
    expect(code(web({ bundler: "vite" }))).toContain("import.meta.env.VITE_API_URL");
    expect(webApiUrlVariable(web({ bundler: "react-scripts" }))).toBe("REACT_APP_API_URL");
    expect(code(web({ bundler: "react-scripts" }))).toContain("process.env.REACT_APP_API_URL");
  });

  it("is one step at the app's entry", () => {
    const steps = webSteps(web({ entry: "src/main.tsx" }), api);
    expect(steps.map((s) => s.heading)).toEqual(["Wrap your React app"]);
    expect(webStepFile(web({}), steps[0])).toBe(path.join("web", "src/main.tsx"));
    expect(webPackages(web({}))).toEqual(["@seamless-auth/react"]);
  });
});

describe("Angular", () => {
  const angular = web({ framework: "angular", bundler: "angular", entry: "src/app/app.config.ts" });

  it("has no .env variable, so the backend URL goes in the code", () => {
    expect(webApiUrlVariable(angular)).toBeUndefined();
    expect(code(angular)).toContain('provideSeamlessAuth({ apiHost: "http://localhost:3000" })');
  });

  it("provides the binding and its interceptor, then guards the routes", () => {
    const steps = webSteps(angular, api);
    expect(steps.map((s) => s.file)).toEqual(["src/app/app.config.ts", "src/app/app.routes.ts"]);
    expect(steps[0].code).toContain("provideHttpClient(withInterceptors([seamlessAuthInterceptor]))");
    expect(steps[1].code).toContain('from "@seamless-auth/angular/routes"');
    expect(steps[1].code).toContain("canActivate: [guestGuard]");
    expect(steps[1].code).toContain("canActivate: [authGuard]");
  });

  it("installs the binding and the router when the app has none", () => {
    expect(webPackages({ ...angular, missingPeers: ["@angular/router"] })).toEqual([
      "@seamless-auth/angular",
      "@angular/router",
    ]);
  });
});

describe("Vue", () => {
  const vue = web({ framework: "vue", entry: "src/main.ts", router: "src/router/index.ts" });

  it("adds routes in the router file and the plugin in the entry", () => {
    const steps = webSteps(vue, api);
    expect(steps.map((s) => s.file)).toEqual(["src/router/index.ts", "src/main.ts"]);
    expect(steps[0].code).toContain("...createSeamlessAuthRoutes().map(");
    expect(steps[0].code).not.toContain("createRouter({");
    expect(steps[1].code).toContain("app.use(createSeamlessAuth({ apiHost: import.meta.env.VITE_API_URL }));");
    expect(webApiUrlVariable(vue)).toBe("VITE_API_URL");
  });

  it("uses the entry for the routes when the router is created there", () => {
    expect(webSteps({ ...vue, router: undefined }, api)[0].file).toBe("src/main.ts");
  });

  it("prints a whole router, and installs vue-router, for an app without one", () => {
    const bare = { ...vue, router: undefined, missingPeers: ["vue-router"] };
    const steps = webSteps(bare, api);
    expect(steps).toHaveLength(1);
    expect(steps[0].code).toContain('import { createRouter, createWebHistory } from "vue-router";');
    expect(steps[0].code).toContain(".use(createSeamlessAuth({ apiHost: import.meta.env.VITE_API_URL }))");
    expect(steps[0].code).toContain("<RouterView />");
    expect(webPackages(bare)).toEqual(["@seamless-auth/vue", "vue-router"]);
  });
});

describe("SvelteKit", () => {
  const kit = web({ framework: "sveltekit", libAlias: "#lib" });

  it("imports the session the way the Kit version maps src/lib", () => {
    expect(code(kit)).toContain('import { auth } from "#lib/auth.js";');
    expect(code({ ...kit, libAlias: "$lib" })).toContain('import { auth } from "$lib/auth";');
  });

  it("creates the session, renders in the browser, and mounts each screen", () => {
    const steps = webSteps(kit, api);
    expect(steps.map((s) => s.file)).toEqual(["src/lib/auth.ts", undefined, undefined]);
    expect(steps[0].code).toContain("createSeamlessAuth({ apiHost: import.meta.env.VITE_API_URL })");
    expect(steps[1].code).toContain("export const ssr = false;");
    expect(steps[1].code).toContain("setAuthNavigator(createKitNavigator(auth));");
    expect(steps[2].code).toContain("<SaLogin />");
    expect(steps[2].code).toContain('verify-email-otp/+page.svelte  <SaVerifyOtp channel="email" />');
    expect(steps[2].code).toContain("export const load = requireAuth(auth);");
    expect(steps[2].code).toContain("export const load = requireGuest(auth);");
    expect(webPackages(kit)).toEqual(["@seamless-auth/svelte"]);
  });

  it("prints JavaScript for a JavaScript app", () => {
    const js = { ...kit, typescript: false };
    expect(webSteps(js, api)[0].file).toBe("src/lib/auth.js");
    expect(code(js)).not.toContain('lang="ts"');
    expect(code(js)).toContain("+page.js or +layout.js");
  });
});

it("names each framework", () => {
  expect(webFrameworkName("sveltekit")).toBe("SvelteKit");
  expect(webFrameworkName("vue")).toBe("Vue");
});
