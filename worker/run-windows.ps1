# Runs the Clipflow worker on Windows and restarts it if it exits. Started at sign-in by the
# "Clipflow worker" scheduled task (see install-windows.ps1); can also be run by hand.
# Settings: worker\.env (git-ignored) must define CLIPFLOW_URL and CLIPFLOW_TOKEN; any other worker
# variable from README.md may be added there too.
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$data = Join-Path $here "data"
$log = Join-Path $data "worker.log"
New-Item -ItemType Directory -Force $data | Out-Null

function Write-Log($text) { Add-Content -Path $log -Value ("{0:yyyy-MM-dd HH:mm:ss} [launcher] {1}" -f (Get-Date), $text) }

# Settings from worker\.env; values already set in the environment win.
$envFile = Join-Path $here ".env"
if (-not (Test-Path $envFile)) { Write-Log "worker\.env is missing; create it with CLIPFLOW_URL and CLIPFLOW_TOKEN."; exit 1 }
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$' -and $line -notmatch '^\s*#') {
    if (-not [Environment]::GetEnvironmentVariable($Matches[1])) { [Environment]::SetEnvironmentVariable($Matches[1], ($Matches[2] -replace '^([''"])(.*)\1$', '$2')) }
  }
}

# Windows defaults: the real Python is "py" (python.exe is usually the Store alias), and streamlink
# lives in the Python Scripts folder, which is often not on PATH.
if (-not $env:PYTHON) { $env:PYTHON = "py" }
$scripts = & py -c "import sysconfig; print(sysconfig.get_path('scripts'))" 2>$null
if ($scripts -and -not $env:STREAMLINK -and (Test-Path (Join-Path $scripts "streamlink.exe"))) { $env:STREAMLINK = Join-Path $scripts "streamlink.exe" }
if ($scripts) { $env:PATH = "$scripts;$env:PATH" }
if (-not $env:DATA_DIR) { $env:DATA_DIR = $data }
if (-not $env:WHISPER_DIR) { $env:WHISPER_DIR = Join-Path $data "models" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Log "node was not found on PATH."; exit 1 }

$delay = 5
while ($true) {
  # Keep the log under ~10 MB by rolling it over once.
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) { Move-Item -Force $log "$log.1" }
  Write-Log "starting worker against $env:CLIPFLOW_URL"
  $started = Get-Date
  & $node (Join-Path $here "main.mjs") *>> $log
  $code = $LASTEXITCODE
  # A run that lasted a while resets the backoff; quick repeated crashes back off up to 5 minutes.
  if (((Get-Date) - $started).TotalMinutes -gt 10) { $delay = 5 } else { $delay = [Math]::Min(300, $delay * 2) }
  Write-Log "worker exited with code $code; restarting in $delay s"
  Start-Sleep -Seconds $delay
}
