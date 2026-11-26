#!/bin/sh
# Commit local mod changes, rebase on the remote, push. Stops on a conflict.
cd "$(dirname "$0")/.." || exit 1
log=sync/last-error.log
git add -A
git diff --cached --quiet || git commit -q -m "sync: $(uname -s | tr A-Z a-z)"
if ! out=$(git pull -q --rebase --autostash 2>&1); then
  git rebase --abort 2>/dev/null
  printf '%s pull failed\n%s\n' "$(date)" "$out" > "$log"; exit 1
fi
if ! out=$(git push -q 2>&1); then printf '%s push failed\n%s\n' "$(date)" "$out" > "$log"; exit 1; fi
rm -f "$log"
