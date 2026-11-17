#!/usr/bin/env bash
# Applies the hosted Supabase project's sign-in rules (MASTER_BUILD_SPEC.md section 11):
# no public sign-up, passwords of at least 6 characters (short, memorable test logins, owner's
# choice of 16 Oct 2026; raise before real patients), and the app's address.
# Since 17 Nov 2026 (SEC-03) a patient's browser joins a call with an anonymous session. Supabase
# needs sign-up on for that, so public.hook_before_user_created (migration 20261117100000) refuses
# every other sign-up. Apply that migration before running this script.
# usage: scripts/configure-hosted-auth.sh [https://app-address]
set -euo pipefail
: "${SUPABASE_ACCESS_TOKEN:?set by .envrc}" "${SUPABASE_PROJECT_REF:?set by .envrc}"
settings='{"disable_signup": false, "external_anonymous_users_enabled": true, "hook_before_user_created_enabled": true, "hook_before_user_created_uri": "pg-functions://postgres/public/hook_before_user_created", "password_min_length": 6'
if [ $# -ge 1 ]; then settings="$settings, \"site_url\": \"$1\", \"uri_allow_list\": \"$1/**\""; fi
curl -fsS -X PATCH "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "$settings}" |
  python3 -c "import json,sys; c=json.load(sys.stdin); print({k: c.get(k) for k in ('disable_signup','external_anonymous_users_enabled','hook_before_user_created_enabled','password_min_length','site_url','uri_allow_list')})"
