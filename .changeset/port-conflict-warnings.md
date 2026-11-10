---
"seamless-cli": patch
---

`seamless init` warns when another program already holds a port the local stack publishes (5173, 3000, 5312, 5432, and 5174 with a separate console), and `seamless check` fails on one. The stack publishes on 127.0.0.1 only, so a Vite dev server on `[::1]:5173` used to take `http://localhost:5173` in the browser while every check passed. Each warning says what the conflict breaks and how to find the program. `check` also asks the project's own compose file which services run, rather than matching container names across every running container.
