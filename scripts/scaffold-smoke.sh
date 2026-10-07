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

for required in docker-compose.yml seamless.config.json; do
  if [ ! -f "$APP_DIR/$required" ]; then
    echo "FAIL: init did not write $required" >&2
    exit 1
  fi
done

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
echo "PASS"
