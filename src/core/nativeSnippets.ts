import type { DetectedBackend } from "./detect.js";

// The code `seamless add` prints for Go, Rust and Python backends, on the
// seamless-auth-go, seamless-auth (crates.io) and seamless-auth (PyPI) adapters.
// Each follows that adapter's README and the api starter built on it, with the
// development-only logging of one-time codes the starters use: the auth server
// does not send messages in development, so without it nobody sees a code.

export interface SnippetOptions {
  webOrigin: string;
  serveConsole: boolean;
}

const DEV_NOTE =
  "Development only: log one-time codes and magic links instead of sending them,\n// so you can sign in without a mail or SMS provider. Replace before deploying.";

function goOptions(): string {
  return `opts := seamlessauth.Options{
	AuthServerURL:    os.Getenv("AUTH_SERVER_URL"),
	AuthServerIssuer: os.Getenv("AUTH_SERVER_ISSUER"),
	CookieSecret:     os.Getenv("COOKIE_SIGNING_KEY"),
	ServiceSecret:    os.Getenv("API_SERVICE_TOKEN"),
	JWKSKid:          os.Getenv("JWKS_KID"),
}
// ${DEV_NOTE}
if os.Getenv("APP_ENV") != "production" {
	opts.Deliver = func(_ context.Context, d seamlessauth.Delivery) error {
		log.Printf("Dev OTP to=%s code=%s link=%s", d.To, d.Token, d.MagicLinkURL)
		return nil
	}
}
auth, err := seamlessauth.New(opts)
if err != nil {
	log.Fatal(err)
}`;
}

const GO_ME = `func(w http.ResponseWriter, r *http.Request) {
	user, _ := seamlessauth.UserFromContext(r.Context())
	json.NewEncoder(w).Encode(map[string]string{"id": user.ID})
}`;

function goSnippet(framework: DetectedBackend["framework"], opts: SnippetOptions): string {
  const imports = [
    '"context"',
    '"encoding/json"',
    '"log"',
    '"net/http"',
    '"os"',
    "",
    'seamlessauth "github.com/fells-code/seamless-auth-go"',
  ];
  if (framework === "gin") imports.push('"github.com/gin-gonic/gin"');
  if (framework === "echo") imports.push('"github.com/labstack/echo/v4"');
  const header = `import (\n${imports.map((i) => (i ? `\t${i}` : "")).join("\n")}\n)\n\n${goOptions()}\n`;
  const cors = `// Your web app (${opts.webOrigin}) calls /auth on this server with cookies, so it
// needs credentialed CORS for the origins in UI_ORIGINS.`;
  const consoleLine = (mount: string) =>
    opts.serveConsole
      ? `\n// The admin dashboard at /console.\nif os.Getenv("SERVE_ADMIN_CONSOLE") == "true" {\n\t${mount}\n}`
      : "";

  switch (framework) {
    case "gin":
      return `${header}
${cors}
r.Any("/auth/*path", gin.WrapH(http.StripPrefix("/auth", auth.Handler())))${consoleLine(
        'r.Any("/console/*path", gin.WrapH(http.StripPrefix("/console", auth.ConsoleHandler())))',
      )}

// Protect a route. RequireAuth answers 401 without a session.
r.GET("/api/me", gin.WrapH(auth.RequireAuth(http.HandlerFunc(${GO_ME}))))`;
    case "chi":
      return `${header}
${cors}
r.Mount("/auth", http.StripPrefix("/auth", auth.Handler()))${consoleLine(
        'r.Mount("/console", http.StripPrefix("/console", auth.ConsoleHandler()))',
      )}

// Protect a route. RequireAuth answers 401 without a session.
r.With(auth.RequireAuth).Get("/api/me", ${GO_ME})`;
    case "echo":
      return `${header}
${cors}
e.Any("/auth/*", echo.WrapHandler(http.StripPrefix("/auth", auth.Handler())))${consoleLine(
        'e.Any("/console/*", echo.WrapHandler(http.StripPrefix("/console", auth.ConsoleHandler())))',
      )}

// Protect a route. RequireAuth answers 401 without a session.
e.GET("/api/me", echo.WrapHandler(auth.RequireAuth(http.HandlerFunc(${GO_ME}))))`;
    default:
      return `${header}
${cors}
mux.Handle("/auth/", http.StripPrefix("/auth", auth.Handler()))${consoleLine(
        'mux.Handle("/console/", http.StripPrefix("/console", auth.ConsoleHandler()))',
      )}

// Protect a route. RequireAuth answers 401 without a session.
mux.Handle("GET /api/me", auth.RequireAuth(http.HandlerFunc(${GO_ME})))`;
  }
}

function rustSnippet(opts: SnippetOptions): string {
  return `use std::collections::HashMap;
use std::net::SocketAddr;

use axum::{Json, routing::get};
use seamless_auth::{Adapter, Delivery, User};

let env = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
let mut builder = Adapter::builder(env("AUTH_SERVER_URL"))
    .cookie_secret(env("COOKIE_SIGNING_KEY"))
    .service_secret(env("API_SERVICE_TOKEN"))
    .jwks_kid(env("JWKS_KID"));
if let Ok(issuer) = std::env::var("AUTH_SERVER_ISSUER") {
    builder = builder.auth_server_issuer(issuer);
}
// ${DEV_NOTE}
if std::env::var("APP_ENV").as_deref() != Ok("production") {
    builder = builder.deliver(|d: Delivery| async move {
        println!("Dev OTP to={} code={}", d.to, d.token.unwrap_or_default());
        Ok::<_, std::convert::Infallible>(())
    });
}
let auth = builder.build().expect("Seamless Auth configuration");

// Your web app (${opts.webOrigin}) calls /auth on this server with cookies, so it
// needs credentialed CORS (tower-http's CorsLayer) for the origins in UI_ORIGINS.
// Added to the router you already have:
let app = app
    // Protect a route. require_auth answers 401 without a session.
    .route(
        "/api/me",
        get(|user: User| async move { Json(HashMap::from([("id", user.id)])) })
            .route_layer(auth.require_auth()),
    )
    .nest("/auth", auth.router());${
      opts.serveConsole
        ? `
// The admin dashboard at /console (merged, not nested: it serves /console/ too).
let app = if std::env::var("SERVE_ADMIN_CONSOLE").as_deref() == Ok("true") {
    app.merge(auth.console_router())
} else {
    app
};`
        : ""
    }

// Serve with connect info, so the adapter can forward the client address.
axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;`;
}

function fastapiSnippet(opts: SnippetOptions): string {
  return `import os

from fastapi import Depends
from fastapi.middleware.cors import CORSMiddleware
from seamless_auth import Adapter, Delivery, User
from seamless_auth.fastapi import RequireUser, auth_router${opts.serveConsole ? ", console_router" : ""}


# ${DEV_NOTE.replace("\n//", "\n#")}
def dev_deliver(d: Delivery) -> None:
    print(f"Dev OTP to={d.to} code={d.token} link={d.magic_link_url}", flush=True)


auth = Adapter(
    auth_server_url=os.environ["AUTH_SERVER_URL"],
    auth_server_issuer=os.environ.get("AUTH_SERVER_ISSUER") or None,
    cookie_secret=os.environ["COOKIE_SIGNING_KEY"],
    service_secret=os.environ["API_SERVICE_TOKEN"],
    jwks_kid=os.environ["JWKS_KID"],
    deliver=None if os.environ.get("APP_ENV") == "production" else dev_deliver,
)
current_user = RequireUser(auth)

# Your web app calls /auth on this server with cookies, so it needs credentialed CORS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("UI_ORIGINS", "${opts.webOrigin}").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth_router(auth))${
    opts.serveConsole
      ? `
if os.environ.get("SERVE_ADMIN_CONSOLE") == "true":
    app.include_router(console_router(auth))`
      : ""
  }


# Protect a route. RequireUser answers 401 without a session.
@app.get("/api/me")
def me(user: User = Depends(current_user)) -> dict[str, str]:
    return {"id": user.id}`;
}

function djangoSnippet(opts: SnippetOptions): string {
  return `# settings.py
import os


# ${DEV_NOTE.replace("\n//", "\n#")}
def _dev_deliver(d):
    print(f"Dev OTP to={d.to} code={d.token} link={d.magic_link_url}", flush=True)


SEAMLESS_AUTH = {
    "auth_server_url": os.environ["AUTH_SERVER_URL"],
    "auth_server_issuer": os.environ.get("AUTH_SERVER_ISSUER") or None,
    "cookie_secret": os.environ["COOKIE_SIGNING_KEY"],
    "service_secret": os.environ["API_SERVICE_TOKEN"],
    "jwks_kid": os.environ["JWKS_KID"],
    "deliver": None if os.environ.get("APP_ENV") == "production" else _dev_deliver,
}
# Your web app (${opts.webOrigin}) calls /auth with cookies, so it needs
# credentialed CORS for the origins in UI_ORIGINS (django-cors-headers).

# urls.py
from django.urls import include, path
${opts.serveConsole ? "from seamless_auth.django import console_urlpatterns\n" : ""}
from . import views  # where me() below lives

urlpatterns += [
    path("auth/", include("seamless_auth.django")),${
      opts.serveConsole ? '\n    path("console/", include(console_urlpatterns)),' : ""
    }
    path("api/me", views.me),
]

# views.py: protect a view. require_auth answers 401 without a session.
from django.http import JsonResponse
from seamless_auth.django import require_auth, user_of


@require_auth
def me(request):
    return JsonResponse({"id": user_of(request).id})`;
}

/** The code for a Go, Rust or Python backend. */
export function nativeBackendSnippet(backend: DetectedBackend, opts: SnippetOptions): string {
  switch (backend.ecosystem) {
    case "go":
      return goSnippet(backend.framework, opts);
    case "rust":
      return rustSnippet(opts);
    default:
      return backend.framework === "django" ? djangoSnippet(opts) : fastapiSnippet(opts);
  }
}
