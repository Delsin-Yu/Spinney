<#
  Hyper-Vscode daemon bootstrap (workspace-local, not shipped with the extension).

  Usage:
    powershell -ExecutionPolicy Bypass -File tools\hyper-vscode\serve.ps1
    powershell -ExecutionPolicy Bypass -File tools\hyper-vscode\serve.ps1 -Port 7800 -Workspace . 
    powershell -ExecutionPolicy Bypass -File tools\hyper-vscode\serve.ps1 -NoInstance   # daemon only

  The daemon must outlive the VS Code window it manages: run it in a standalone
  terminal (NOT as a VS Code task and NOT as a harness background terminal, both
  of which die when the window reloads).
#>
param(
  [int]$Port = 7788,
  [string]$Workspace = $null,
  [switch]$NoInstance,
  [switch]$Isolated,
  [string]$Code = ''
)

$ErrorActionPreference = 'Stop'
$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $toolDir 'hvsc.mjs'
if (-not (Test-Path $entry)) { throw "hvsc.mjs not found next to serve.ps1 ($entry)" }
if ($Code) { $env:HYPER_VSCODE_CODE = $Code }

$nodeArgs = @($entry, 'serve', '--port', "$Port")
if ($Isolated) { $nodeArgs += '--isolated' }
if ($Workspace -and -not $NoInstance) {
  $nodeArgs += @('--start', (Resolve-Path -Path $Workspace).Path)
}

Write-Host "Hyper-Vscode daemon -> http://127.0.0.1:$Port   (Ctrl+C to stop)" -ForegroundColor Cyan
Write-Host "  hvsc start <workspace> | hvsc status | hvsc reboot <id> --continue ""...""" -ForegroundColor DarkGray
& node @nodeArgs
