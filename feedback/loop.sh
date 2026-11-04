#!/usr/bin/env bash
# A full run (collect, triage, commit) every 5 minutes for about 4 hours. The workflow starts the
# next run when this one ends. See feedback/README.md.
set -uo pipefail

if [ "${FEEDBACK_HAS_KEY:-true}" = "false" ]; then
  echo "::warning::Player feedback is paused: add the ANTHROPIC_API_KEY secret (see feedback/README.md)"
  exit 1
fi

loop_seconds=${FEEDBACK_LOOP_SECONDS:-14400}
# "own" (your games) or "research": each has its own workflow, so they run side by side.
part=${FEEDBACK_PART:-own}
run_limit=${FEEDBACK_RUN_LIMIT:-1500}  # seconds before a hung run is stopped
tick=300
end=$((SECONDS + loop_seconds))
loop_started_at=$(date +%s)

# The data is its own private repo (fourgames/feedback-data), checked out at feedback/data.
data() { git -C feedback/data "$@"; }

commit() {
  data add -A
  if data diff --cached --quiet; then
    echo "Nothing changed."
    return 0
  fi
  data commit -q -m "Update player feedback"
  for attempt in 1 2 3; do
    data pull -q --rebase origin main && data push -q origin HEAD:main && return 0
    sleep 5
  done
  return 1
}

# On the server, after each run: how it went, for the dashboard's status (Caddy serves the folder at
# api.fourgames.se/status/, see server/Caddyfile). Written whole then moved, so it's never read
# half-written. Unset on GitHub, where the dashboard reads the workflow runs instead.
write_status() {  # ok, run seconds, seconds until the next run
  [ -n "${FEEDBACK_STATUS_DIR:-}" ] || return 0
  local file="$FEEDBACK_STATUS_DIR/$part.json" at
  at=$(date +%s)
  printf '{"part":"%s","host":"server","loopStartedAt":%d,"lastRunAt":%d,"lastRunOk":%s,"lastRunSeconds":%d,"nextRunAt":%d,"commit":"%s"}\n' \
    "$part" "$loop_started_at" "$at" "$1" "$2" "$((at + $3))" "$(git rev-parse --short HEAD 2>/dev/null)" > "$file.tmp" \
    && mv -f "$file.tmp" "$file"
}

while :; do
  started=$SECONDS
  # Other commits (yours, or code changes) land between checks.
  git pull -q --rebase origin main || git rebase --abort 2>/dev/null
  # And what the dashboard and the task on your Mac saved to the data (marked fixes, refund notes…).
  data pull -q --rebase origin main || data rebase --abort 2>/dev/null
  # A run that hangs (a stuck request) is stopped, so it can't hold back fresh data for hours. Each
  # game's file is saved whole as the run goes, so what it finished is committed either way.
  if timeout -k 30 "$run_limit" python -u feedback/run.py --part "$part"; then
    run_ok=true
    unset FEEDBACK_RESORT FEEDBACK_REVIEW_AGAIN  # a re-sort or review happens once; the following runs carry on from it
  else
    run_ok=false
    echo "::warning::This run failed or took over $((run_limit / 60)) minutes; the next one tries again."
  fi
  commit || run_ok=false
  # A new store page, release or sale: rebuild the site now rather than at the daily rebuild.
  if [ -f feedback/.cache/rebuild-site ]; then
    gh workflow run static.yml --ref main && rm feedback/.cache/rebuild-site
  fi
  pause=$(( tick - (SECONDS - started) > 0 ? tick - (SECONDS - started) : 0 ))
  write_status "$run_ok" "$((SECONDS - started))" "$pause"
  (( SECONDS + tick > end )) && break
  sleep "$pause"
done
