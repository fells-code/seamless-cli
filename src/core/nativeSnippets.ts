import type { DetectedBackend } from "./detect.js";
import { SERVICE_TOKEN_VAR } from "./serviceToken.js";

// The code `seamless add` prints for Go, Rust and Python backends, on the
// seamless-auth-go, seamless-auth (crates.io) and seamless-auth (PyPI) adapters.
// Each follows that adapter's README and the api starter built on it, with the
// development-only logging of one-time codes the starters use: the auth server
// does not send messages in development, so without it nobody sees a code.

export interface SnippetOptions {
  webOrigin: string;
  serveConsole: boolean;
  // The variable the backend reads its service token from. SEAMLESS_SERVICE_TOKEN
  // unless the project's .env already holds the legacy API_SERVICE_TOKEN.
  serviceTokenVar?: string;
}

export function tokenVar(opts: SnippetOptions): string {
  return opts.serviceTokenVar ?? SERVICE_TOKEN_VAR;
}

const DEV_NOTE =
  "Development only: log one-time codes and magic links instead of sending them,\n// so you can sign in without a mail or SMS provider. Replace before deploying.";

function goOptions(variable: string): string {
  return `opts := seamlessauth.Options{
	AuthServerURL:    os.Getenv("AUTH_SERVER_URL"),
	AuthServerIssuer: os.Getenv("AUTH_SERVER_ISSUER"),
	CookieSecret:     os.Getenv("COOKIE_SIGNING_KEY"),
	ServiceSecret:    os.Getenv("${variable}"),
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

const CORS_COMMENT = "Your web app calls /auth on this server with cookies, so it needs credentialed\n// CORS for the origins in UI_ORIGINS.";

// The origins in UI_ORIGINS, falling back to the web origin seamless add found.
function goOrigins(webOrigin: string): string {
  return `var uiOrigins []string
for _, o := range strings.Split(cmp.Or(os.Getenv("UI_ORIGINS"), "${webOrigin}"), ",") {
	uiOrigins = append(uiOrigins, strings.TrimSpace(o))
}`;
}

// Credentialed CORS as net/http middleware, for net/http and chi. An origin not
// in the list gets no CORS headers, and the browser blocks the response.
// Same-origin requests (the console's own) need none.
const GO_CORS_MIDDLEWARE = `withCORS := func(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); slices.Contains(uiOrigins, origin) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Add("Vary", "Origin")
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				h.Set("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE")
				h.Set("Access-Control-Allow-Headers", r.Header.Get("Access-Control-Request-Headers"))
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}`;

// The same for Gin, as the Gin starter writes it.
const GIN_CORS = `// Ahead of every route: Gin applies middleware only to routes added after it.
r.Use(func(c *gin.Context) {
	if origin := c.GetHeader("Origin"); slices.Contains(uiOrigins, origin) {
		h := c.Writer.Header()
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Access-Control-Allow-Credentials", "true")
		h.Add("Vary", "Origin")
		if c.Request.Method == http.MethodOptions && c.GetHeader("Access-Control-Request-Method") != "" {
			h.Set("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE")
			h.Set("Access-Control-Allow-Headers", c.GetHeader("Access-Control-Request-Headers"))
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
	}
	c.Next()
})`;

const ECHO_CORS = `e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
	AllowOrigins:     uiOrigins,
	AllowCredentials: true,
}))`;

function goSnippet(framework: DetectedBackend["framework"], opts: SnippetOptions): string {
  const imports = [
    '"cmp"',
    '"context"',
    '"encoding/json"',
    '"log"',
    '"net/http"',
    '"os"',
    ...(framework === "echo" ? [] : ['"slices"']),
    '"strings"',
    "",
    'seamlessauth "github.com/fells-code/seamless-auth-go"',
  ];
  if (framework === "gin") imports.push('"github.com/gin-gonic/gin"');
  if (framework === "echo") imports.push('"github.com/labstack/echo/v4"', '"github.com/labstack/echo/v4/middleware"');
  const header = `import (\n${imports.map((i) => (i ? `\t${i}` : "")).join("\n")}\n)\n\n${goOptions(tokenVar(opts))}\n`;
  const cors = (use: string) => `// ${CORS_COMMENT}\n${goOrigins(opts.webOrigin)}\n${use}`;
  const consoleLine = (mount: string) =>
    opts.serveConsole
      ? `\n// The admin dashboard at /console.\nif os.Getenv("SERVE_ADMIN_CONSOLE") == "true" {\n\t${mount}\n}`
      : "";

  switch (framework) {
    case "gin":
      return `${header}
${cors(GIN_CORS)}

r.Any("/auth/*path", gin.WrapH(http.StripPrefix("/auth", auth.Handler())))${consoleLine(
        'r.Any("/console/*path", gin.WrapH(http.StripPrefix("/console", auth.ConsoleHandler())))',
      )}

// Protect a route. RequireAuth answers 401 without a session.
r.GET("/api/me", gin.WrapH(auth.RequireAuth(http.HandlerFunc(${GO_ME}))))`;
    case "chi":
      return `${header}
${cors(`${GO_CORS_MIDDLEWARE}\n// Ahead of every route: chi refuses middleware added after one.\nr.Use(withCORS)`)}

r.Mount("/auth", http.StripPrefix("/auth", auth.Handler()))${consoleLine(
        'r.Mount("/console", http.StripPrefix("/console", auth.ConsoleHandler()))',
      )}

// Protect a route. RequireAuth answers 401 without a session.
r.With(auth.RequireAuth).Get("/api/me", ${GO_ME})`;
    case "echo":
      return `${header}
${cors(ECHO_CORS)}

e.Any("/auth/*", echo.WrapHandler(http.StripPrefix("/auth", auth.Handler())))${consoleLine(
        'e.Any("/console/*", echo.WrapHandler(http.StripPrefix("/console", auth.ConsoleHandler())))',
      )}

// Protect a route. RequireAuth answers 401 without a session.
e.GET("/api/me", echo.WrapHandler(auth.RequireAuth(http.HandlerFunc(${GO_ME}))))`;
    default:
      return `${header}
${cors(GO_CORS_MIDDLEWARE)}

mux.Handle("/auth/", http.StripPrefix("/auth", auth.Handler()))${consoleLine(
        'mux.Handle("/console/", http.StripPrefix("/console", auth.ConsoleHandler()))',
      )}

// Protect a route. RequireAuth answers 401 without a session.
mux.Handle("GET /api/me", auth.RequireAuth(http.HandlerFunc(${GO_ME})))

// Serve the mux through the CORS middleware, where you start the server:
// http.ListenAndServe(addr, withCORS(mux))`;
  }
}

function rustSnippet(opts: SnippetOptions): string {
  return `use std::collections::HashMap;
use std::net::SocketAddr;

use axum::http::{HeaderValue, Method};
use axum::{Json, routing::get};
use seamless_auth::{Adapter, Delivery, User};
use tower_http::cors::{AllowHeaders, AllowOrigin, CorsLayer};

let env = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
let mut builder = Adapter::builder(env("AUTH_SERVER_URL"))
    .cookie_secret(env("COOKIE_SIGNING_KEY"))
    .service_secret(env("${tokenVar(opts)}"))
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

// ${CORS_COMMENT}
let ui_origins: Vec<HeaderValue> = std::env::var("UI_ORIGINS")
    .unwrap_or_else(|_| "${opts.webOrigin}".into())
    .split(',')
    .filter_map(|origin| origin.trim().parse().ok())
    .collect();
let cors = CorsLayer::new()
    .allow_origin(AllowOrigin::list(ui_origins))
    .allow_credentials(true)
    .allow_methods([Method::GET, Method::HEAD, Method::PUT, Method::PATCH, Method::POST, Method::DELETE])
    .allow_headers(AllowHeaders::mirror_request());

// Added to the router you already have:
let app = app
    // Protect a route. require_auth answers 401 without a session.
    .route(
        "/api/me",
        get(|user: User| async move { Json(HashMap::from([("id", user.id)])) })
            .route_layer(auth.require_auth()),
    )
    .nest("/auth", auth.router())
    // CORS covers the routes added so far, and leaves out the console below,
    // which is same-origin.
    .layer(cors);${
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

from dotenv import load_dotenv
from fastapi import Depends
from fastapi.middleware.cors import CORSMiddleware
from seamless_auth import Adapter, Delivery, User
from seamless_auth.fastapi import RequireUser, auth_router${opts.serveConsole ? ", console_router" : ""}

# Reads .env into the environment. A missing file is fine: in production the
# variables come from the environment.
load_dotenv()


# ${DEV_NOTE.replace("\n//", "\n#")}
def dev_deliver(d: Delivery) -> None:
    print(f"Dev OTP to={d.to} code={d.token} link={d.magic_link_url}", flush=True)


auth = Adapter(
    auth_server_url=os.environ["AUTH_SERVER_URL"],
    auth_server_issuer=os.environ.get("AUTH_SERVER_ISSUER") or None,
    cookie_secret=os.environ["COOKIE_SIGNING_KEY"],
    service_secret=os.environ["${tokenVar(opts)}"],
    jwks_kid=os.environ["JWKS_KID"],
    deliver=None if os.environ.get("APP_ENV") == "production" else dev_deliver,
)
current_user = RequireUser(auth)

# ${CORS_COMMENT.replace("\n//", "\n#")}
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

from dotenv import load_dotenv

# Reads .env into the environment. A missing file is fine: in production the
# variables come from the environment.
load_dotenv()


# ${DEV_NOTE.replace("\n//", "\n#")}
def _dev_deliver(d):
    print(f"Dev OTP to={d.to} code={d.token} link={d.magic_link_url}", flush=True)


SEAMLESS_AUTH = {
    "auth_server_url": os.environ["AUTH_SERVER_URL"],
    "auth_server_issuer": os.environ.get("AUTH_SERVER_ISSUER") or None,
    "cookie_secret": os.environ["COOKIE_SIGNING_KEY"],
    "service_secret": os.environ["${tokenVar(opts)}"],
    "jwks_kid": os.environ["JWKS_KID"],
    "deliver": None if os.environ.get("APP_ENV") == "production" else _dev_deliver,
}

# ${CORS_COMMENT.replace("\n//", "\n#")}
# django-cors-headers answers it; its middleware goes first.
INSTALLED_APPS += ["corsheaders"]
MIDDLEWARE.insert(0, "corsheaders.middleware.CorsMiddleware")
CORS_ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("UI_ORIGINS", "${opts.webOrigin}").split(",")]
CORS_ALLOW_CREDENTIALS = True

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
