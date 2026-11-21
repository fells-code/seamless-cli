---
"seamless-cli": patch
---

The generated `docker-compose.yml` now builds the `api` service, and a full-stack `web` service, with `target: dev`. Starting with the templates release that makes the production `runtime` stage the default Docker build target, building without a target would produce the production image under the source bind mount, and the app would fail to start. The SPA `web` service keeps its default nginx stage.
