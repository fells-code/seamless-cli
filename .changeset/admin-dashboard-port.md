---
'seamless-cli': patch
---

Map the standalone admin console (`--admin=image` and `--admin=source`) to container port 8080, where the dashboard's unprivileged nginx listens. The generated compose published `5174:80`, so nothing answered on `http://localhost:5174`.
