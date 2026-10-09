import path from "path";

import type { DetectedWeb, WebFramework } from "./detect.js";

// What `seamless add` prints for the web app, one step per file to change. Each
// follows the binding's README and the verify app built on it (verify/*-app).

export interface WebStep {
  heading: string;
  // The file the step changes, relative to the web app's folder, when known.
  file?: string;
  code: string;
}

const NAMES: Record<WebFramework, string> = {
  react: "React",
  angular: "Angular",
  vue: "Vue",
  sveltekit: "SvelteKit",
};

export function webFrameworkName(framework: WebFramework): string {
  return NAMES[framework];
}

/**
 * The environment variable the web build reads the backend URL from, or none
 * for Angular, whose CLI does not read .env files.
 */
export function webApiUrlVariable(web: DetectedWeb): string | undefined {
  if (web.framework === "angular") return undefined;
  return web.bundler === "react-scripts" ? "REACT_APP_API_URL" : "VITE_API_URL";
}

/** The binding, and any of its peer dependencies the app does not have yet. */
export function webPackages(web: DetectedWeb): string[] {
  const binding = web.framework === "sveltekit" ? "svelte" : web.framework;
  return [`@seamless-auth/${binding}`, ...web.missingPeers];
}

const ENTRY_SCREENS_COMMENT =
  "// The screens that start a sign-in are for signed-out visitors only. The others\n// finish one, so the session can already exist when they render.";

function reactSteps(web: DetectedWeb): WebStep[] {
  const variable = webApiUrlVariable(web);
  const read = web.bundler === "react-scripts" ? `process.env.${variable}` : `import.meta.env.${variable}`;
  return [
    {
      heading: "Wrap your React app",
      file: web.entry,
      code: `import { AuthProvider, useAuth } from "@seamless-auth/react";

// Wrap your app once, at the root. It talks to your backend's /auth routes.
<AuthProvider apiHost={${read}}>
  <App />
</AuthProvider>

// Anywhere below it:
const { isAuthenticated, user, logout } = useAuth();`,
    },
  ];
}

function angularSteps(web: DetectedWeb, apiOrigin: string): WebStep[] {
  return [
    {
      heading: "Provide Seamless Auth in your Angular app",
      file: web.entry,
      code: `import { provideHttpClient, withInterceptors } from "@angular/common/http";
import { provideSeamlessAuth, seamlessAuthInterceptor } from "@seamless-auth/angular";

// In your application's providers. Angular does not read .env, so the backend's
// URL is set here: read it from your own configuration for other environments.
provideSeamlessAuth({ apiHost: "${apiOrigin}" }),
// Sends the session cookies with HttpClient calls to your backend, and nowhere else.
// If you already call provideHttpClient, add the interceptor to that call.
provideHttpClient(withInterceptors([seamlessAuthInterceptor])),`,
    },
    {
      heading: "Add the sign-in screens and guard your routes",
      file: "src/app/app.routes.ts",
      code: `import { authGuard, guestGuard } from "@seamless-auth/angular";
import { authRoutePaths, seamlessAuthRoutes } from "@seamless-auth/angular/routes";

${ENTRY_SCREENS_COMMENT}
const entryScreens = new Set<string>([
  authRoutePaths.login,
  authRoutePaths.passkeyLogin,
  authRoutePaths.magicLinkSent,
]);

export const routes: Routes = [
  // Your routes, with canActivate: [authGuard] on the ones that need a signed-in user:
  { path: "", component: Home, canActivate: [authGuard] },
  ...seamlessAuthRoutes.map((route) =>
    entryScreens.has(route.path ?? "") ? { ...route, canActivate: [guestGuard] } : route,
  ),
];

// In a component: const auth = inject(SeamlessAuth); then auth.user() and auth.logout().`,
    },
  ];
}

function vueSteps(web: DetectedWeb): WebStep[] {
  const imports = `import { authGuard, createSeamlessAuthRoutes, guestGuard } from "@seamless-auth/vue/router";`;
  const entryScreens = `${ENTRY_SCREENS_COMMENT}
const entryScreens = new Set(["/login", "/passkey-login", "/magic-link-sent"]);`;
  const routes = `  // Your routes, with beforeEnter: authGuard on the ones that need a signed-in user:
  { path: "/", component: HomePage, beforeEnter: authGuard },
  ...createSeamlessAuthRoutes().map((route) =>
    entryScreens.has(route.path) ? { ...route, beforeEnter: guestGuard } : route,
  ),`;
  const plugin = `.use(createSeamlessAuth({ apiHost: import.meta.env.VITE_API_URL }))`;

  // An app without vue-router gets one now (it is a peer of the binding), so
  // print the whole router rather than the lines to add to one.
  if (web.missingPeers.includes("vue-router")) {
    return [
      {
        heading: "Create a router with the sign-in screens, and install Seamless Auth",
        file: web.entry,
        code: `import { createRouter, createWebHistory } from "vue-router";
import { createSeamlessAuth } from "@seamless-auth/vue";
${imports}

${entryScreens}

const router = createRouter({
  history: createWebHistory(),
  routes: [
${routes.replace(/^/gm, "  ")}
  ],
});

createApp(App)
  .use(router)
  ${plugin}
  .mount("#app");

// And render the pages: put <RouterView /> in App.vue's template.
// In a component: const auth = useSeamlessAuth(); then auth.user.value and auth.logout().`,
      },
    ];
  }
  return [
    {
      heading: "Add the sign-in screens and guard your routes",
      file: web.router ?? web.entry,
      code: `${imports}

${entryScreens}

// In the routes you pass to createRouter:
routes: [
${routes}
],`,
    },
    {
      heading: "Install Seamless Auth after your router",
      file: web.entry,
      code: `import { createSeamlessAuth } from "@seamless-auth/vue";

// After the app uses your router, and before it mounts:
app.use(createSeamlessAuth({ apiHost: import.meta.env.VITE_API_URL }));

// In a component: const auth = useSeamlessAuth(); then auth.user.value and auth.logout().`,
    },
  ];
}

const SVELTE_SCREENS: [string, string][] = [
  ["passkey-login", "<SaPasskeyLogin />"],
  ["verify-email-otp", '<SaVerifyOtp channel="email" />'],
  ["verify-phone-otp", '<SaVerifyOtp channel="phone" />'],
  ["magic-link-sent", "<SaMagicLinkSent />"],
  ["verify-magiclink", "<SaVerifyMagicLink />"],
  ["oauth/callback", "<SaOAuthCallback />"],
  ["register-passkey", "<SaRegisterPasskey />"],
];

function svelteKitSteps(web: DetectedWeb): WebStep[] {
  // SvelteKit 3 maps #lib/* to src/lib/* as written, so it needs the extension.
  const authModule = web.libAlias === "#lib" ? "#lib/auth.js" : "$lib/auth";
  const ext = web.typescript ? "ts" : "js";
  const lang = web.typescript ? ' lang="ts"' : "";
  const width = Math.max(...SVELTE_SCREENS.map(([route]) => route.length)) + "/+page.svelte".length;
  return [
    {
      heading: "Create the session",
      file: `src/lib/auth.${ext}`,
      code: `import { createSeamlessAuth } from "@seamless-auth/svelte";

export const auth = createSeamlessAuth({ apiHost: import.meta.env.VITE_API_URL });`,
    },
    {
      heading: "Render in the browser and share the session",
      code: `// src/routes/+layout.${ext}: the session lives in the browser, so render there.
export const ssr = false;

<!-- src/routes/+layout.svelte -->
<script${lang}>
  import { setAuthNavigator, setSeamlessAuth } from "@seamless-auth/svelte";
  import { createKitNavigator } from "@seamless-auth/svelte/kit";
  import { auth } from "${authModule}";

  let { children } = $props();

  setSeamlessAuth(auth);
  setAuthNavigator(createKitNavigator(auth));
</script>

{@render children()}`,
    },
    {
      heading: "Mount the sign-in screens and guard your routes",
      code: `<!-- src/routes/login/+page.svelte, and one page like it per screen -->
<script${lang}>
  import { SaLogin } from "@seamless-auth/svelte";
</script>

<SaLogin />

<!--
${SVELTE_SCREENS.map(([route, component]) => `  ${`${route}/+page.svelte`.padEnd(width)}  ${component}`).join("\n")}
-->

// In the +page.${ext} or +layout.${ext} of each route that needs a signed-in user:
import { requireAuth } from "@seamless-auth/svelte/kit";
import { auth } from "${authModule}";

export const load = requireAuth(auth);

// login, passkey-login and magic-link-sent are for signed-out visitors: give each
// a +page.${ext} with requireGuest, imported from the same place.
export const load = requireGuest(auth);

// In a component: const auth = getSeamlessAuth(); then auth.user and auth.logout().`,
    },
  ];
}

/** The steps that wire the web app, each with the code to add. */
export function webSteps(web: DetectedWeb, opts: { apiOrigin: string }): WebStep[] {
  switch (web.framework) {
    case "angular":
      return angularSteps(web, opts.apiOrigin);
    case "vue":
      return vueSteps(web);
    case "sveltekit":
      return svelteKitSteps(web);
    default:
      return reactSteps(web);
  }
}

/** Where a step's file is, from the repository root. */
export function webStepFile(web: DetectedWeb, step: WebStep): string | undefined {
  return step.file ? path.join(web.dir, step.file) : undefined;
}
