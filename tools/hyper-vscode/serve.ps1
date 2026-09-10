<#
  Hyper-Vscode daemon bootstrap (workspace-local, not shipped with the extension).

  Usage:
    powershell -ExecutionPolicy Bypass -File tools\hyper-vscode\serve.ps1
    powershell -ExecutionPolicy Bypass -File tools\hyper-vscode\serve.ps1 -Port 7800 -Workspace . 
    powershell -ExecutionPolicy Bypass -File tools\hyper-vscode\serve.ps1 -NoWorkspace  # no-repo instance (bare window)
    powershell -ExecutionPolicy Bypass -File tools\hyper-vscode\serve.ps1 -NoInstance   # daemon only

  -NoWorkspace starts a window with no folder open: `code -n` with no path, the
  extension publishes `workspace: null`. Mutually exclusive with -Workspace.

  The daemon must outlive the VS Code window it manages: run it in a standalone
  terminal (NOT as a VS Code task and NOT as a harness background terminal, both
  of which die when the window reloads).
#>
param(
  [int]$Port = 7788,
  [string]$Workspace = $null,
  [switch]$NoWorkspace,
  [switch]$NoInstance,
  [switch]$Isolated,
  [string]$Code = ''
)

$ErrorActionPreference = 'Stop'
$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $toolDir 'hvsc.mjs'
if (-not (Test-Path $entry)) { throw "hvsc.mjs not found next to serve.ps1 ($entry)" }
if ($Code) { $env:HYPER_VSCODE_CODE = $Code }
if ($Workspace -and $NoWorkspace) { throw "-Workspace and -NoWorkspace are mutually exclusive" }

$nodeArgs = @($entry, 'serve', '--port', "$Port")
if ($Isolated) { $nodeArgs += '--isolated' }
if (-not $NoInstance) {
  if ($NoWorkspace) {
    # No-repo mode: no path to resolve, `hvsc serve --no-workspace` spawns `code -n`.
    $nodeArgs += '--no-workspace'
  } elseif ($Workspace) {
    $nodeArgs += @('--start', (Resolve-Path -Path $Workspace).Path)
  }
}

Write-Host "Hyper-Vscode daemon -> http://127.0.0.1:$Port   (Ctrl+C to stop)" -ForegroundColor Cyan
Write-Host "  hvsc start <workspace> | hvsc start --no-workspace | hvsc status | hvsc reboot <id> --continue ""...""" -ForegroundColor DarkGray
& node @nodeArgs
