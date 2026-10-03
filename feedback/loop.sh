#!/usr/bin/env bash
# A full run (collect, triage, commit) every 10 minutes for about 4 hours. The workflow starts the
# next run when this one ends. See feedback/README.md.
set -uo pipefail

if [ "${FEEDBACK_HAS_KEY:-true}" = "false" ]; then
  echo "::warning::Player feedback is paused: add the ANTHROPIC_API_KEY secret (see feedback/README.md)"
  exit 1
fi

loop_seconds=${FEEDBACK_LOOP_SECONDS:-14400}
tick=600
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
  python feedback/run.py && commit || echo "::warning::This run failed; the next one tries again."
  (( SECONDS + tick > end )) && break
  sleep $(( tick - (SECONDS - started) > 0 ? tick - (SECONDS - started) : 0 ))
done
