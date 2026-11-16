#!/usr/bin/env bash
# Watson on one computer (owner, 24 Oct 2026: a colleague runs the whole application on a Mac).
# The database, sign-in and files run in Docker (Supabase's local stack), the engine and the web app
# run here. Nothing touches the hosted Watson. Payments and Google Calendar need online services, so
# they are off until their test keys are in .local/online.env (docs/run-locally.md).
#
#   scripts/local.sh setup    once: tools, packages, the local stack, logins, the engine's models
#   scripts/local.sh start    the stack, the engine and the web app; then open http://localhost:3000
#   scripts/local.sh stop     everything above
#   scripts/local.sh check    proves it works: signs in, makes a call, waits for transcript and form
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD
state="$root/.local"   # git-ignored: this computer's logins, engine settings, logs
mkdir -p "$state"
# Leaves out what Watson does not use on one computer, to save memory: logs, image resizing,
# the dashboard, the mail catcher and the server functions (payments, Google, WhatsApp).
stack_options=(-x analytics,vector,imgproxy,studio,inbucket,edge-runtime)

say() { printf '\n== %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

tools() {
  local missing=()
  have node || missing+=(node)
  have pnpm || missing+=(pnpm)
  have supabase || missing+=(supabase/tap/supabase)
  have uv || missing+=(uv)
  if [ ${#missing[@]} -gt 0 ]; then
    if [ "$(uname)" = Darwin ] && have brew; then
      say "Installing with Homebrew: ${missing[*]}"
      brew install "${missing[@]}"
    else
      echo "Install these first: ${missing[*]} (on a Mac: https://brew.sh, then run this again)." >&2
      exit 1
    fi
  fi
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' ||
    { echo "Node 22 or newer is needed (now $(node -v))." >&2; exit 1; }
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running. Install Docker Desktop (https://www.docker.com/products/docker-desktop/)," >&2
    echo "open it once and wait until it says it is running, then run this again." >&2
    exit 1
  fi
}

online="$state/online.env"   # STRIPE_SECRET_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: optional
has_key() { [ -s "$online" ] && grep -q "^$1=." "$online"; }

web_env() { node apps/web/scripts/use-local-stack.mjs >/dev/null; }

# The website as the hosted one is built (static pages, its security policy, short links), against
# this computer's stack. Each online service shows only with its key. It replaces apps/web/out.
build_web() {
  say "Building the website (a minute or two)"
  (cd apps/web && export NEXT_PUBLIC_PAYMENTS=$(has_key STRIPE_SECRET_KEY && echo on || echo off) \
     NEXT_PUBLIC_GOOGLE_CALENDAR=$(has_key GOOGLE_CLIENT_ID && echo on || echo off) && pnpm build) \
    >"$state/build.log" 2>&1 || { tail -20 "$state/build.log"; echo "The build failed: .local/build.log" >&2; exit 1; }
}

# The server functions (payments, Google) with the keys, told where this computer's app is.
functions_env() {
  { cat "$online"; echo "SITE_URLS=http://localhost:3000"; echo "WATSON_PUBLIC_URL=http://127.0.0.1:54321"
    grep -q '^CRON_SECRET=' "$online" || echo "CRON_SECRET=$(openssl rand -hex 16)"; } > "$state/functions.env"
  chmod 600 "$state/functions.env"
}

running() { [ -s "$state/$1.pid" ] && kill -0 "$(cat "$state/$1.pid")" 2>/dev/null; }

case "${1:-}" in
  setup)
    tools
    say "Packages"
    pnpm install --frozen-lockfile
    say "The local stack (Docker; the first time downloads about 2 GB)"
    supabase start "${stack_options[@]}"
    web_env
    say "Logins"
    node scripts/local-accounts.mjs
    say "The engine and its models (about 5 GB the first time)"
    (cd apps/clinical-worker && uv sync && export WATSON_ENV_FILE="$state/engine.env" &&
      uv run clinical-worker fetch-model && uv run clinical-worker fetch-form-model && uv run clinical-worker fetch-ocr-model)
    say "Set up. Now: scripts/local.sh start"
    ;;
  start)
    supabase start "${stack_options[@]}" >/dev/null
    # After a git pull: the database changes that came with it (supabase start applies them only to a new database).
    # --include-all: a change dated before ones already applied here still runs (20261108090000).
    supabase migration up --local --include-all >/dev/null
    web_env
    if ! running engine; then
      # The whole group's output goes to the log, so nothing holds this terminal; exec keeps the pid true.
      (cd apps/clinical-worker && WATSON_ENV_FILE="$state/engine.env" exec nohup uv run clinical-worker engine) \
        >"$state/engine.log" 2>&1 </dev/null &
      echo $! >"$state/engine.pid"
    fi
    if [ -s "$online" ] && ! running functions; then
      functions_env
      supabase functions serve --env-file "$state/functions.env" >"$state/functions.log" 2>&1 </dev/null &
      echo $! >"$state/functions.pid"
    fi
    if ! running web; then
      build_web
      (cd apps/web && exec nohup pnpm exec serve out -l 3000 -L) >"$state/web.log" 2>&1 </dev/null &
      echo $! >"$state/web.pid"
    fi
    for _ in $(seq 1 60); do curl -fs -o /dev/null http://localhost:3000/sign-in/ && break; sleep 2; done
    . "$state/logins.env"
    say "Watson is running: http://localhost:3000  (sign in as $LOCAL_LOGIN, password $LOCAL_PASSWORD)"
    echo "Logs: .local/engine.log and .local/web.log. Stop with: scripts/local.sh stop"
    [ -s "$online" ] && echo "Online services on: $(has_key STRIPE_SECRET_KEY && echo payments) $(has_key GOOGLE_CLIENT_ID && echo 'Google Calendar')"
    ;;
  stop)
    for part in web engine functions; do
      if running "$part"; then pkill -P "$(cat "$state/$part.pid")" 2>/dev/null || true; kill "$(cat "$state/$part.pid")" 2>/dev/null || true; fi
      rm -f "$state/$part.pid"
    done
    supabase stop
    ;;
  check)
    running web && running engine || { echo "Start Watson first: scripts/local.sh start" >&2; exit 1; }
    . "$state/logins.env"
    (cd apps/web && LOCAL_LOGIN="$LOCAL_LOGIN" LOCAL_PASSWORD="$LOCAL_PASSWORD" pnpm exec playwright test -c playwright.local.config.ts)
    ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
