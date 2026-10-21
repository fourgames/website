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

while :; do
  started=$SECONDS
  # Other commits (yours, or code changes) land between checks.
  git pull -q --rebase origin main || git rebase --abort 2>/dev/null
  # And what the dashboard and the task on your Mac saved to the data (marked fixes, refund notes…).
  data pull -q --rebase origin main || data rebase --abort 2>/dev/null
  # A run that hangs (a stuck request) is stopped, so it can't hold back fresh data for hours. Each
  # game's file is saved whole as the run goes, so what it finished is committed either way.
  if timeout -k 30 "$run_limit" python -u feedback/run.py --part "$part"; then
    unset FEEDBACK_RESORT  # a re-sort happens once; the following runs carry on from it
  else
    echo "::warning::This run failed or took over $((run_limit / 60)) minutes; the next one tries again."
  fi
  commit
  # A new store page, release or sale: rebuild the site now rather than at the daily rebuild.
  if [ -f feedback/.cache/rebuild-site ]; then
    gh workflow run static.yml --ref main && rm feedback/.cache/rebuild-site
  fi
  (( SECONDS + tick > end )) && break
  sleep $(( tick - (SECONDS - started) > 0 ? tick - (SECONDS - started) : 0 ))
done
