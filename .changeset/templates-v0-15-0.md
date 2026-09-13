---
'seamless-cli': minor
---

Scaffold from seamless-templates `v0.15.0`, the release that carries the Expo starter.

`0.16.0` taught `init` the `mobile` template kind but left the registry pin on `v0.14.0`, which has
no such kind, so the question was never asked and `--mobile=expo` was refused as an unknown option.
With the pin on `v0.15.0` the registry lists the starter as `expo` (alias `mobile`, beta): `init`
offers it after the backend, `--mobile` scaffolds it at `mobile/` with `EXPO_PUBLIC_API_URL` filled
from the manifest, and the success output says how to start it. The starter is a complete Expo
Router app on `@seamless-auth/react-native` `0.1.0` (email code, sign-in link, passkeys, a
protected call to the companion API), and its `tools/associations/` generator writes the files
native passkeys need. `--yes` still scaffolds without it.

The same release moves the API starters to `@seamless-auth/express` `0.16.0` and
`@seamless-auth/fastify` `0.7.0` and passes `authServerUrl` and `audience` into `requireAuth`, so a
scaffolded API accepts the auth API's access token from the native app alongside browser cookies,
and its `/auth` mount answers a bearer client with tokens in the body. The conformance harness's
adapters take the same `^0.16.0` and `^0.7.0`. The starters also keep their SSL options when
`DATABASE_URL` carries `sslmode` (templates `0.15.0`'s patch note). The web starters stay on
`@seamless-auth/react` `0.12.0`, and the auth API and admin dashboard pins do not move.
