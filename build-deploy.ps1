# build-deploy.ps1 — quick iteration: compile, package, and install the extension.
param(
  [switch]$NoInstall  # build + package only, skip installing into VS Code
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host '== Cleaning out/ ==' -ForegroundColor Cyan
# tsc only adds/overwrites — it never prunes. Without this, the compiled output of
# a deleted module keeps shipping inside the .vsix (that is how a removed feature's
# code survived here before).
if (Test-Path 'out') { Remove-Item -Recurse -Force 'out' }

Write-Host '== Compiling ==' -ForegroundColor Cyan
& npm run compile
if ($LASTEXITCODE -ne 0) { throw 'Compile failed.' }

Write-Host '== Packaging ==' -ForegroundColor Cyan
& .\node_modules\.bin\vsce package --allow-missing-repository
if ($LASTEXITCODE -ne 0) { throw 'Package failed.' }

if ($NoInstall) {
  Write-Host 'Skipping install (build + package only).' -ForegroundColor Yellow
  exit 0
}

$vsix = Get-ChildItem -Filter '*.vsix' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) { throw 'No .vsix file found.' }

$cmd = Get-Command code -ErrorAction SilentlyContinue
$code = if ($cmd) { $cmd.Source } else { 'code' }

Write-Host "== Installing $($vsix.Name) ==" -ForegroundColor Cyan
& $code --install-extension $vsix.FullName --force
if ($LASTEXITCODE -ne 0) { throw 'Install failed.' }

Write-Host 'Done. Reload the VS Code window to activate the changes.' -ForegroundColor Green
