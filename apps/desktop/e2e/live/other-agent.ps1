# Live check of the other-agent wait: while a browser shows that another agent is driving it
# ("Claude" started debugging this browser), a Clicky task should wait and say so on the strip, and
# go on when play is pressed. Needs such a bar to be up already (the script checks first).
#   powershell -File other-agent.ps1
. "$PSScriptRoot\win.ps1"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$log = Join-Path $env:APPDATA 'Clicky\logs\clicky.log'
$root = [System.Windows.Automation.AutomationElement]::RootElement

function LogSince([long]$Offset) {
  $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'); $fs.Seek($Offset, 'Begin') | Out-Null
  $t = (New-Object System.IO.StreamReader($fs)).ReadToEnd(); $fs.Close(); $t
}
function ClickyTexts {
  $ids = (Get-Process Clicky).Id
  foreach ($w in $root.FindAll('Children', [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($w.Current.ProcessId -notin $ids) { continue }
    foreach ($e in $w.FindAll('Descendants', [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($e.Current.Name) { $e }
    }
  }
}
function WaitLog([long]$Offset, [string]$Pattern, [int]$Sec) {
  $end = (Get-Date).AddSeconds($Sec)
  while ((Get-Date) -lt $end) { if ((LogSince $Offset) -match $Pattern) { return $true }; Start-Sleep 1 }
  return $false
}

$results = @()
$o = (Get-Item $log).Length
$wav = Join-Path $env:TEMP 'clicky-other-agent.wav'
New-SpokenWav 'Clicky, open Notepad.' $wav
Invoke-Spoken $wav

$waited = WaitLog $o 'agent waiting: another agent' 60
$results += "Waits while another agent drives the PC: $waited"
Start-Sleep 2
$strip = (ClickyTexts | Where-Object { $_.Current.Name -match 'Another agent is using this PC' } | Select-Object -First 1)
$results += "Strip says so: $([bool]$strip)"
# No step may run while waiting.
Start-Sleep 6
$results += "No steps while waiting: $(-not ((LogSince $o) -match 'agent step 1:'))"

$play = ClickyTexts | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq 'Resume' } | Select-Object -First 1
if ($play) { $play.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
$results += "Play pressed: $([bool]$play)"
$results += "Goes on after play: $(WaitLog $o 'agent step 1:' 60)"
$results += "Finished: $(WaitLog $o 'agent done after|agent gave up|agent unfinished' 90)"
$results
