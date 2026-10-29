#!/usr/bin/env bash
#
# Brings up what `seamless init` actually writes, and asserts the database keeps
# its data, and the auth server its dev signing keys, across a container recreate.
#
# Everything else in CI tests the generated files as strings. This is the only job
# that hands them to Docker, so it is the only one that can catch a compose file
# that is well-formed and wrong: a volume mounted where the image does not store
# data, a service that cannot reach another, a healthcheck that never passes.
#
# Bring-up alone is not the assertion. A wrong mount can leave a database that
# starts, serves queries, and silently writes to the container layer, so the check
# that earns its place is: write a row, recreate the container, read it back.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_NAME="${SMOKE_PROJECT_NAME:-seamless-scaffold-smoke}"
WORKDIR="$(mktemp -d)"
APP_DIR="$WORKDIR/smoke"

# Lets a developer run this beside a stack that already holds 5432 or 5312. CI
# gets its own runner and needs nothing here.
EXTRA_COMPOSE="${SMOKE_EXTRA_COMPOSE:-}"
# Where that override publishes the auth server, when it moves it off 5312.
AUTH_URL="${SMOKE_AUTH_URL:-http://localhost:5312}"

compose() {
  local args=(compose -p "$PROJECT_NAME" -f "$APP_DIR/docker-compose.yml")
  if [ -n "$EXTRA_COMPOSE" ]; then
    args+=(-f "$EXTRA_COMPOSE")
  fi
  docker "${args[@]}" "$@"
}

cleanup() {
  local status=$?
  if [ -f "$APP_DIR/docker-compose.yml" ]; then
    echo "==> Tearing down"
    # Logs are worth more than a clean exit when this failed.
    if [ "$status" -ne 0 ]; then
      compose ps || true
      compose logs --tail=80 || true
    fi
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
  exit "$status"
}
trap cleanup EXIT

# The generated compose pins container_name, so a leftover from another stack wedges
# this with a raw Docker conflict. Say what is wrong instead, and never remove
# containers this script did not create: on a developer's machine they are their work.
for name in seamless-db seamless-auth; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    echo "FAIL: a container named '$name' already exists." >&2
    echo "      The generated compose pins that name, so this cannot run beside it." >&2
    echo "      Stop it first, or run this on a machine without a Seamless stack up." >&2
    exit 1
  fi
done

echo "==> Scaffolding into $APP_DIR"
cd "$WORKDIR"
# `init` downloads the template registry, the templates archive, and the auth
# server's .env.example. This job is about what the generated compose does, not
# about GitHub's availability, so a transient fetch failure is retried rather than
# reported as a scaffold regression.
scaffold_attempt=1
scaffold_backoff=10
until node "$REPO_ROOT/dist/index.js" init smoke \
  --local --yes \
  --email=smoke@example.com \
  --auth=docker \
  --admin=none
do
  if [ "$scaffold_attempt" -ge 4 ]; then
    echo "FAIL: init did not complete after $scaffold_attempt attempts." >&2
    exit 1
  fi
  # Backs off, because the failure mode seen in practice is a throttle after the
  # archive download rather than a hard outage, and retrying immediately re-trips it.
  echo "==> init failed, retrying in ${scaffold_backoff}s ($scaffold_attempt)" >&2
  rm -rf "$APP_DIR"
  scaffold_attempt=$((scaffold_attempt + 1))
  sleep "$scaffold_backoff"
  scaffold_backoff=$((scaffold_backoff * 2))
done

for required in docker-compose.yml seamless.config.json .gitignore auth/.env; do
  if [ ! -f "$APP_DIR/$required" ]; then
    echo "FAIL: init did not write $required" >&2
    exit 1
  fi
done

# The scaffold is meant to be committed as-is, so `git init && git add .` must
# pick up no secret: every one lives in a git-ignored .env, readable by its owner only.
echo "==> Checking that git would commit no secret"
SECRETS_FILE="$WORKDIR/secrets.txt"
find "$APP_DIR" -name .env -not -path '*/node_modules/*' -exec cat {} + \
  | grep -E '^(SEAMLESS_SERVICE_TOKEN|API_SERVICE_TOKEN|REFRESH_TOKEN_LOOKUP_SECRET|TOTP_SECRET_ENCRYPTION_KEY|DECOY_SUBJECT_SECRET|OAUTH_STATE_SECRET|COOKIE_SIGNING_KEY)=' \
  | cut -d= -f2- | grep -v '^$' | sort -u > "$SECRETS_FILE" || true

for name in SEAMLESS_SERVICE_TOKEN REFRESH_TOKEN_LOOKUP_SECRET TOTP_SECRET_ENCRYPTION_KEY DECOY_SUBJECT_SECRET; do
  if ! grep -q "^$name=." "$APP_DIR/auth/.env"; then
    echo "FAIL: auth/.env does not set $name" >&2
    exit 1
  fi
done

git -C "$APP_DIR" init -q
leaks="$(git -C "$APP_DIR" ls-files -z --others --exclude-standard \
  | (cd "$APP_DIR" && xargs -0 grep -lF -f "$SECRETS_FILE" --) || true)"
if [ -n "$leaks" ]; then
  echo "FAIL: files git would commit hold a generated secret:" >&2
  echo "$leaks" >&2
  exit 1
fi
rm -rf "$APP_DIR/.git"

loose="$(find "$APP_DIR" -name .env -not -path '*/node_modules/*' ! -perm 600)"
if [ -n "$loose" ]; then
  echo "FAIL: .env files readable beyond their owner:" >&2
  echo "$loose" >&2
  exit 1
fi

echo "==> No secret is in a file git would commit"

# Only the services with healthchecks, so `--wait` means something and no npm
# install happens. Bringing up api and web would mostly measure the templates.
echo "==> Bringing up db and auth"
compose up -d --wait db auth

echo "==> Writing a row"
compose exec -T db psql -U myuser -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE smoke_probe (id int primary key); INSERT INTO smoke_probe VALUES (42);"

# `down` without -v keeps the named volume, so the container is replaced while the
# storage it declared survives. That is precisely the thing being asserted.
# The auth server writes its dev key pair under /app/keys on first sign, as the
# image's non-root user. A probe file written as that same user proves the volume
# is both writable and the place that survives.
echo "==> Writing a key probe"
compose exec -T auth sh -c 'echo 42 > /app/keys/smoke-probe'

echo "==> Recreating the containers, keeping the volumes"
compose down
compose up -d --wait db auth

echo "==> Reading the row back"
# `|| true` so a missing table reaches the comparison below rather than tripping
# `set -e` first. psql's own "relation does not exist" says less than the message
# this can give, which names the compose file as the thing to look at.
value="$(compose exec -T db psql -U myuser -d postgres -tAc 'SELECT id FROM smoke_probe;' 2>/dev/null | tr -d '[:space:]' || true)"

if [ "$value" != "42" ]; then
  echo "FAIL: the database did not keep its data across a container recreate." >&2
  echo "      Expected 42, read '${value}'." >&2
  echo "      The generated compose file declares a volume the image does not store data in." >&2
  exit 1
fi

echo "==> Data survived the recreate"

echo "==> Reading the key probe back"
key_probe="$(compose exec -T auth cat /app/keys/smoke-probe 2>/dev/null | tr -d '[:space:]' || true)"

if [ "$key_probe" != "42" ]; then
  echo "FAIL: the auth server's key directory did not survive a container recreate." >&2
  echo "      Expected 42, read '${key_probe}'." >&2
  echo "      A new dev key pair under the same kid breaks every adapter's cached key." >&2
  exit 1
fi

echo "==> Signing keys survived the recreate"

# The first admin path the quickstart gives: the browser registers the owner, and
# `owner-code` prints the code it then asks for. The registration here stands in
# for the browser, and its pre-auth token is what the code is verified under, so a
# pass means the printed code works on the page that asked for it.
echo "==> Registering the owner as the browser would"
ephemeral="$(curl -fsS -X POST "$AUTH_URL/registration/register" \
  -H 'Content-Type: application/json' \
  -d '{"email":"smoke@example.com"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')"

echo "==> Reading the code with owner-code"
code="$(cd "$APP_DIR" && node "$REPO_ROOT/dist/index.js" owner-code --url "$AUTH_URL" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).code))')"

echo "==> Verifying the code under the browser's registration"
roles="$(curl -fsS -X POST "$AUTH_URL/otp/verify-email-otp" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ephemeral" \
  -d "{\"verificationToken\":\"$code\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log((JSON.parse(s).roles||[]).join(",")))')"

case ",$roles," in
  *,admin:write,*|*,admin,*) ;;
  *)
    echo "FAIL: the owner signed in without an admin role (roles: '${roles}')." >&2
    exit 1
    ;;
esac

echo "==> The owner is an admin (${roles})"
echo "PASS"
