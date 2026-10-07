#!/usr/bin/env bash
# A full run (collect, triage, commit) every 5 minutes for about 4 hours. The workflow starts the
# next run when this one ends. See feedback/README.md.
set -uo pipefail

if [ "${FEEDBACK_HAS_KEY:-true}" = "false" ]; then
  echo "::warning::Player feedback is paused: add the ANTHROPIC_API_KEY secret (see feedback/README.md)"
  exit 1
fi

loop_seconds=${FEEDBACK_LOOP_SECONDS:-14400}
tick=300
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
  if python feedback/run.py; then
    unset FEEDBACK_RESORT  # a re-sort happens once; the following runs carry on from it
    commit
  else
    echo "::warning::This run failed; the next one tries again."
  fi
  # A new store page, release or sale: rebuild the site now rather than at the daily rebuild.
  if [ -f feedback/.cache/rebuild-site ]; then
    gh workflow run static.yml --ref main && rm feedback/.cache/rebuild-site
  fi
  (( SECONDS + tick > end )) && break
  sleep $(( tick - (SECONDS - started) > 0 ? tick - (SECONDS - started) : 0 ))
done
