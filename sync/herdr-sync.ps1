# Commit local mod changes, rebase on the remote, push. Stops on a conflict.
Set-Location (Split-Path -Parent $PSScriptRoot)
$log = "sync\last-error.log"
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { git commit -q -m "sync: windows" }
$out = git pull -q --rebase --autostash 2>&1
if ($LASTEXITCODE -ne 0) {
  git rebase --abort 2>$null
  "$(Get-Date) pull failed`n$out" | Out-File -Encoding utf8 $log; exit 1
}
$out = git push -q 2>&1
if ($LASTEXITCODE -ne 0) { "$(Get-Date) push failed`n$out" | Out-File -Encoding utf8 $log; exit 1 }
Remove-Item $log -ErrorAction SilentlyContinue
