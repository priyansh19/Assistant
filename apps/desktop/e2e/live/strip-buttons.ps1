# Live check of the notch (task strip) and the Allow all orb: presses their buttons through UI
# Automation during real agent runs and reads Clicky's log for the effect.
#   powershell -File strip-buttons.ps1
. "$PSScriptRoot\win.ps1"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$log = Join-Path $env:APPDATA 'Clicky\logs\clicky.log'
$root = [System.Windows.Automation.AutomationElement]::RootElement
$button = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)

function Find-Button([string]$Name, [int]$TimeoutSec = 20) {
  $end = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $end) {
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      try { if ($w.Current.ProcessId -notin (Get-Process Clicky).Id) { continue } } catch { continue }
      foreach ($b in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $button)) {
        if ($b.Current.Name -match "^$Name$") { return $b }
      }
    }
    Start-Sleep -Milliseconds 500
  }
  return $null
}
function Press([string]$Name) {
  $b = Find-Button $Name
  if (-not $b) { "MISSING button: $Name"; return $false }
  $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  "pressed: $Name"
  return $true
}
function LogSince([long]$Offset) {
  $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'); $fs.Seek($Offset, 'Begin') | Out-Null
  $t = (New-Object System.IO.StreamReader($fs)).ReadToEnd(); $fs.Close(); $t
}
function Say([string]$Text) {
  $wav = Join-Path $env:TEMP 'clicky-strip.wav'
  New-SpokenWav $Text $wav
  Invoke-Spoken $wav
}

$results = @()

# 1. Allow all, then the orb's Turn off, during a long task.
$o = (Get-Item $log).Length
Say 'Clicky, open YouTube and search for lo-fi study music.'
Press 'Allow all' | Out-Host
Start-Sleep 2
$on = (LogSince $o) -match 'allow all on'
$results += "Allow all on: $on"
Press 'Turn off' | Out-Host
Start-Sleep 2
$off = (LogSince $o) -match 'allow all off'
$results += "Orb Turn off: $off"

# 2. Pause, then Stop.
Press 'Pause' | Out-Host
Start-Sleep 4
$before = ([regex]::Matches((LogSince $o), 'agent step \d+:')).Count
Start-Sleep 6
$after = ([regex]::Matches((LogSince $o), 'agent step \d+:')).Count
$results += "Pause holds the run: $($before -eq $after) ($before -> $after steps)"
Press 'Stop' | Out-Host
Start-Sleep 3
$results += "Stop ends the run: $((LogSince $o) -match 'stopped from the task strip|Okay, I stopped|agent stopped')"

# 3. Allow on a risky step (deleting a test file Clicky made for this).
$f = Join-Path ([Environment]::GetFolderPath('Desktop')) 'clicky-allow-test.txt'
Set-Content $f 'test file for the Allow button'
Start-Sleep 25
$o = (Get-Item $log).Length
Say 'Clicky, delete the file clicky-allow-test.txt from my desktop.'
$end = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $end -and (LogSince $o) -notmatch 'asking to allow') { Start-Sleep 1 }
Press 'Allow' | Out-Host
Start-Sleep 12
$results += "Allow lets the risky step run: $(-not (Test-Path $f))"
Remove-Item $f -ErrorAction SilentlyContinue
$results
