import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
  public static void Text(string s) {
    foreach (char ch in s) {
      if (ch == '\r') continue;
      if (ch == '\n') { Send(new[] { Key(0x0D, 0, 0), Key(0x0D, 0, KEYUP) }); continue; }
      Send(new[] { Key(0, ch, UNICODE), Key(0, ch, UNICODE | KEYUP) });
    }
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

// One command per line: "<id> <verb> <args…>"; the reply is "<id> ok" or "<id> err <message>".
const LOOP = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  $id = $p[0]
  try {
    switch ($p[1]) {
      'click'  { [ClickyInput]::Click([int]$p[2], [int]$p[3], $p[4] -eq 'right', [int]$p[5]) }
      'scroll' { [ClickyInput]::Scroll([int]$p[2], [int]$p[3], [int]$p[4]) }
      'text'   { [ClickyInput]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2]))) }
      'keys'   { [ClickyInput]::Keys([int[]]($p[2].Split(',')), [bool[]]($p[3].Split(',') | ForEach-Object { $_ -eq '1' })) }
      default  { throw "unknown command $($p[1])" }
    }
    [Console]::Out.WriteLine("$id ok")
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

export function createWin32InputDriver(): InputDriver {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  function start(): Promise<void> {
    if (ready) return ready;
    const script = `Add-Type -TypeDefinition @'\n${CSHARP}\n'@\n${LOOP}`;
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
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
          if (m[2] === 'ok') p.resolve();
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

  async function send(cmd: string): Promise<void> {
    await start();
    const child = proc;
    if (!child) throw new Error('the input helper is not running');
    const id = nextId++;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('the input helper timed out'));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${id} ${cmd}\n`);
    });
  }

  const int = (n: number): number => Math.round(n);
  return {
    warm: () => void start().catch(() => undefined),
    click: (x, y, button, count) => send(`click ${int(x)} ${int(y)} ${button} ${count}`),
    scroll: (x, y, amount) => send(`scroll ${int(x)} ${int(y)} ${int(amount)}`),
    type: (text) => send(`text ${Buffer.from(text, 'utf8').toString('base64')}`),
    keys: (keys) => {
      const vks = keys.map(vkOf);
      return send(`keys ${vks.map((k) => k[0]).join(',')} ${vks.map((k) => (k[1] ? '1' : '0')).join(',')}`);
    },
    dispose: () => {
      proc?.kill();
      proc = null;
      ready = null;
    },
  };
}
