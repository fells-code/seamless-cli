---
"seamless-cli": patch
---

`seamless add` fixes from writing its docs:

- The backend origin (`--api-url`) now defaults by ecosystem when the backend's `.env` has no `PORT`: the port in the entry file's listen call when there is one, otherwise 3000 for Node, 8000 for FastAPI and Django (the uvicorn and `runserver` defaults), and 8080 for Go and Rust (the adapters' own examples). It was 3000 for every backend, which pointed FastAPI and Django apps, and the auth server's `APP_ORIGINS`, at the wrong port.
- The "Found no backend" error, `seamless help add` and the README list the folders detection searches from the same list detection uses, so they now include `app/` (and `web/`, `client/` and `frontend/` in the error).
- Go, Axum and Django get working credentialed CORS for `UI_ORIGINS`, like Express, Fastify and FastAPI: net/http middleware for net/http and chi, a Gin middleware, Echo's CORS middleware, a tower-http `CorsLayer` (`cargo add tower-http --features cors` is now part of the install), and django-cors-headers (now installed with the Django adapter).
- FastAPI and Django install `python-dotenv`, and the printed code calls `load_dotenv()` before reading the environment. The hint no longer suggests `uvicorn --env-file .env`, which needed python-dotenv without installing it.
- React gets the bundled sign-in screens: `BrowserRouter` around `AuthProvider`, then `AuthRoutes` from `@seamless-auth/react/routes` with guards for signed-in and signed-out pages, in `src/App` when it exists. `react-router-dom` is installed when the app does not have it.
- Removed the em dashes from `seamless <command> --help` headers, the top-level help, the `verify` summary and the admin dashboard prompt.
