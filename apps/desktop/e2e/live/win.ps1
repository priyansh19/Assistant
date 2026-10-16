# Helpers for the live suite: window lists, opening test windows, speaking a prompt while holding
# the hold-to-talk key, and tapping a key. Dot-source it: . .\win.ps1
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class LiveWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // "process|title|state" per visible top-level app window, front first (Clicky's own excluded).
  public static string[] Windows() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;
      int c; if (DwmGetWindowAttribute(h, 14, out c, 4) == 0 && c != 0) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      var t = sb.ToString();
      if (t.Length == 0 || t == "Program Manager") return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string n = "";
      try { n = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { }
      if (n == "clicky") return true;
      list.Add(n + "|" + t + "|" + (IsIconic(h) ? "min" : IsZoomed(h) ? "max" : "normal"));
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  // Put a normal window (a browser, else File Explorer) in front, so the hold key is heard: Windows
  // hides key presses from Clicky while an administrator window like Task Manager is in front.
  public static bool FocusNormal() {
    IntPtr pick = IntPtr.Zero;
    foreach (var want in new[] { "comet", "chrome", "msedge", "explorer" }) {
      EnumWindows((h, l) => {
        if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
        var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        if (sb.Length == 0 || sb.ToString() == "Program Manager") return true;
        uint pid; GetWindowThreadProcessId(h, out pid);
        try { if (System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant() == want) { pick = h; return false; } } catch { }
        return true;
      }, IntPtr.Zero);
      if (pick != IntPtr.Zero) break;
    }
    if (pick == IntPtr.Zero) return false;
    keybd_event(0x87, 0, 0, UIntPtr.Zero); keybd_event(0x87, 0, 2, UIntPtr.Zero);
    return SetForegroundWindow(pick);
  }
  public static string Front() {
    var h = GetForegroundWindow();
    var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
    return sb.ToString();
  }
}
'@

function Get-AppWindows { [LiveWin]::Windows() }

# Hold Right Shift (or another virtual key), play the prompt through the speakers, let go.
function Invoke-Spoken([string]$Wav, [byte]$Vk = 0xA1) {
  [LiveWin]::keybd_event($Vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 350
  (New-Object Media.SoundPlayer $Wav).PlaySync()
  Start-Sleep -Milliseconds 450
  [LiveWin]::keybd_event($Vk, 0, 2, [UIntPtr]::Zero)
}

function Invoke-Tap([byte]$Vk = 0xA1) {
  [LiveWin]::keybd_event($Vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  [LiveWin]::keybd_event($Vk, 0, 2, [UIntPtr]::Zero)
}

function New-SpokenWav([string]$Text, [string]$Wav) {
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.Rate = 0
  $s.SetOutputToWaveFile($Wav)
  $s.Speak($Text)
  $s.Dispose()
}

# Close the Paint windows a test opened, discarding the test drawing (Don't save).
function Close-TestPaint {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $btnType = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  for ($round = 0; $round -lt 20; $round++) {
    $p = Get-Process mspaint -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) { 'no Paint left'; break }
    [void]$p.CloseMainWindow()
    Start-Sleep -Milliseconds 1500
    $win = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
    $done = $false
    foreach ($b in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnType)) {
      if ($b.Current.Name -match "^Don.t save$") {
        $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        "discarded Paint $($p.Id)"
        $done = $true
        break
      }
    }
    if (-not $done) { "no save prompt for $($p.Id)" }
    Start-Sleep -Milliseconds 1500
  }
}

# ---- Screen-awareness suite helpers.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$TestEdgeDir = Join-Path $env:TEMP 'clicky-test-edge'
$ProtectFile = Join-Path $env:APPDATA 'Clicky\protect.json'

# The process name of the window in front.
function Get-FrontProcess {
  Add-Type -Namespace LiveFg -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);' -ErrorAction SilentlyContinue
  $p = 0; [void][LiveFg.W]::GetWindowThreadProcessId([LiveFg.W]::GetForegroundWindow(), [ref]$p)
  (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
}

# A browser only the tests use (Edge with its own profile), so tidy-up tests never touch the user's tabs.
function Open-TestEdge([string[]]$Urls) {
  $edge = @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', 'C:\Program Files\Microsoft\Edge\Application\msedge.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
  # A fresh profile each time (no restored tabs from the last test, no extension welcome pages).
  Stop-TestEdge; Start-Sleep 1; Remove-Item $TestEdgeDir -Recurse -Force -ErrorAction SilentlyContinue
  Start-Process $edge -ArgumentList (@("--user-data-dir=$TestEdgeDir", '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--new-window') + $Urls)
  Start-Sleep 8
}
function Stop-TestEdge {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object CommandLine -like '*clicky-test-edge*' |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
# The tab titles of the test Edge windows.
function Get-TestEdgeTabs {
  $pids = (Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object CommandLine -like '*clicky-test-edge*').ProcessId
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $tab = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  foreach ($w in $root.FindAll('Children', [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($w.Current.ProcessId -notin $pids) { continue }
    foreach ($t in $w.FindAll('Descendants', $tab)) { $t.Current.Name }
  }
}
# The tab titles of every Comet window (read only).
function Get-CometTabs {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $tab = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  $pids = (Get-Process comet -ErrorAction SilentlyContinue).Id
  foreach ($w in $root.FindAll('Children', [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($w.Current.ProcessId -notin $pids) { continue }
    foreach ($t in $w.FindAll('Descendants', $tab)) { $t.Current.Name }
  }
}

# Every window open now goes on Clicky's never-close list for the test, so tidy-up tests can only
# close what the test itself opened.
function Protect-OpenWindows {
  Add-Type -Namespace LiveEnum -Name W -MemberDefinition '
    public delegate bool P(System.IntPtr h, System.IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(P f, System.IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);' -ErrorAction SilentlyContinue
  $list = New-Object System.Collections.Generic.List[string]
  [void][LiveEnum.W]::EnumWindows({ param($h, $l) if ([LiveEnum.W]::IsWindowVisible($h)) { $list.Add($h.ToInt64().ToString()) }; $true }, [IntPtr]::Zero)
  ConvertTo-Json @($list) | Set-Content $ProtectFile
  "protected $($list.Count) windows"
}
function Unprotect-Windows { Remove-Item $ProtectFile -ErrorAction SilentlyContinue }
function Test-Protected { $ids = Get-Content $ProtectFile -Raw | ConvertFrom-Json; ($ids | Where-Object { [LiveEnum.W]::IsWindowVisible([IntPtr][long]$_) }).Count }

# A Notepad window with typed, unsaved text. The text is only typed once that new Notepad is
# really in front (round 1 typed it into another app when Windows kept Notepad behind).
function New-UnsavedNotepad([string]$Text) {
  Add-Type -Namespace LiveNp -Name W -MemberDefinition '
    [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int p);' -ErrorAction SilentlyContinue
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $np = { $pids = (Get-Process notepad -ErrorAction SilentlyContinue).Id; @($root.FindAll('Children', [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ProcessId -in $pids } | ForEach-Object { $_.Current.NativeWindowHandle }) }
  $before = & $np
  Start-Process notepad.exe; Start-Sleep 2
  $new = (& $np) | Where-Object { $_ -notin $before } | Select-Object -First 1
  if (-not $new) { throw 'no new Notepad window' }
  for ($i = 0; $i -lt 5 -and [LiveNp.W]::GetForegroundWindow().ToInt64() -ne $new; $i++) {
    [LiveWin]::keybd_event(0x87, 0, 0, [UIntPtr]::Zero); [LiveWin]::keybd_event(0x87, 0, 2, [UIntPtr]::Zero)
    [void][LiveNp.W]::SetForegroundWindow([IntPtr]$new); Start-Sleep -Milliseconds 400
  }
  if ([LiveNp.W]::GetForegroundWindow().ToInt64() -ne $new) { throw 'the new Notepad would not come to the front; nothing typed' }
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait($Text)
  Start-Sleep 1
}
# Close the Notepad windows a test opened (never one on the protect list): WM_CLOSE, and if
# Notepad asks to save, "Don't save" (the text is the test's own).
function Close-TestNotepads {
  Add-Type -Namespace LiveClose -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);' -ErrorAction SilentlyContinue
  $keep = @(); if (Test-Path $ProtectFile) { $keep = @(Get-Content $ProtectFile -Raw | ConvertFrom-Json) }
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $pids = (Get-Process notepad -ErrorAction SilentlyContinue).Id
  foreach ($w in $root.FindAll('Children', [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($w.Current.ProcessId -notin $pids) { continue }
    $h = $w.Current.NativeWindowHandle
    if ("$h" -in $keep) { continue }
    [void][LiveClose.W]::PostMessage([IntPtr]$h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 700
    $dont = $w.FindFirst('Descendants', (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Don't save")))
    if ($dont) { $dont.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  }
}

# Close the tab a test opened in Comet (only when Comet is in front, on the page the test expects).
function Close-FrontTab([string]$Expect) {
  if ((Get-FrontProcess) -ne 'comet' -or [LiveWin]::Front() -notmatch $Expect) { return 'left' }
  [LiveWin]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); [LiveWin]::keybd_event(0x57, 0, 0, [UIntPtr]::Zero)
  [LiveWin]::keybd_event(0x57, 0, 2, [UIntPtr]::Zero); [LiveWin]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
  'closed'
}

# Windows a test leaves behind are closed after it (the owner asked Clicky twice to close the pile
# of windows the tests had opened). Before a task: Save-WindowSnapshot; after: Close-NewWindows.
$SnapshotFile = Join-Path $env:TEMP 'clicky-test-windows.txt'
function Get-TopWindows {
  Add-Type -Namespace LiveTop -Name W -MemberDefinition '
    public delegate bool P(System.IntPtr h, System.IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(P f, System.IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
    [DllImport("user32.dll")] public static extern System.IntPtr GetWindow(System.IntPtr h, uint c);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(System.IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);
    [DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);' -ErrorAction SilentlyContinue
  $list = New-Object System.Collections.Generic.List[object]
  [void][LiveTop.W]::EnumWindows({ param($h, $l)
      if ([LiveTop.W]::IsWindowVisible($h) -and [LiveTop.W]::GetWindow($h, 4) -eq [IntPtr]::Zero -and [LiveTop.W]::GetWindowTextLength($h) -gt 0) {
        $p = 0; [void][LiveTop.W]::GetWindowThreadProcessId($h, [ref]$p)
        $list.Add([pscustomobject]@{ Handle = $h.ToInt64(); Process = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName })
      }
      $true }, [IntPtr]::Zero)
  $list
}
$ProcSnapshotFile = Join-Path $env:TEMP 'clicky-test-procs.txt'
function Save-WindowSnapshot {
  (Get-TopWindows).Handle | Set-Content $SnapshotFile
  (Get-Process).Id | Set-Content $ProcSnapshotFile
}
# Leak check: closes the windows the task opened, then reports what it closed and any new processes
# still running afterwards with their memory (what the task left behind).
function Close-NewWindows {
  if (-not (Test-Path $SnapshotFile)) { return }
  $before = @(Get-Content $SnapshotFile)
  $skip = @('claude', 'Clicky', 'ShellExperienceHost', 'SearchHost', 'StartMenuExperienceHost', 'TextInputHost')
  $closed = @()
  foreach ($w in Get-TopWindows) {
    if ("$($w.Handle)" -in $before -or $w.Process -in $skip) { continue }
    # Only what the task itself touched: a window an unrelated app popped up meanwhile (MemGraph did)
    # is the owner's, so it stays. Browsers, Explorer and Store-app frames are Clicky's usual hosts.
    $hosts = @('explorer', 'ApplicationFrameHost', 'notepad', 'comet', 'msedge', 'chrome', 'WindowsTerminal', 'cmd', 'powershell', 'pwsh', 'Code')
    $log = Get-Content (Join-Path $env:TEMP 'clicky-task-log.txt') -Raw -ErrorAction SilentlyContinue
    if ($w.Process -notin $hosts -and -not ($log -and ($log -replace '\s', '').IndexOf(($w.Process -replace '\s', ''), [StringComparison]::OrdinalIgnoreCase) -ge 0)) { continue }
    [void][LiveTop.W]::PostMessage([IntPtr]$w.Handle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
    $closed += $w.Process
  }
  Start-Sleep 3
  $procsBefore = @(Get-Content $ProcSnapshotFile -ErrorAction SilentlyContinue)
  $noise = '^(conhost|powershell|pwsh|node|bash|git|WmiPrvSE|RuntimeBroker|backgroundTaskHost|dllhost|svchost|audiodg|SearchProtocolHost|SearchFilterHost|smartscreen|WerFault|cmd|tasklist|taskhostw|sihost|ctfmon|CompPkgSrv|UserOOBEBroker|LockApp)$'
  $left = Get-Process | Where-Object { "$($_.Id)" -notin $procsBefore -and $_.ProcessName -notin $skip -and $_.ProcessName -notmatch $noise }
  $leak = ($left | Group-Object ProcessName | ForEach-Object { '{0} x{1} {2:N0}MB' -f $_.Name, $_.Count, (($_.Group | Measure-Object WorkingSet64 -Sum).Sum / 1MB) }) -join ', '
  $names = ($closed | Sort-Object -Unique) -join ', '
  if (-not $leak) { $leak = 'nothing' }
  "closed $($closed.Count) windows ($names); left running: $leak"
}
