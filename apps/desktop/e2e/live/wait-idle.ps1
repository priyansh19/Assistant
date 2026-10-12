# Waits until nobody has touched the mouse or keyboard for -Seconds (default 120), so a live test
# never talks over the user. Gives up after -MaxMinutes and exits 1.
#   powershell -File wait-idle.ps1 -Seconds 120
param([int]$Seconds = 120, [int]$MaxMinutes = 90)
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Idle {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
  public static double Seconds() {
    var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i);
    return ((uint)Environment.TickCount - i.dwTime) / 1000.0;
  }
}
'@
$end = (Get-Date).AddMinutes($MaxMinutes)
while ((Get-Date) -lt $end) {
  if ([Idle]::Seconds() -ge $Seconds) { "idle $([int][Idle]::Seconds()) s"; exit 0 }
  Start-Sleep 5
}
"still busy after $MaxMinutes minutes"; exit 1
