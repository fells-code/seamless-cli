---
"seamless-cli": patch
---

Map the web container to port 8080. The seamless-templates web and Next.js images now run as non-root and listen on 8080 instead of 80 (seamless-templates#133), so the generated compose file publishes `127.0.0.1:5173:8080` and health-checks `/health` on 8080, and the verify harness serves every web, reference, and Next.js app on 8080 (the nginx ones from `nginxinc/nginx-unprivileged`, as the templates do). This needs a templates release that carries the change: a scaffold from the templates pinned before it would map a port its web image no longer listens on.
