#!/bin/sh
# Keeps these mods identical across machines.
# 1. copy each mod from ~/.config/herdr-app/mods into the repo (the live copy is the one you edit),
# 2. commit, pull --rebase, push,
# 3. copy the result back, so herdr hot-reloads what came from the other machine.
# On a conflict it stops and writes sync/last-error.log.
cd "$(dirname "$0")/.." || exit 1
MODS="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
PAIRS="workbench:code agents-by-repo:my-agents files-to-editor:my-files"
log=sync/last-error.log
copy() { # copy src dst, mirror, without herdr's generated files
  mkdir -p "$2"
  rsync -a --delete --exclude gpui-kit.d.ts --exclude jsconfig.json "$1/" "$2/"
}
for p in $PAIRS; do [ -d "$MODS/${p#*:}" ] && copy "$MODS/${p#*:}" "${p%%:*}/mods/${p#*:}"; done
git add -A
git diff --cached --quiet || git commit -q -m "sync: $(uname -s | tr A-Z a-z)"
if ! out=$(git pull -q --rebase --autostash 2>&1); then
  git rebase --abort 2>/dev/null
  printf '%s pull failed\n%s\n' "$(date)" "$out" > "$log"; exit 1
fi
for p in $PAIRS; do rsync -a --exclude gpui-kit.d.ts --exclude jsconfig.json "${p%%:*}/mods/${p#*:}/" "$MODS/${p#*:}/"; done
if ! out=$(git push -q 2>&1); then printf '%s push failed\n%s\n' "$(date)" "$out" > "$log"; exit 1; fi
rm -f "$log"
