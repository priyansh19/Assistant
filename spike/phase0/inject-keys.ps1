# Injects Right Ctrl presses with keybd_event and records the times, so the spike
# can measure hook latency and confirm both key-down and key-up arrive.
param([int]$Presses = 5, [int]$HoldMs = 600)
$dir = $PSScriptRoot
Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);'
while (-not (Test-Path "$dir\.ready")) { Start-Sleep -Milliseconds 100 }
Start-Sleep -Milliseconds 300
$VK_RCONTROL = 0xA3; $EXTENDED = 0x1; $KEYUP = 0x2
$times = @()
for ($i = 0; $i -lt $Presses; $i++) {
  $d = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  [W.K]::keybd_event($VK_RCONTROL, 0x1D, $EXTENDED, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds $HoldMs
  $u = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  [W.K]::keybd_event($VK_RCONTROL, 0x1D, ($EXTENDED -bor $KEYUP), [UIntPtr]::Zero)
  $times += [pscustomobject]@{ down = $d; up = $u }
  Start-Sleep -Milliseconds 400
}
ConvertTo-Json -InputObject $times | Set-Content -Encoding utf8 "$dir\.inject-done"
