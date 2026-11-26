# Sets up the Clipflow worker on a Windows 10/11 PC in one go: installs what it needs (with winget), pairs the PC with
# a code from the dashboard (Connect worker -> Make a pairing code), and starts it at every sign-in.
#   Double-click "Setup Clipflow.cmd", or:
#   powershell -ExecutionPolicy Bypass -File worker\setup-windows.ps1 [-Site https://your-site] [-Code XXXX-XXXX]
# Options:
#   -Check      only report what is installed and what is missing; changes nothing
#   -NoAI       skip Ollama and its model (opening titles and post text then come from the transcript alone)
#   -WithMusic  also install Demucs (about 2 GB) for "turn the music down"
#   -Yes        don't ask; use the defaults
# Safe to run again: anything already there is kept, and an already-paired PC stays paired unless you give a new code.
# Works in Windows PowerShell 5.1 (no newer syntax).
param([string]$Site = "", [string]$Code = "", [switch]$Check, [switch]$NoAI, [switch]$WithMusic, [switch]$Yes)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$taskName = "Clipflow worker"
$problems = New-Object System.Collections.Generic.List[string]

function Say($text) { Write-Host $text }
function Ok($text) { Write-Host "  [ok]      $text" -ForegroundColor Green }
function Missing($text) { Write-Host "  [missing] $text" -ForegroundColor Yellow }
function Bad($text) { Write-Host "  [problem] $text" -ForegroundColor Red; $problems.Add($text) }
function Ask($question, $default) {
  if ($Yes) { return $default }
  $answer = Read-Host "$question [$(if ($default) { 'Y/n' } else { 'y/N' })]"
  if (-not $answer) { return $default }
  return $answer -match '^(y|yes)$'
}
# Programs winget just installed aren't on this window's PATH yet: read it again from the registry.
function Update-Path {
  $env:PATH = [Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH", "User")
}
function Have($command) { return [bool](Get-Command $command -ErrorAction SilentlyContinue) }
function Winget-Install($id, $label) {
  if (-not (Have "winget")) { Bad "$label is missing and winget isn't available. Install 'App Installer' from the Microsoft Store, then run this again."; return $false }
  Say "  Installing $label..."
  & winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
  Update-Path
  return $true
}

# Each check returns $true when the part is ready. Without -Check, a missing part is installed and checked again.
function Node-Ready {
  if (-not (Have "node")) { return $false }
  $major = [int](((& node --version) -replace '^v', '') -split '\.')[0]
  return $major -ge 24
}
function Python-Ready {
  if (-not (Have "py")) { return $false }
  & py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>$null
  return $LASTEXITCODE -eq 0
}
function Module-Ready($module) {
  & py -3 -c "import $module" 2>$null
  return $LASTEXITCODE -eq 0
}
$parts = @(
  @{ Label = "Node.js 24 or newer"; Ready = { Node-Ready }; Id = "OpenJS.NodeJS.LTS" },
  @{ Label = "Python 3.10 or newer (py)"; Ready = { Python-Ready }; Id = "Python.Python.3.12" },
  @{ Label = "ffmpeg"; Ready = { Have "ffmpeg" }; Id = "Gyan.FFmpeg" }
)
# Python packages: the module to import, then what pip installs.
$packages = @(
  @("streamlink", "streamlink"), @("faster_whisper", "faster-whisper"), @("numpy", "numpy"), @("cv2", "opencv-python-headless"),
  @("PIL", "pillow"), @("freetype", "freetype-py"), @("yt_dlp", "yt-dlp"), @("rapidocr_onnxruntime", "rapidocr_onnxruntime"), @("yaml", "pyyaml")
)
if ($WithMusic) { $packages += ,@("demucs", "demucs") }

Say ""
Say "Clipflow worker setup$(if ($Check) { ' (check only: nothing is changed)' })"
Say ""
Say "Programs"
foreach ($p in $parts) {
  if (& $p.Ready) { Ok $p.Label; continue }
  if ($Check) { Missing $p.Label; continue }
  if ((Winget-Install $p.Id $p.Label) -and (& $p.Ready)) { Ok $p.Label } else { Bad "$($p.Label) didn't install. Install it by hand, then run this again." }
}

Say ""
Say "Python packages"
if (-not (Python-Ready)) { Missing "Python packages (need Python first)" }
else {
  $need = @($packages | Where-Object { -not (Module-Ready $_[0]) })
  foreach ($pkg in $packages) { if ($need -contains $pkg) { Missing $pkg[1] } else { Ok $pkg[1] } }
  if ($need.Count -and -not $Check) {
    Say "  Installing $(($need | ForEach-Object { $_[1] }) -join ', ')..."
    & py -3 -m pip install --upgrade --disable-pip-version-check ($need | ForEach-Object { $_[1] }) | Out-Host
    foreach ($pkg in $need) { if (Module-Ready $pkg[0]) { Ok $pkg[1] } else { Bad "$($pkg[1]) didn't install (py -m pip install $($pkg[1]))." } }
  }
}

Say ""
Say "Local AI writer"
# The 7B model writes better titles but needs about 8 GB of free memory; smaller PCs get the 3B one.
$ramGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$model = if ($ramGb -ge 16) { "qwen2.5:7b" } else { "qwen2.5:3b" }
if ($NoAI) { Say "  skipped (-NoAI): titles and post text come from the transcript" }
else {
  if (-not (Have "ollama")) {
    if ($Check) { Missing "Ollama" } elseif (Winget-Install "Ollama.Ollama" "Ollama") { if (Have "ollama") { Ok "Ollama" } else { Bad "Ollama didn't install." } }
  } else { Ok "Ollama" }
  if (Have "ollama") {
    $models = (& ollama list 2>$null) -join "`n"
    if ($models -match [regex]::Escape($model)) { Ok "model $model ($ramGb GB of memory)" }
    elseif ($Check) { Missing "model $model ($ramGb GB of memory)" }
    else {
      Say "  Downloading $model (a few GB, once)..."
      & ollama pull $model | Out-Host
      if ($LASTEXITCODE -eq 0) { Ok "model $model" } else { Bad "Couldn't download $model (ollama pull $model)." }
    }
    # The worker uses qwen2.5:7b unless told otherwise; on a smaller PC, point it at the 3B model.
    if ($model -ne "qwen2.5:7b" -and -not $Check) { $script:setModel = $model }
  }
}

Say ""
Say "Pairing"
$envFile = Join-Path $here ".env"
# Values may be quoted, as run-windows.ps1 allows.
$paired = (Test-Path $envFile) -and ((Get-Content $envFile) -match '^\s*CLIPFLOW_TOKEN\s*=\s*["'']?cfw_[0-9a-f]{64}["'']?\s*$') -and ((Get-Content $envFile) -match '^\s*CLIPFLOW_URL\s*=')
if ($paired -and -not $Code) { Ok "already paired (worker\.env). To pair again, run this with -Code" }
elseif ($Check) { if ($paired) { Ok "already paired" } else { Missing "not paired yet" } }
elseif (-not (Node-Ready)) { Bad "Can't pair without Node.js." }
else {
  # The download from the dashboard says which site it came from (site.txt, from scripts/pack-worker.mjs).
  $siteFile = Join-Path $here "site.txt"
  if (-not $Site -and (Test-Path $siteFile)) { $Site = (Get-Content $siteFile -TotalCount 1).Trim(); if ($Site) { Say "  Site: $Site" } }
  if (-not $Site) { $Site = Read-Host "  Your Clipflow site address (e.g. https://clipflow.example.com)" }
  if (-not $Code) { $Code = Read-Host "  Pairing code (dashboard: Connect worker -> Make a pairing code)" }
  & node (Join-Path $here "pair.mjs") $Site $Code
  if ($LASTEXITCODE -eq 0) { Ok "paired" } else { Bad "Pairing didn't work. Make a new code in the dashboard and run this again." }
}
if ($script:setModel -and (Test-Path $envFile) -and -not ((Get-Content $envFile) -match '^\s*OLLAMA_MODEL\s*=')) {
  Add-Content -Path $envFile -Value "OLLAMA_MODEL=$($script:setModel)"
  Ok "AI writer set to $($script:setModel) in worker\.env"
}

Say ""
Say "Always on"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($Check) { if ($task) { Ok "scheduled task '$taskName' ($($task.State))" } else { Missing "scheduled task '$taskName'" } }
elseif ($problems.Count) { Bad "Not starting the worker until the problems above are fixed." }
else {
  & (Join-Path $here "install-windows.ps1") | Out-Host
  # A full restart, so the worker reads worker\.env again: stop the task, end any worker still running, start it.
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'worker[\\/]main\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $log = Join-Path $here "data\worker.log"
  $before = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }
  Start-ScheduledTask -TaskName $taskName
  Say "  Starting the worker..."
  $started = $false
  for ($i = 0; $i -lt 60 -and -not $started; $i++) {
    Start-Sleep -Seconds 1
    if ((Test-Path $log) -and (Get-Item $log).Length -gt $before) {
      $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'); try { $fs.Seek($before, 'Begin') | Out-Null; $new = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
      if ($new -match 'Clipflow worker polling') { $started = $true }
    }
  }
  if ($started) { Ok "worker running; it starts again at every sign-in" } else { Bad "The worker didn't start within a minute. See worker\data\worker.log." }
  # A sleeping PC records nothing.
  if (Ask "  Keep this PC awake while it's plugged in, so it can record?" $true) { & powercfg /change standby-timeout-ac 0; Ok "PC stays awake on mains power" }
}

Say ""
if ($Check) { Say "Check finished. Run without -Check to install what's missing." }
elseif ($problems.Count) { Say "Setup finished with $($problems.Count) problem(s):"; $problems | ForEach-Object { Say "  - $_" }; exit 1 }
else { Say "All set. Open the dashboard: the worker shows as connected within a minute." }
