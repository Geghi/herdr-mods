# Keeps these mods identical across machines.
# 1. copy each mod from ~/.config/herdr-app/mods into the repo (the live copy is the one you edit),
# 2. commit, pull --rebase, push,
# 3. copy the result back, so herdr hot-reloads what came from the other machine.
# On a conflict it stops and writes sync\last-error.log.
Set-Location (Split-Path -Parent $PSScriptRoot)
$mods = Join-Path ($(if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { "$HOME\.config\herdr-app" })) "mods"
$pairs = @{ "workbench" = "code"; "agents-by-repo" = "my-agents"; "files-to-editor" = "my-files" }
$log = "sync\last-error.log"
$skip = @("/XF", "gpui-kit.d.ts", "jsconfig.json", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
foreach ($k in $pairs.Keys) {
  $live = Join-Path $mods $pairs[$k]
  if (Test-Path $live) { robocopy $live "$k\mods\$($pairs[$k])" /MIR @skip | Out-Null }
}
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { git commit -q -m "sync: windows" }
$out = (git pull -q --rebase --autostash 2>&1 | ForEach-Object { "$_" }) -join "`n"
if ($LASTEXITCODE -ne 0) {
  git rebase --abort 2>$null
  "$(Get-Date) pull failed`n$out" | Out-File -Encoding utf8 $log; exit 1
}
foreach ($k in $pairs.Keys) { robocopy "$k\mods\$($pairs[$k])" (Join-Path $mods $pairs[$k]) /E @skip | Out-Null }
$out = (git push -q 2>&1 | ForEach-Object { "$_" }) -join "`n"
if ($LASTEXITCODE -ne 0) { "$(Get-Date) push failed`n$out" | Out-File -Encoding utf8 $log; exit 1 }
Remove-Item $log -ErrorAction SilentlyContinue
exit 0
