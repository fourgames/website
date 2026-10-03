#!/usr/bin/env bash
# Checks every 20 minutes for about 4 hours: the gate, then a full run (collect, triage, commit)
# whenever it says one is due. The workflow starts the next run when this one ends. See
# feedback/README.md.
set -uo pipefail

loop_seconds=${FEEDBACK_LOOP_SECONDS:-14400}
tick=1200
force=${FEEDBACK_FORCE:-false}
end=$((SECONDS + loop_seconds))

commit() {
  git add feedback/data
  if git diff --cached --quiet; then
    echo "Nothing changed."
    return 0
  fi
  git commit -q -m "Update player feedback"
  for attempt in 1 2 3; do
    git pull -q --rebase origin main && git push -q origin HEAD:main && return 0
    sleep 5
  done
  return 1
}

while :; do
  started=$SECONDS
  # Other commits (yours, or code changes) land between checks.
  git pull -q --rebase origin main || git rebase --abort 2>/dev/null
  gate=$(FEEDBACK_FORCE=$force python feedback/run.py --gate)
  echo "$gate"
  if grep -q '^run=true$' <<<"$gate"; then
    python feedback/run.py && commit || echo "::warning::This check failed; the next one tries again."
  fi
  force=false
  (( SECONDS + tick > end )) && break
  sleep $(( tick - (SECONDS - started) > 0 ? tick - (SECONDS - started) : 0 ))
done
