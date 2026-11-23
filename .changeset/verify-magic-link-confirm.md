---
"seamless-cli": patch
---

`seamless verify` holds the API and adapters to the magic link contract from seamless-auth-api v0.24. Opening a link answers `409 confirmation_required` with `sameDevice`, and only `POST /magic-link/verify/:token/confirm` with the `code` from the link's fragment signs in. New specs check that a confirm with no code or a wrong code is refused, that a wrong code spends the link, and that the adapter forwards the confirm body. The browser specs open the full delivered link and expect a 409 verify followed by a successful confirm. The Angular, Vue and Svelte reference apps are pinned to `@seamless-auth/angular` 0.6.0, `@seamless-auth/vue` 0.5.0 and `@seamless-auth/svelte` 0.5.0, which read the code and confirm on their own.
