#!/usr/bin/env bash
# Builds and publishes the web app on Render from the latest commit on main, and waits.
# Render only deploys by itself when its GitHub app is installed on the repository;
# until then this script is how a deploy is triggered.
#
# The site is Watson's own (Render account watson.assists@gmail.com, since 24 Oct 2026), created
# once through the API (POST /v1/services) as a static site named watson-assists:
#   repo https://github.com/watson-assists/watson, branch main, auto-deploy off,
#   build "npx --yes pnpm@12.15.0 install --frozen-lockfile && npx --yes pnpm@12.15.0 --filter web build"
#   (pnpm 12.15.0, as package.json's packageManager since Prasanth's upgrade of 24 Oct),
#   publish apps/web/out, env NODE_VERSION=24.11.1, NEXT_PUBLIC_SUPABASE_URL and
#   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (the project's publishable key);
#   headers for /*: Content-Security-Policy: frame-ancestors 'none'; X-Frame-Options: DENY;
#   X-Content-Type-Options: nosniff; Referrer-Policy: no-referrer;
#   short links: a rewrite /j/* -> /j/index.html, so /j/K7P4QX9M serves the page that opens the
#   patient's link (apps/web/public/serve.json does the same locally).
# Its address is https://watson-assists.onrender.com. Until 24 Oct it was watson-app.onrender.com
# under the owner's own Render account; Render keeps that name, so old links there no longer open.
export RENDER_CLI_CONFIG_PATH="${RENDER_CLI_CONFIG_PATH:-$HOME/.render/profiles/watson-assists.yaml}"
set -euo pipefail
"$(dirname "$0")/check-data-mode.sh"
service=${WATSON_RENDER_SERVICE:-srv-dbedrugm7kps73diurlg}
render deploys create "$service" --confirm -o json >/dev/null
for _ in $(seq 1 90); do
  status=$(render deploys list "$service" -o json --confirm | python3 -c "import json,sys; d=json.load(sys.stdin)[0]; print(d.get('deploy', d).get('status'))")
  case "$status" in
    live) echo "deployed"; exit 0 ;;
    build_failed|update_failed|canceled|deactivated) echo "deploy $status"; exit 1 ;;
  esac
  sleep 10
done
echo "deploy still running after 15 minutes"; exit 1
