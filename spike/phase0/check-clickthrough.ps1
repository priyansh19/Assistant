# Checks that the overlay is click-through: WindowFromPoint at several points (including
# the taskbar strip) must return a window that is NOT one of the overlay windows.
param([string]$ResultsPath = "$PSScriptRoot\results.json")
Add-Type -Namespace W -Name U -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
[W.U]::SetProcessDPIAware() | Out-Null  # work in physical pixels
$r = Get-Content $ResultsPath -Raw | ConvertFrom-Json
$overlayHwnds = @($r.overlayWindows | ForEach-Object { [int64]$_.hwnd })
$out = @()
foreach ($o in $r.overlayWindows) {
  $hwnd = [IntPtr][int64]$o.hwnd
  $ex = [W.U]::GetWindowLong($hwnd, -20)
  $out += [pscustomobject]@{ check = "exstyle $($o.displayId)"; layered = [bool]($ex -band 0x80000); transparent = [bool]($ex -band 0x20); topmost = [bool]($ex -band 0x8); noactivate = [bool]($ex -band 0x8000000) }
}
foreach ($d in $r.displays) {
  $sx = $d.scaleFactor
  $pts = @(@(0.5, 0.5), @(0.1, 0.1), @(0.5, 0.985))  # centre, top-left, taskbar strip
  foreach ($p in $pts) {
    $pt = New-Object W.U+POINT
    $pt.X = [int](($d.bounds.x + $d.bounds.width * $p[0]) * $sx); $pt.Y = [int](($d.bounds.y + $d.bounds.height * $p[1]) * $sx)
    $h = [W.U]::GetAncestor([W.U]::WindowFromPoint($pt), 2)
    $sb = New-Object System.Text.StringBuilder 256; [W.U]::GetClassName($h, $sb, 256) | Out-Null
    $out += [pscustomobject]@{ check = "point $($pt.X),$($pt.Y)"; hitWindow = $sb.ToString(); hitIsOverlay = ($overlayHwnds -contains [int64]$h) }
  }
}
$out | Format-List | Out-String

