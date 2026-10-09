---
"seamless-cli": minor
---

`seamless add` now wires Angular, Vue and SvelteKit web apps on the `@seamless-auth/angular`, `@seamless-auth/vue` and `@seamless-auth/svelte` bindings, alongside React. It installs the binding (and `vue-router` or `@angular/router` when the app has no router), writes `VITE_API_URL` for Vue and SvelteKit, and prints the code for each file: the provider or plugin, the bundled sign-in screens as routes, and guards for signed-in and signed-out pages. Angular, which does not read `.env`, gets the backend URL in the printed config. Nuxt and Svelte without SvelteKit are reported rather than wired.
