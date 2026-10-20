#!/usr/bin/env bash
#
# Scaffolds a project with `seamless init --local --yes`, boots its auth server, and
# drives the instance commands against it the way an operator would: sign in with
# `profile login --local`, then users, org, migrate and sessions.
#
# Unit tests cover each command against a mocked API. This is the only place the CLI
# and a real auth server of the pinned version meet, so it is what catches a route,
# a response shape or an auth rule that moved under the CLI.
#
# Tokens go through the OS keychain, as they do for a person. CI provides one with
# gnome-keyring (see the workflow); locally the platform keychain is used, under a
# profile this script removes on exit.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_NAME="${E2E_PROJECT_NAME:-seamless-cli-e2e}"
WORKDIR="$(mktemp -d)"
APP_DIR="$WORKDIR/e2e"
# Lets a developer run this beside a stack that already holds 5432 or 5312.
EXTRA_COMPOSE="${E2E_EXTRA_COMPOSE:-}"
AUTH_URL="${E2E_AUTH_URL:-http://localhost:5312}"

OWNER="owner@example.com"
PROFILE="cli-e2e"

# The CLI's profiles live here rather than in the developer's own config.
export XDG_CONFIG_HOME="$WORKDIR/config"
export SEAMLESS_PROFILE="$PROFILE"
# kleur colours output whether or not it is a terminal, and the ids parsed below
# would otherwise carry escape codes.
export NO_COLOR=1

seamless() {
  node "$REPO_ROOT/dist/index.js" "$@"
}

compose() {
  local args=(compose -p "$PROJECT_NAME" -f "$APP_DIR/docker-compose.yml")
  if [ -n "$EXTRA_COMPOSE" ]; then
    args+=(-f "$EXTRA_COMPOSE")
  fi
  docker "${args[@]}" "$@"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  local status=$?
  seamless profile remove "$PROFILE" >/dev/null 2>&1 || true
  if [ -f "$APP_DIR/docker-compose.yml" ]; then
    echo "==> Tearing down"
    if [ "$status" -ne 0 ]; then
      compose ps || true
      compose logs --tail=80 auth || true
    fi
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
  exit "$status"
}
trap cleanup EXIT

for name in seamless-db seamless-auth; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    fail "a container named '$name' already exists. The generated compose pins that name, so this cannot run beside it."
  fi
done

echo "==> Scaffolding into $APP_DIR"
cd "$WORKDIR"
# Retried for the same reason as scaffold-smoke.sh: init downloads from GitHub, and a
# throttled download is not a CLI regression.
attempt=1
backoff=10
until seamless init e2e --local --yes --email="$OWNER" --auth=docker --admin=none; do
  if [ "$attempt" -ge 4 ]; then
    fail "init did not complete after $attempt attempts."
  fi
  echo "==> init failed, retrying in ${backoff}s ($attempt)" >&2
  rm -rf "$APP_DIR"
  attempt=$((attempt + 1))
  sleep "$backoff"
  backoff=$((backoff * 2))
done

echo "==> Bringing up db and auth"
compose up -d --wait db auth

echo "==> Registering the owner"
ephemeral="$(curl -fsS -X POST "$AUTH_URL/registration/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$OWNER\"}" | jq -r .token)"
code="$(cd "$APP_DIR" && seamless owner-code --url "$AUTH_URL" --json | jq -r .code)"
curl -fsS -X POST "$AUTH_URL/otp/verify-email-otp" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ephemeral" \
  -d "{\"verificationToken\":\"$code\"}" >/dev/null

echo "==> profile add and profile login --local"
seamless profile add "$PROFILE" --instance-url "$AUTH_URL"
seamless profile login "$PROFILE" "$OWNER" --local

roles="$(seamless whoami --profile "$PROFILE" --json | jq -r '.roles | join(",")')"
case ",$roles," in
  *,admin:write,*) ;;
  *) fail "whoami does not report admin:write for the owner (roles: '$roles')." ;;
esac

echo "==> users list"
seamless users list --json | jq -e --arg e "$OWNER" 'any(.[]; .email == $e)' >/dev/null ||
  fail "users list does not include the owner."

echo "==> org create, get, update, list"
created="$(seamless org create "E2E Org" --slug e2e-org)"
org_id="$(sed -n 's/^Created organization \(.*\)\.$/\1/p' <<<"$created")"
[ -n "$org_id" ] || fail "org create printed no id: $created"
seamless org get "$org_id" --json | jq -e '.slug == "e2e-org"' >/dev/null ||
  fail "org get does not return the slug it was created with."
seamless org update "$org_id" --name "E2E Org Renamed" >/dev/null
seamless org list --search e2e --json | jq -e --arg id "$org_id" \
  'any(.[]; .id == $id and .name == "E2E Org Renamed")' >/dev/null ||
  fail "org list does not show the renamed organization."

echo "==> migrate csv: dry run, apply, re-run"
cat >"$WORKDIR/people.csv" <<'CSV'
email,externalId,organizations
ada@example.com,emp-1,e2e-org
grace@example.com,emp-2,e2e-org
CSV
seamless migrate csv "$WORKDIR/people.csv" --source hr --json |
  jq -e '.dryRun == true and .summary.created == 2' >/dev/null ||
  fail "the dry run does not report two users to create."
seamless users list --json | jq -e 'any(.[]; .email == "ada@example.com") | not' >/dev/null ||
  fail "the dry run wrote a user."
seamless migrate csv "$WORKDIR/people.csv" --source hr --apply --json |
  jq -e '.summary.created == 2' >/dev/null ||
  fail "the import did not create two users."
seamless migrate csv "$WORKDIR/people.csv" --source hr --apply --json |
  jq -e '.summary.unchanged == 2 and .summary.created == 0' >/dev/null ||
  fail "re-running the import changed something."

users="$(seamless users list --json)"
ada_id="$(jq -r '.[] | select(.email == "ada@example.com") | .id' <<<"$users")"
grace_id="$(jq -r '.[] | select(.email == "grace@example.com") | .id' <<<"$users")"
[ -n "$ada_id" ] && [ -n "$grace_id" ] || fail "users list does not include the imported users."

echo "==> users credentials"
seamless users credentials "$ada_id" --json | jq -e 'length == 0' >/dev/null ||
  fail "an imported user already has credentials."

echo "==> org members list, remove, add, update"
members() { seamless org members list "$org_id" --json; }
members | jq -e --arg a "$ada_id" --arg g "$grace_id" \
  'any(.[]; .userId == $a) and any(.[]; .userId == $g)' >/dev/null ||
  fail "the imported users are not members of the organization."
seamless org members remove "$org_id" "$grace_id" --force >/dev/null
members | jq -e --arg g "$grace_id" 'any(.[]; .userId == $g) | not' >/dev/null ||
  fail "members remove left the member in place."
seamless org members add "$org_id" --email grace@example.com --roles member >/dev/null
seamless org members update "$org_id" "$grace_id" --roles member,billing >/dev/null
members | jq -e --arg g "$grace_id" \
  'any(.[]; .userId == $g and (.roles | sort) == ["billing", "member"])' >/dev/null ||
  fail "members add and update did not leave the member with both roles."

echo "==> users delete"
seamless users delete "$grace_id" --force >/dev/null
seamless users list --json | jq -e --arg g "$grace_id" 'any(.[]; .id == $g) | not' >/dev/null ||
  fail "users delete left the user in place."

echo "==> sessions list and revoke --all"
seamless sessions list --json | jq -e 'any(.[]; .current == true)' >/dev/null ||
  fail "sessions list does not mark the current session."
seamless sessions revoke --all --force >/dev/null
if seamless users list --json >/dev/null 2>&1; then
  fail "users list still works after every session was revoked."
fi

echo "PASS"
