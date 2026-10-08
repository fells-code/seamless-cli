---
"seamless-cli": minor
---

Add `seamless add`, which adds Seamless Auth to an existing Express or Fastify backend and React web app. It connects a local auth server (written to `seamless/`) or a managed application, writes the backend's `.env` and the web app's API URL while keeping existing values, installs the adapter and SDK with the project's package manager, and prints the code to add for TypeScript or JavaScript. It never edits source files. Commands now run without a shell outside Windows, which also stops Node 24's DEP0190 warning.
