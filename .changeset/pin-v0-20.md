---
"seamless-cli": minor
---

New projects scaffold auth server v0.20.0, admin dashboard v0.11.0 and seamless-templates v0.21.0 (the v0.20 SDKs). These include the fixes for GHSA-qx82-28gf-w744, GHSA-9xg2-j8fg-427c, GHSA-v9q2-hcqj-ggqr, GHSA-v2q2-q246-8chm and GHSA-m5x9-cjv4-6q3w, first shipped in auth server v0.19.4 and seamless-templates v0.20.3.

`--auth=local` now clones the auth server at the same `v0.20.0` tag the Docker image is built from, instead of the tip of `main`.
