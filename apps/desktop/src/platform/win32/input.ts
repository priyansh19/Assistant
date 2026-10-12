import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InputDriver } from '../types';

/**
 * Mouse and keyboard for agent mode and dictation, via user32 SendInput. A single PowerShell
 * process compiles a small C# wrapper once (~1 s, done in the background at startup) and then runs
 * commands from stdin in a few milliseconds each. No native npm addon is needed.
 *
 * Coordinates are physical screen pixels; the process is per-monitor DPI aware so they aren't
 * rescaled. Text is sent as Unicode key events, so any language works and the clipboard is untouched.
 */
const CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class ClickyInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize; public int flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string name);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object obj);
  const uint KEYUP = 2, UNICODE = 4, EXTENDED = 1;
  static void Aware() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }
  static void Send(INPUT[] a) {
    if (SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))) != a.Length)
    { int e = Marshal.GetLastWin32Error();
      throw new Exception(e == 5 ? "Windows blocked the mouse and keyboard: the screen is locked or asleep, or an administrator window is in front" : "SendInput failed (error " + e + ")"); }
  }
  static INPUT Mouse(uint flags, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  public static void Move(int x, int y) { Aware(); SetCursorPos(x, y); }
  public static void Click(int x, int y, bool right, int count) {
    Move(x, y); Thread.Sleep(40);
    for (int c = 0; c < count; c++) {
      Send(new[] { Mouse(right ? 8u : 2u, 0), Mouse(right ? 16u : 4u, 0) });
      Thread.Sleep(60);
    }
  }
  public static void Scroll(int x, int y, int notches) {
    Move(x, y); Thread.Sleep(30);
    Send(new[] { Mouse(0x0800, unchecked((uint)(-notches * 120))) });
  }
  // Line breaks are Shift+Enter: a new line in chat apps and editors instead of "send".
  [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
  [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint ms);
  public static void Text(string s) {
    timeBeginPeriod(1); // so the pause between characters is ~10 ms, not the default ~16
    try { TextPaced(s); } finally { timeEndPeriod(1); }
  }
  static void TextPaced(string s) {
    var batch = new System.Collections.Generic.List<INPUT>();
    foreach (char ch in s) {
      if (ch == '\r') continue;
      if (ch == '\n') {
        // Apps like Windows 11 Notepad handle key presses and Unicode characters on different
        // paths, so a line break sent in the same burst as text can land before it. Let the text
        // arrive first, then send the line break on its own.
        if (batch.Count > 0) { Send(batch.ToArray()); batch.Clear(); Thread.Sleep(25); }
        Send(new[] { Key(0x10, 0, 0), Key(0x0D, 0, 0), Key(0x0D, 0, KEYUP), Key(0x10, 0, KEYUP) });
        Thread.Sleep(25);
        continue;
      }
      batch.Add(Key(0, ch, UNICODE)); batch.Add(Key(0, ch, UNICODE | KEYUP));
      // One character at a time, ~10 ms apart: Windows 11 Notepad (and other RichEdit apps) mix up
      // characters that arrive faster ("- Eggs" typed as "ssssss"), found by the live suite.
      if (batch.Count >= 2) { Send(batch.ToArray()); batch.Clear(); Thread.Sleep(8); }
    }
    if (batch.Count > 0) Send(batch.ToArray());
  }
  public static void Backspace(int n) {
    var batch = new System.Collections.Generic.List<INPUT>();
    for (int i = 0; i < n; i++) {
      batch.Add(Key(0x08, 0, 0)); batch.Add(Key(0x08, 0, KEYUP));
      if (batch.Count >= 120) { Send(batch.ToArray()); batch.Clear(); Thread.Sleep(2); }
    }
    if (batch.Count > 0) Send(batch.ToArray());
  }
  static string B64(string s) { return Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(s)); }
  // "<process> <title>", each base64 (the title can contain anything).
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  // Windows only lets the process that sent the last input bring a window to the front. A tap of
  // F24 (a key nothing uses) makes that this helper, which then passes the right on.
  public static void Grant() { Send(new[] { Key(0x87, 0, 0), Key(0x87, 0, KEYUP) }); AllowSetForegroundWindow(-1); }
  // Bring the first visible window whose title starts with this to the front (waits for it to appear).
  public static bool Front(string title, int ms) {
    var end = DateTime.Now.AddMilliseconds(ms);
    while (DateTime.Now < end) {
      IntPtr found = IntPtr.Zero;
      EnumWindows((h, l) => {
        if (!IsWindowVisible(h)) return true;
        var sb = new System.Text.StringBuilder(512); GetWindowText(h, sb, 512);
        var t = sb.ToString();
        if (t == title || t.StartsWith(title + " -")) { found = h; return false; }
        return true;
      }, IntPtr.Zero);
      if (found != IntPtr.Zero) {
        Grant();
        if (IsIconic(found)) ShowWindow(found, 9);
        SetForegroundWindow(found);
        return true;
      }
      Thread.Sleep(150);
    }
    return false;
  }
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
  // The windows a person would call open: visible, titled, not tool windows, not hidden (cloaked)
  // Store app frames. EnumWindows goes front to back. One line each: handle, process, title.
  public static string Windows() {
    var sb = new System.Text.StringBuilder();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      var t = new System.Text.StringBuilder(512); GetWindowText(h, t, 512);
      var title = t.ToString();
      if (title.Length == 0 || title == "Program Manager") return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string name = "";
      try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { }
      if (name == "clicky") return true;
      sb.Append(h.ToInt64()).Append(' ').Append(B64(name)).Append(' ').Append(B64(title)).Append(';');
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
  // After Clicky opens something: wait for a new window to come to the front, then maximise it so
  // the app fills the screen like the user expects (and the screenshots show all of it).
  // Windows that were open before Clicky opened something (taken with the foreground handle).
  static System.Collections.Generic.HashSet<long> before = new System.Collections.Generic.HashSet<long>();
  static System.Collections.Generic.Dictionary<long, string> titles = new System.Collections.Generic.Dictionary<long, string>();
  static string TitleOf(IntPtr h) { var sb = new System.Text.StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  static string ProcOf(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { return ""; }
  }
  static bool Real(IntPtr h) {
    if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero || GetWindowTextLength(h) == 0) return false;
    int c; if (DwmGetWindowAttribute(h, 14, out c, 4) == 0 && c != 0) return false;
    return ProcOf(h) != "clicky";
  }
  // After Clicky opens something, make sure it ends up in front and fills the screen: the window
  // that came to the front, or else a window that wasn't there before (Windows often opens new
  // apps behind the one in front), or else, for a website, the browser window.
  public static string MaximizeNew(long fg, int ms, string procs) {
    var want = procs.Split(',');
    var started = DateTime.Now;
    var end = started.AddMilliseconds(ms);
    while (DateTime.Now < end) {
      IntPtr h = GetForegroundWindow();
      if (h != IntPtr.Zero && h.ToInt64() != fg && Real(h)) { ShowWindow(h, 3); return ProcOf(h); }
      double waited = (DateTime.Now - started).TotalMilliseconds;
      IntPtr pick = IntPtr.Zero;
      if (waited > 600) {
        EnumWindows((w, l) => {
          if (Real(w) && !before.Contains(w.ToInt64())) { pick = w; return false; }
          return true;
        }, IntPtr.Zero);
      }
      if (pick == IntPtr.Zero && waited > 1500 && procs.Length > 0) {
        // The browser window whose title changed (the new tab opened there), else the first one.
        IntPtr first = IntPtr.Zero;
        EnumWindows((w, l) => {
          if (!Real(w) || Array.IndexOf(want, ProcOf(w)) < 0) return true;
          if (first == IntPtr.Zero) first = w;
          string old;
          if (titles.TryGetValue(w.ToInt64(), out old) && old != TitleOf(w)) { pick = w; return false; }
          return true;
        }, IntPtr.Zero);
        if (pick == IntPtr.Zero && waited > 2500) pick = first;
      }
      if (pick != IntPtr.Zero) {
        Grant();
        ShowWindow(pick, IsIconic(pick) ? 9 : 5);
        SetForegroundWindow(pick);
        ShowWindow(pick, 3);
        return ProcOf(pick);
      }
      Thread.Sleep(100);
    }
    return "";
  }
  [DllImport("user32.dll")] static extern short VkKeyScanEx(char ch, IntPtr layout);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  // True if the keyboard layout types common characters with AltGr (Right Alt), as Italian,
  // German or French layouts do: then Right Alt can't be a hold key.
  public static bool UsesAltGr() {
    uint pid; var layout = GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), out pid));
    foreach (var ch in "@#[]{}\\|~\u20ac") {
      short v = VkKeyScanEx(ch, layout);
      if (v != -1 && ((v >> 8) & 6) == 6) return true;
    }
    return false;
  }
  public static long ForegroundHandle() {
    before.Clear();
    titles.Clear();
    EnumWindows((w, l) => { before.Add(w.ToInt64()); titles[w.ToInt64()] = TitleOf(w); return true; }, IntPtr.Zero);
    return GetForegroundWindow().ToInt64();
  }
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  public static void CloseWindow(long h) { PostMessage(new IntPtr(h), 0x0010, IntPtr.Zero, IntPtr.Zero); }
  public static string Foreground() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "";
    uint pid; GetWindowThreadProcessId(h, out pid);
    string name = "";
    try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { }
    var sb = new System.Text.StringBuilder(512); GetWindowText(h, sb, 512);
    return B64(name) + " " + B64(sb.ToString());
  }
  // Words that describe a control rather than name it ("Comet browser icon" → "comet").
  static readonly string[] Generic = { "button", "icon", "app", "application", "browser", "the", "taskbar", "tab", "link", "menu", "on", "in", "item", "shortcut", "pinned", "window" };
  static string[] Tokens(string s) {
    var list = new System.Collections.Generic.List<string>();
    foreach (var w in System.Text.RegularExpressions.Regex.Split(s.ToLowerInvariant(), "[^a-z0-9]+"))
      if (w.Length >= 3 && Array.IndexOf(Generic, w) < 0) list.Add(w);
    return list.ToArray();
  }
  static bool Matches(System.Windows.Automation.AutomationElement e, string[] want) {
    string n;
    try { n = (e.Current.Name ?? "").ToLowerInvariant(); } catch { return false; }
    if (n.Length == 0 || want.Length == 0) return false;
    foreach (var t in want) if (n.Contains(t)) return true;
    return false;
  }
  // A strong match for a control found elsewhere on screen: its name is short and fully wanted
  // ("Minimize"), or it shares at least two words with the target ("Comet browser").
  static bool Strong(System.Windows.Automation.AutomationElement e, string[] want) {
    string n;
    try { n = (e.Current.Name ?? "").ToLowerInvariant(); } catch { return false; }
    var have = Tokens(n);
    if (have.Length == 0) return false;
    int hits = 0;
    foreach (var t in want) if (n.Contains(t)) hits++;
    int named = 0;
    foreach (var h in have) if (Array.IndexOf(want, h) >= 0) named++;
    return hits >= 2 || (named == have.Length && have.Length <= 2);
  }
  static bool Small(System.Windows.Automation.AutomationElement e) {
    try { var b = e.Current.BoundingRectangle; return !b.IsEmpty && b.Width <= 420 && b.Height <= 160; } catch { return false; }
  }
  // How far (physical px) a control may have moved and still be the one the model meant.
  const double MaxShift = 220;
  static string Center(System.Windows.Automation.AutomationElement e) {
    var r = e.Current.BoundingRectangle;
    if (r.IsEmpty || r.Width < 1) return "";
    return ((int)(r.X + r.Width / 2)) + " " + ((int)(r.Y + r.Height / 2));
  }
  // Where the control named "name" is right now (physical px "x y"), searching what's under the
  // point first, then the taskbar and the window in front; the match nearest the hint wins.
  public static string Locate(string name, int x, int y) {
    Aware();
    var want = Tokens(name);
    if (want.Length == 0) return "";
    try {
      var e = System.Windows.Automation.AutomationElement.FromPoint(new System.Windows.Point(x, y));
      for (int i = 0; e != null && i < 6; i++) {
        // Only a control-sized element: a window or pane that merely contains the word ("Claude"
        // in "the Minimize button of the Claude window") would move the click to its middle.
        if (Matches(e, want) && Small(e)) { var c = Center(e); if (c != "") return c; }
        e = System.Windows.Automation.TreeWalker.ControlViewWalker.GetParent(e);
      }
    } catch { }
    var cond = new System.Windows.Automation.OrCondition(
      new System.Windows.Automation.PropertyCondition(System.Windows.Automation.AutomationElement.ControlTypeProperty, System.Windows.Automation.ControlType.Button),
      new System.Windows.Automation.PropertyCondition(System.Windows.Automation.AutomationElement.ControlTypeProperty, System.Windows.Automation.ControlType.ListItem),
      new System.Windows.Automation.PropertyCondition(System.Windows.Automation.AutomationElement.ControlTypeProperty, System.Windows.Automation.ControlType.MenuItem),
      new System.Windows.Automation.PropertyCondition(System.Windows.Automation.AutomationElement.ControlTypeProperty, System.Windows.Automation.ControlType.TabItem),
      new System.Windows.Automation.PropertyCondition(System.Windows.Automation.AutomationElement.ControlTypeProperty, System.Windows.Automation.ControlType.Hyperlink),
      new System.Windows.Automation.PropertyCondition(System.Windows.Automation.AutomationElement.ControlTypeProperty, System.Windows.Automation.ControlType.Edit));
    string best = ""; double bestD = double.MaxValue;
    foreach (var h in new[] { FindWindow("Shell_TrayWnd", null), GetForegroundWindow() }) {
      if (h == IntPtr.Zero) continue;
      try {
        var all = System.Windows.Automation.AutomationElement.FromHandle(h).FindAll(System.Windows.Automation.TreeScope.Descendants, cond);
        int seen = 0;
        foreach (System.Windows.Automation.AutomationElement el in all) {
          if (++seen > 4000) break;
          if (!Strong(el, want) || !Small(el)) continue;
          var c = Center(el); if (c == "") continue;
          var p = c.Split(' '); double dx = int.Parse(p[0]) - x, dy = int.Parse(p[1]) - y; double d = dx * dx + dy * dy;
          if (d < bestD && d <= MaxShift * MaxShift) { bestD = d; best = c; }
        }
      } catch { }
    }
    return best;
  }

  // The text caret in physical screen pixels: "x y height", or "" when the app doesn't expose one.
  public static string Caret() {
    Aware();
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "";
    uint pid; uint tid = GetWindowThreadProcessId(h, out pid);
    var gi = new GUITHREADINFO(); gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(tid, ref gi)) return "";
    if (gi.hwndCaret != IntPtr.Zero && gi.rcCaret.Bottom > gi.rcCaret.Top) {
      var pt = new POINT(); pt.X = gi.rcCaret.Left; pt.Y = gi.rcCaret.Top;
      ClientToScreen(gi.hwndCaret, ref pt);
      return pt.X + " " + pt.Y + " " + (gi.rcCaret.Bottom - gi.rcCaret.Top);
    }
    // Browsers and Electron apps expose the caret through accessibility instead.
    IntPtr target = gi.hwndFocus != IntPtr.Zero ? gi.hwndFocus : h;
    try {
      Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
      object o;
      if (AccessibleObjectFromWindow(target, 0xFFFFFFF8, ref iid, out o) == 0 && o != null) {
        var acc = (Accessibility.IAccessible)o;
        int l, t, w, hh; acc.accLocation(out l, out t, out w, out hh, 0);
        if (hh > 0 && (l != 0 || t != 0)) return l + " " + t + " " + hh;
      }
    } catch { }
    return "";
  }
  public static void Keys(int[] vks, bool[] ext) {
    var down = new INPUT[vks.Length]; var up = new INPUT[vks.Length];
    for (int i = 0; i < vks.Length; i++) {
      uint f = ext[i] ? EXTENDED : 0;
      down[i] = Key((ushort)vks[i], 0, f);
      up[vks.Length - 1 - i] = Key((ushort)vks[i], 0, f | KEYUP);
    }
    Send(down); Thread.Sleep(30); Send(up);
  }
}`;

// One command per line: "<id> <verb> <args…>"; the reply is "<id> ok [data]" or "<id> err <message>".
const LOOP = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  $id = $p[0]
  $out = ''
  try {
    switch ($p[1]) {
      'click'  { [ClickyInput]::Click([int]$p[2], [int]$p[3], $p[4] -eq 'right', [int]$p[5]) }
      'scroll' { [ClickyInput]::Scroll([int]$p[2], [int]$p[3], [int]$p[4]) }
      'text'   { [ClickyInput]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2]))) }
      'keys'   { [ClickyInput]::Keys([int[]]($p[2].Split(',')), [bool[]]($p[3].Split(',') | ForEach-Object { $_ -eq '1' })) }
      'back'   { [ClickyInput]::Backspace([int]$p[2]) }
      'fg'     { $out = [ClickyInput]::Foreground() }
      'caret'  { $out = [ClickyInput]::Caret() }
      'locate' { $out = [ClickyInput]::Locate([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2])), [int]$p[3], [int]$p[4]) }
      'apps'   { $out = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress))) }
      'launch' { Start-Process ('shell:AppsFolder\' + [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2]))) }
      'windows' { $out = [ClickyInput]::Windows() }
      'altgr'   { $out = [ClickyInput]::UsesAltGr() }
      'fgh'     { $out = [ClickyInput]::ForegroundHandle() }
      'maxnew'  { $out = [ClickyInput]::MaximizeNew([long]$p[2], [int]$p[3], $(if ($p.Length -gt 4) { $p[4] } else { '' })) }
      'closewin' { [ClickyInput]::CloseWindow([long]$p[2]) }
      'folder' {
        $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2]))
        [ClickyInput]::Grant()
        Start-Process explorer.exe -ArgumentList ('"' + $path + '"')
        $out = [ClickyInput]::Front((Split-Path $path -Leaf), 4000)
      }
      default  { throw "unknown command $($p[1])" }
    }
    [Console]::Out.WriteLine("$id ok $out")
  } catch {
    $ex = $_.Exception
    while ($ex.InnerException) { $ex = $ex.InnerException }  # PowerShell wraps the C# exception
    [Console]::Out.WriteLine("$id err " + ($ex.Message -replace '\s+', ' '))
  }
  [Console]::Out.Flush()
}`;

const VK: Record<string, [number, boolean]> = {
  ctrl: [0x11, false],
  shift: [0x10, false],
  alt: [0x12, false],
  win: [0x5b, true],
  enter: [0x0d, false],
  tab: [0x09, false],
  esc: [0x1b, false],
  backspace: [0x08, false],
  delete: [0x2e, true],
  space: [0x20, false],
  up: [0x26, true],
  down: [0x28, true],
  left: [0x25, true],
  right: [0x27, true],
  home: [0x24, true],
  end: [0x23, true],
  pageup: [0x21, true],
  pagedown: [0x22, true],
  // An unassigned key: tapping it while Alt is held stops Windows opening the menu bar on release.
  mask: [0xe8, false],
};

function vkOf(key: string): [number, boolean] {
  const k = VK[key];
  if (k) return k;
  if (/^f([1-9]|1[0-2])$/.test(key)) return [0x6f + Number(key.slice(1)), false];
  if (/^[a-z0-9]$/.test(key)) return [key.toUpperCase().charCodeAt(0), false];
  throw new Error(`unknown key "${key}"`);
}

const START_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 20_000;

/**
 * The helper script, written to a temp file: passed inline (-EncodedCommand) it is UTF-16 and
 * base64, nearly three times its size, and Windows refuses command lines over 32,767 characters.
 */
function scriptFile(script: string): string {
  const hash = createHash('sha1').update(script).digest('hex').slice(0, 12);
  const file = join(tmpdir(), `clicky-input-${hash}.ps1`);
  // A byte-order mark so Windows PowerShell reads the file as UTF-8.
  writeFileSync(file, String.fromCharCode(0xfeff) + script, 'utf8');
  return file;
}

export function createWin32InputDriver(): InputDriver {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (data: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  function start(): Promise<void> {
    if (ready) return ready;
    const script = `Add-Type -ReferencedAssemblies Accessibility,UIAutomationClient,UIAutomationTypes,WindowsBase -TypeDefinition @'\n${CSHARP}\n'@\n${LOOP}`;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile(script)],
      { windowsHide: true },
    );
    proc = child;
    ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the input helper did not start')), START_TIMEOUT_MS);
      let buf = '';
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line === 'ready') {
            clearTimeout(timer);
            resolve();
            continue;
          }
          const m = /^(\d+) (ok|err)(?: (.*))?$/.exec(line);
          const p = m ? pending.get(Number(m[1])) : undefined;
          if (!m || !p) continue;
          pending.delete(Number(m[1]));
          clearTimeout(p.timer);
          if (m[2] === 'ok') p.resolve((m[3] ?? '').trim());
          else p.reject(new Error(m[3] ?? 'input failed'));
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        const e = new Error(`the input helper stopped (code ${code}) ${err.trim().slice(0, 300)}`);
        reject(e);
        for (const p of pending.values()) {
          clearTimeout(p.timer);
          p.reject(e);
        }
        pending.clear();
        if (proc === child) {
          proc = null;
          ready = null; // start again on the next command
        }
      });
    });
    ready.catch(() => undefined);
    return ready;
  }

  async function send(cmd: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
    await start();
    const child = proc;
    if (!child) throw new Error('the input helper is not running');
    const id = nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('the input helper timed out'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${id} ${cmd}\n`);
    });
  }
  const done = (p: Promise<string>): Promise<void> => p.then(() => undefined);
  const b64 = (s: string): string => Buffer.from(s, 'base64').toString('utf8');

  const int = (n: number): number => Math.round(n);
  return {
    warm: () => void start().catch(() => undefined),
    click: (x, y, button, count) => done(send(`click ${int(x)} ${int(y)} ${button} ${count}`)),
    scroll: (x, y, amount) => done(send(`scroll ${int(x)} ${int(y)} ${int(amount)}`)),
    // Typing is paced (~10 ms a character), so long text gets time to finish.
    type: (text) =>
      done(send(`text ${Buffer.from(text, 'utf8').toString('base64')}`, COMMAND_TIMEOUT_MS + text.length * 15)),
    backspace: (count) => done(send(`back ${Math.max(0, Math.min(20000, int(count)))}`)),
    foreground: async () => {
      const r = await send('fg');
      const [a, b] = r.split(' ');
      return a === undefined || a === '' ? null : { process: b64(a), title: b64(b ?? '') };
    },
    locate: async (name, x, y) => {
      const r = await send(`locate ${Buffer.from(name, 'utf8').toString('base64')} ${int(x)} ${int(y)}`);
      const [lx, ly] = r.split(' ').map(Number);
      return lx === undefined || ly === undefined || !Number.isFinite(lx + ly) ? null : { x: lx, y: ly };
    },
    apps: async () => {
      const raw = b64(await send('apps'));
      const parsed: unknown = JSON.parse(raw || '[]');
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .filter(
          (a): a is { Name: string; AppID: string } => typeof a?.Name === 'string' && typeof a?.AppID === 'string',
        )
        .map((a) => ({ name: a.Name, id: a.AppID }));
    },
    launch: (id) => done(send(`launch ${Buffer.from(id, 'utf8').toString('base64')}`)),
    windows: async () => {
      const raw = await send('windows');
      return raw
        .split(';')
        .filter(Boolean)
        .map((line) => {
          const [handle = '', proc = '', title = ''] = line.split(' ');
          return { handle, process: b64(proc), title: b64(title) };
        });
    },
    foregroundHandle: async () => (await send('fgh')).trim(),
    maximizeNew: async (before, ms, procs = '') =>
      void (await send(
        `maxnew ${/^\d+$/.test(before) ? before : '0'} ${Math.max(200, Math.min(8000, int(ms)))} ${procs.replace(/[^a-z0-9,]/gi, '')}`,
      )),
    usesAltGr: async () => (await send('altgr')).trim().toLowerCase() === 'true',
    closeWindow: (handle) => done(send(`closewin ${/^\d+$/.test(handle) ? handle : '0'}`)),
    openFolder: (path) => done(send(`folder ${Buffer.from(path, 'utf8').toString('base64')}`)),
    caret: async () => {
      const [x, y, h] = (await send('caret')).split(' ').map(Number);
      return x === undefined || y === undefined || h === undefined || !Number.isFinite(x + y + h)
        ? null
        : { x, y, height: h };
    },
    keys: (keys) => {
      const vks = keys.map(vkOf);
      return done(send(`keys ${vks.map((k) => k[0]).join(',')} ${vks.map((k) => (k[1] ? '1' : '0')).join(',')}`));
    },
    dispose: () => {
      proc?.kill();
      proc = null;
      ready = null;
    },
  };
}
