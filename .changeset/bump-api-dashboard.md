---
"seamless-cli": patch
---

New projects scaffold the auth server at `v0.16.0` (was `v0.13.1`) and the admin dashboard at `v0.9.1` (was `v0.7.0`). The auth server now links or creates an account through OAuth only when the provider asserts a verified email, and adds user import and OpenID Connect provider support. The dashboard's new Passkey enrollment page needs `/admin/enrollment` routes that ship in the next auth server release, so it reports an error against `v0.16.0`. `adm-zip`, which unpacks the downloaded templates and dashboard, moves to `0.6.1` to clear its security advisories.
