---
"seamless-cli": minor
---

`seamless add` now wires Go (net/http, Gin, chi, Echo), Rust (Axum) and Python (FastAPI, Django) backends on the seamless-auth-go, seamless-auth crate and seamless-auth PyPI adapters. It reads go.mod, Cargo.toml, pyproject.toml or requirements.txt, installs with `go get`, `cargo add`, `uv add` or `poetry add` (printing the `pip install` for a plain pip project), says how the language loads `.env`, and prints the code for that framework, including the development-only code logging and the admin console mount.
