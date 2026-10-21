---
"seamless-cli": patch
---

`seamless init --auth=local` now produces an auth service that starts. The generated compose bind-mounts `./auth` over `/app`, which hid the image's `chmod +x ./validateEnvs.sh` (the script is mode 644 in the clone) and left the entrypoint looking for a `dist/server.js` that `Dockerfile.dev` never builds. The auth service now runs the same command as the auth server's own `docker-compose.dev.yml`: sync dependencies, run migrations (creating the database on first boot), then watch the TypeScript sources.
