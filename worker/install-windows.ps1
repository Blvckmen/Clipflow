# Registers (or removes, with -Remove) a scheduled task that starts the Clipflow worker hidden at sign-in.
#   powershell -ExecutionPolicy Bypass -File worker\install-windows.ps1
#   powershell -ExecutionPolicy Bypass -File worker\install-windows.ps1 -Remove
param([switch]$Remove)
$name = "Clipflow worker"
if ($Remove) {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  "Removed scheduled task '$name'."
  return
}
$launcher = Join-Path $PSScriptRoot "run-windows.ps1"
$shell = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $shell) { $shell = (Get-Command powershell).Source }
$action = New-ScheduledTaskAction -Execute $shell -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`"" -WorkingDirectory $PSScriptRoot
$atLogOn = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# Every 5 minutes, start it again if it is not running (IgnoreNew below makes this a no-op while it runs). This
# brings the worker back if Windows closes its console or the launcher dies, without waiting for a new sign-in.
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$trigger = @($atLogOn, $watchdog)
# Keep running on battery and with no time limit; the launcher itself restarts the worker.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description "Records live streams and makes Clipflow clips." -Force | Out-Null
"Registered scheduled task '$name' (starts at sign-in and is restarted within 5 minutes if it stops). Start it now with: Start-ScheduledTask -TaskName '$name'"
