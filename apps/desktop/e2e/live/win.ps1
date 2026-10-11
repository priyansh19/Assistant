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
