# Live check of the other-agent wait. A throwaway Edge window started under automation shows "being
# controlled by automated test software", like a browser another agent drives. A Clicky task should
# wait and say so on the strip, then:
#   -Mode close: carry on by itself once that window closes (the other agent finished);
#   -Mode play:  carry on at once when play is pressed on the strip.
#   powershell -File other-agent.ps1 -Mode close
param([ValidateSet('close', 'play')][string]$Mode = 'close')
. "$PSScriptRoot\win.ps1"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$log = Join-Path $env:APPDATA 'Clicky\logs\clicky.log'
$root = [System.Windows.Automation.AutomationElement]::RootElement
$profileDir = Join-Path $env:TEMP 'clicky-other-agent-edge'

function LogSince([long]$Offset) {
  $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'); $fs.Seek($Offset, 'Begin') | Out-Null
  $t = (New-Object System.IO.StreamReader($fs)).ReadToEnd(); $fs.Close(); $t
}
function ClickyElements {
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
function Stop-TestEdge {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object CommandLine -like "*clicky-other-agent-edge*" |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$edge = @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', 'C:\Program Files\Microsoft\Edge\Application\msedge.exe') |
  Where-Object { Test-Path $_ } | Select-Object -First 1
Start-Process $edge -ArgumentList '--enable-automation', "--user-data-dir=$profileDir", '--no-first-run', 'about:blank'
Start-Sleep 6

$results = @("Mode: $Mode")
$o = (Get-Item $log).Length
$wav = Join-Path $env:TEMP 'clicky-other-agent.wav'
New-SpokenWav 'Clicky, open Notepad.' $wav
Invoke-Spoken $wav

$results += "Waits while another agent drives the PC: $(WaitLog $o 'agent waiting: another agent' 60)"
Start-Sleep 2
$results += "Strip says so: $([bool](ClickyElements | Where-Object { $_.Current.Name -match 'Another agent is using this PC' } | Select-Object -First 1))"
Start-Sleep 8
$results += "No steps while waiting: $(-not ((LogSince $o) -match 'agent step 1:'))"

if ($Mode -eq 'close') {
  Stop-TestEdge
  $results += "Resumes by itself when the other agent is gone: $(WaitLog $o 'agent resuming' 30)"
} else {
  $play = ClickyElements | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq 'Resume' } | Select-Object -First 1
  if ($play) { $play.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  $results += "Play pressed: $([bool]$play)"
}
$results += "Takes its first step: $(WaitLog $o 'agent step 1:' 60)"
$results += "Finished: $(WaitLog $o 'agent done after|agent gave up|agent unfinished' 90)"
Stop-TestEdge
$results
