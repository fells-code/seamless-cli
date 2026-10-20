#!/usr/bin/env bash
#
# The Self-Hosted Quickstart as a new user follows it, timed: the published CLI from
# npm, `init --local --yes`, `docker compose up`, then signing in as the first admin
# through the app's /auth routes, the way the browser does, with the code from
# `seamless owner-code`.
#
# On a fresh CI runner this is the clean machine run. On a developer machine it uses
# a throwaway directory and npm cache, and reports which Docker images were already
# cached, since that is the one part of a machine it cannot make clean.
#
#   QUICKSTART_CLI   the CLI to run (default seamless-cli@latest)
set -euo pipefail

CLI="${QUICKSTART_CLI:-seamless-cli@latest}"
OWNER="you@example.com"
WEB_ORIGIN="http://localhost:5173"
API_URL="http://localhost:3000"
AUTH_URL="http://localhost:5312"
WAIT_SECONDS="${QUICKSTART_WAIT_SECONDS:-900}"

WORKDIR="$(mktemp -d)"
APP_DIR="$WORKDIR/my-app"
JAR="$WORKDIR/cookies.txt"
export npm_config_cache="$WORKDIR/npm-cache"
export npm_config_update_notifier=false

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  local status=$?
  if [ -f "$APP_DIR/docker-compose.yml" ]; then
    echo "==> Tearing down"
    if [ "$status" -ne 0 ]; then
      (cd "$APP_DIR" && docker compose ps && docker compose logs --tail=60) || true
    fi
    (cd "$APP_DIR" && docker compose down -v --rmi local --remove-orphans >/dev/null 2>&1) || true
  fi
  # Only for a run that failed before the removal check below. Files a container
  # wrote as root over a bind mount can still be removed from a container.
  if ! rm -rf "$WORKDIR" 2>/dev/null; then
    docker run --rm -v "$WORKDIR:/w" alpine:3 rm -rf /w/my-app >/dev/null 2>&1 || true
    rm -rf "$WORKDIR" || true
  fi
  exit "$status"
}
trap cleanup EXIT

for name in seamless-db seamless-auth api web; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    fail "a container named '$name' already exists. The generated compose pins that name."
  fi
done

PHASES=()
phase_start=0
start_phase() {
  echo "==> $1"
  phase_start=$(date +%s)
}
end_phase() {
  PHASES+=("$1|$(($(date +%s) - phase_start))")
}

ready() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)"
  [ "$code" -ge 200 ] && [ "$code" -lt 400 ]
}

run_start=$(date +%s)
cd "$WORKDIR"

start_phase "Fetching $CLI"
cli_version="$(npx -y "$CLI" --version)"
end_phase "Fetch the CLI with npx"

start_phase "seamless init my-app --local --yes"
npx -y "$CLI" init my-app --local --yes --email="$OWNER"
end_phase "init"

cd "$APP_DIR"
images="$(docker compose config --images | sort -u)"
cached=()
for image in $images; do
  if docker image inspect "$image" >/dev/null 2>&1; then cached+=("$image"); fi
done

start_phase "docker compose up"
docker compose up -d --build
end_phase "docker compose up (pull, build, start)"

start_phase "Waiting for auth, API, web and console"
deadline=$(($(date +%s) + WAIT_SECONDS))
for url in "$AUTH_URL/health/status" "$API_URL/" "$WEB_ORIGIN/" "$API_URL/console/"; do
  until ready "$url"; do
    [ "$(date +%s)" -lt "$deadline" ] || fail "$url did not answer within ${WAIT_SECONDS}s."
    sleep 2
  done
done
end_phase "Services answering"

start_phase "Signing in as the owner"
post() {
  local body="${2:-}"
  [ -n "$body" ] || body='{}'
  curl -fsS -b "$JAR" -c "$JAR" -X POST "$API_URL/auth$1" \
    -H "Origin: $WEB_ORIGIN" -H 'Content-Type: application/json' -d "$body"
}
post /registration/register "{\"email\":\"$OWNER\"}" >/dev/null
post /otp/generate-email-otp >/dev/null
code="$(npx -y "$CLI" owner-code --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).code))')"
post /otp/verify-email-otp "{\"verificationToken\":\"$code\"}" >/dev/null
roles="$(curl -fsS -b "$JAR" "$API_URL/auth/users/me" -H "Origin: $WEB_ORIGIN" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);console.log(((b.user||b).roles||[]).join(","))})')"
case ",$roles," in
  *,admin:write,*) ;;
  *) fail "the owner signed in without admin:write (roles: '$roles')." ;;
esac
end_phase "Owner signed in through /auth"

total=$(($(date +%s) - run_start))

# On a Linux host the dev containers run as root over bind mounts, so anything they
# write into the project is root's, and a user cannot delete the project without sudo.
echo "==> Removing the project"
docker compose down -v --rmi local --remove-orphans >/dev/null 2>&1
cd "$WORKDIR"
if ! rm -rf "$APP_DIR"; then
  find "$APP_DIR" -user 0 >&2 || true
  fail "the project could not be removed without root. The files above were written by a container."
fi

{
  echo "### Quickstart clean run: $CLI ($cli_version)"
  echo
  echo "$(uname -sm), $(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu) CPUs, Node $(node --version), $(docker version --format 'Docker {{.Server.Version}}')"
  echo
  echo "| Phase | Seconds |"
  echo "|---|---|"
  for entry in "${PHASES[@]}"; do
    echo "| ${entry%%|*} | ${entry##*|} |"
  done
  echo "| **Total, to an admin session** | **$total** |"
  echo
  echo "Owner roles: \`$roles\`"
  echo
  if [ "${#cached[@]}" -eq 0 ]; then
    echo "Docker images already cached before the run: none."
  else
    echo "Docker images already cached before the run (their pull time is not included): ${cached[*]}"
  fi
} | tee "$WORKDIR/summary.md"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$WORKDIR/summary.md" >>"$GITHUB_STEP_SUMMARY"
fi
echo "PASS"
