#!/usr/bin/env bash
set -euo pipefail

mode=${WATSON_DATA_MODE:-synthetic}
if [[ "$mode" == "synthetic" ]]; then
  echo "data mode: synthetic (Gate R closed)"
  exit 0
fi

cat >&2 <<'EOF'
REFUSED: real-patient mode is not implemented and Gate R is closed.
No environment flag can bypass this control. Complete docs/gate-r-readiness.md,
implement its security architecture, obtain named legal/clinical approvals, and
replace this fail-closed guard in a separately reviewed release.
EOF
exit 1
