# Performance A/B measurement for Smart Counter Island (ASCII only: PS 5.1 safe)
# Usage: powershell -ExecutionPolicy Bypass -File scripts/measure-perf.ps1 -Exe <path> -Label <name> -Mode <expanded|hidden>
#   -Mode expanded : default behaviour (banner visible, glass capture active)
#   -Mode hidden   : manual.mode=hidden -> island stays a slim strip (fast path)
# Measures: time until the island window becomes visible, process-tree working set
# and total CPU seconds after N seconds of steady state.
# Uses SCI_USER_DATA so the real user settings.json is never touched.

param(
  [Parameter(Mandatory=$true)][string]$Exe,
  [Parameter(Mandatory=$true)][string]$Label,
  [ValidateSet('expanded','hidden')][string]$Mode = 'expanded',
  [int]$Seconds = 22,
  [double]$BgRefreshSec = 1.6,
  [string]$GlassMode = 'liquid',
  [int]$GpuFps = 30
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SciWinEnum {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static bool HasVisible(uint target) {
    bool found = false;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h)) { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$exePath = (Resolve-Path $Exe).Path
# SCI_USER_DATA gives the app an isolated config dir - the real settings.json is never touched
$ud = Join-Path $env:TEMP 'sci-perf-userdata'
Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $ud | Out-Null
$cfgFile = Join-Path $ud 'settings.json'
$cfg = @{
  ui = @{ glassMode = $GlassMode; autoStart = $false; alwaysOnTop = $true; showSeconds = $true; stripStyle = 'black'; gpuGlassFps = $GpuFps }
  smart = @{ zoomIdleSec = 0; notifyEnabled = $true; hideOnFullscreen = $true; expandIdleSec = 4; bgRefreshSec = $BgRefreshSec }
  manual = @{ mode = $Mode }
} | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($cfgFile, $cfg, (New-Object System.Text.UTF8Encoding($false)))
$env:SCI_USER_DATA = $ud

try {
  Get-Process -Name 'SmartCounterIsland*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $exePath -PassThru
  # --- time to first visible window of this pid ---
  $visibleMs = -1
  while ($sw.Elapsed.TotalSeconds -lt 15) {
    if ([SciWinEnum]::HasVisible([uint32]$p.Id)) { $visibleMs = [int]$sw.Elapsed.TotalMilliseconds; break }
    Start-Sleep -Milliseconds 15
  }
  # --- steady state sample ---
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if ($p.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  $procs = @(Get-Process -Name 'SmartCounterIsland*' -ErrorAction SilentlyContinue)
  $ws = 0; $cpu = 0.0; $n = 0; $priv = 0
  foreach ($q in $procs) { $ws += $q.WorkingSet64; $priv += $q.PrivateMemorySize64; $cpu += $q.TotalProcessorTime.TotalSeconds; $n++ }
  $alive = -not $p.HasExited

  # --- per-role CPU breakdown (Chromium main/renderer/gpu/utility + PowerShell probe) ---
  $roles = [ordered]@{}
  $pwshCpu = 0.0
  try {
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    foreach ($q in $all) {
      if ($q.Name -eq 'powershell.exe' -or $q.Name -eq 'pwsh.exe') {
        # the probe is a long-running PowerShell child; skip this script itself
        if ($q.ProcessId -ne $PID -and $q.CommandLine -like '*win-probe*') {
          $pwshCpu += ($q.UserModeTime + $q.KernelModeTime) / 10000000
        }
        continue
      }
      if ($q.Name -ne 'SmartCounterIsland.exe') { continue }
      $role = 'main'
      if ($q.CommandLine -like '*--type=renderer*') { $role = 'renderer' }
      elseif ($q.CommandLine -like '*--type=gpu-process*') { $role = 'gpu' }
      elseif ($q.CommandLine -like '*--type=utility*') { $role = 'utility' }
      if (-not $roles.Contains($role)) { $roles[$role] = 0.0 }
      $roles[$role] += ($q.UserModeTime + $q.KernelModeTime) / 10000000
    }
  } catch {
    # ignore transient/permission errors: role breakdown is extra info only
  }
  $roleCpu = [ordered]@{}
  foreach ($k in $roles.Keys) { $roleCpu[$k] = [math]::Round($roles[$k], 2) }
  $roleCpu['probe(powershell)'] = [math]::Round($pwshCpu, 2)

  $result = [ordered]@{
    label        = $Label
    mode         = $Mode
    visibleMs    = $visibleMs
    procs        = $n
    workingSetMB = [math]::Round($ws / 1MB, 1)
    privateMB    = [math]::Round($priv / 1MB, 1)
    cpuSeconds   = [math]::Round($cpu, 2)
    cpuPercent1Core = [math]::Round(($cpu / $Seconds) * 100, 2)
    cpuByRole    = $roleCpu
    alive        = $alive
  }
  $result | ConvertTo-Json -Compress
  $out = Join-Path $env:TEMP ("sci-perf-{0}-{1}.json" -f $Label, $Mode)
  [System.IO.File]::WriteAllText($out, ($result | ConvertTo-Json))
} finally {
  Get-Process -Name 'SmartCounterIsland*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Remove-Item Env:\SCI_USER_DATA -ErrorAction SilentlyContinue
  Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
}
