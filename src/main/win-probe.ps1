# Smart Counter Island - system probe (ASCII-only, locale-safe)
# Spawned by the Electron main process with -Sta (UI Automation requires STA).
# Tasks:
#   1) stdin line "probe" -> JSON line (fg window, cursor, last input, toasts list)
#   2) poll %TEMP%\sci-region-cmd.txt  -> SetWindowRgn rounded hit-region
#   3) poll %TEMP%\sci-exclude-cmd.txt -> SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
#   4) poll %TEMP%\sci-transparent-cmd.txt -> SetWindowLongPtr WS_EX_TRANSPARENT toggle
# NOTE: keep this file pure ASCII - PowerShell 5.1 reads BOM-less scripts as ANSI/GBK.
$ErrorActionPreference = 'SilentlyContinue'

$code = @"
using System;
using System.Runtime.InteropServices;
public static class Probe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] public static extern bool SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int nLeftRect, int nTopRect, int nRightRect, int nBottomRect, int nWidthEllipse, int nHeightEllipse);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
}
"@
Add-Type -TypeDefinition $code
Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$regionFile = Join-Path $env:TEMP 'sci-region-cmd.txt'
$excludeFile = Join-Path $env:TEMP 'sci-exclude-cmd.txt'
$ptFile = Join-Path $env:TEMP 'sci-transparent-cmd.txt'
$script:toastCounter = 0
$script:toasts = @()
$script:notifFp = @{}
$script:notifSweep = 0
$script:BLACKLIST = @(
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow', 'XamlExplorerHostIslandWindow',
  '#32770', 'ConsoleWindowClass', 'DV2ControlHost', 'NotifyIconOverflowWindow'
)

# -- read notification text from ShellExperienceHost window via UI Automation --
function Get-NotificationText([intptr]$hwnd) {
  try {
    $ae = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $ae) { return '' }
    $name = [string]$ae.Current.Name
    if ($name -eq '') { return '' }
    $body = ''
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
    $texts = $ae.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($texts) {
      foreach ($t in $texts) {
        $n = [string]$t.Current.Name
        if ($n -ne '') { $body += $n + ' ' }
      }
    }
    return ($name + '|' + $body.Trim())
  } catch {
    return ''
  }
}

# -- enumerate visible ShellExperienceHost windows (toast host) --
# Only "Windows.UI.Core.CoreWindow" windows are toast notifications;
# this excludes volume/brightness flyouts and other shell overlays.
function Get-Toasts {
  $result = @()
  $exp = Get-Process -Name 'ShellExperienceHost' -ErrorAction SilentlyContinue
  if (-not $exp) { return $result }
  $pids = @{}
  foreach ($p in $exp) { $pids[$p.Id] = $true }
  $found = [System.Collections.ArrayList]::new()
  $callback = [Probe+EnumWindowsProc]{
    param($h, $l)
    $pid2 = 0
    [Probe]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    if ($pids.ContainsKey([int]$pid2)) {
      if ([Probe]::IsWindowVisible($h)) {
        $sb = New-Object System.Text.StringBuilder 256
        [void][Probe]::GetClassName($h, $sb, 256)
        if ($sb.ToString() -eq 'Windows.UI.Core.CoreWindow') {
          [void]$found.Add($h)
        }
      }
    }
    return $true
  }
  [Probe]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  foreach ($h in $found) {
    $info = Get-NotificationText($h)
    if ($info -ne '') {
      $result += ($h.ToInt64().ToString() + '|' + $info)
    }
  }
  return $result
}

# -- generic notification windows (QQ NT / WeChat / any topmost small bubble) --
# Enumerate ALL visible topmost windows that are notification-sized (not fullscreen,
# not ours, not shell chrome, not cloaked). A candidate is reported only when its
# fingerprint (rect + window title) CHANGES - so a reused hwnd (QQ NT reuses its
# bubble window per message) is still detected as a new notification. Text is read
# via UI Automation; the main process dedupes by hwnd + full text.
function Get-GenericNotifs {
  $result = @()
  $myPid = 0
  try { $myPid = [int]$env:LGC_PID } catch { $myPid = 0 }
  $found = [System.Collections.ArrayList]::new()
  $callback = [Probe+EnumWindowsProc]{
    param($h, $l)
    $winPid = 0
    [Probe]::GetWindowThreadProcessId($h, [ref]$winPid) | Out-Null
    if ($winPid -eq $myPid) { return $true }
    if (-not [Probe]::IsWindowVisible($h)) { return $true }
    $sb = New-Object System.Text.StringBuilder 256
    [void][Probe]::GetClassName($h, $sb, 256)
    $cls = $sb.ToString()
    if ($script:BLACKLIST -contains $cls) { return $true }
    $ex = [Probe]::GetWindowLongPtr($h, -20).ToInt64()
    if (($ex -band 0x8) -eq 0) { return $true } # require WS_EX_TOPMOST (notification bubbles are topmost)
    $r = [Probe+RECT]::new()
    if (-not [Probe]::GetWindowRect($h, [ref]$r)) { return $true }
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    if ($w -lt 100 -or $w -gt 720 -or $hh -lt 40 -or $hh -gt 520) { return $true }
    $cloaked = 0
    [void][Probe]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4) # DWMWA_CLOAKED=14
    if ($cloaked -ne 0) { return $true }
    $sb2 = New-Object System.Text.StringBuilder 256
    [void][Probe]::GetWindowText($h, $sb2, 256)
    $key = $h.ToInt64().ToString()
    $fp = "$($r.Left),$($r.Top),$w,$hh|$($sb2.ToString())"
    if ($script:notifFp.ContainsKey($key) -and $script:notifFp[$key] -eq $fp) { return $true }
    $script:notifFp[$key] = $fp
    [void]$found.Add($h)
    return $true
  }
  [Probe]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  # sweep dead window entries every 25 cycles
  $script:notifSweep += 1
  if ($script:notifSweep -ge 25) {
    $script:notifSweep = 0
    $dead = @()
    foreach ($k in $script:notifFp.Keys) {
      if (-not [Probe]::IsWindow([intptr][int64]$k)) { $dead += $k }
    }
    foreach ($k in $dead) { [void]$script:notifFp.Remove($k) }
  }
  foreach ($h in $found) {
    $info = Get-NotificationText($h)
    if ($info -ne '') {
      $result += ($h.ToInt64().ToString() + '|' + $info)
    }
  }
  return $result
}

while ($true) {
  # -- rounded hit-region command --
  if (Test-Path -LiteralPath $regionFile) {
    try {
      $content = (Get-Content -LiteralPath $regionFile -Raw).Trim()
      $parts = $content.Split(' ')
      if ($parts.Length -ge 6) {
        $hwnd = [intptr][int64]$parts[0]
        $x = [int]$parts[1]
        $y = [int]$parts[2]
        $w = [int]$parts[3]
        $h = [int]$parts[4]
        $r = [int]$parts[5]
        if ($r -lt 1) { $r = 1 }
        $rgn = [Probe]::CreateRoundRectRgn($x, $y, ($x + $w), ($y + $h), $r, $r)
        if ($rgn -ne [intptr]::Zero) {
          [Probe]::SetWindowRgn($hwnd, $rgn, $true) | Out-Null
        }
      }
      Remove-Item -LiteralPath $regionFile -Force -ErrorAction SilentlyContinue
    } catch {
      Remove-Item -LiteralPath $regionFile -Force -ErrorAction SilentlyContinue
    }
  }

  # -- exclude-from-capture command (WDA_EXCLUDEFROMCAPTURE = 0x11) --
  if (Test-Path -LiteralPath $excludeFile) {
    try {
      $content = (Get-Content -LiteralPath $excludeFile -Raw).Trim()
      if ($content.Length -gt 0) {
        $hwnd = [intptr][int64]$content
        [Probe]::SetWindowDisplayAffinity($hwnd, 0x11) | Out-Null
      }
      Remove-Item -LiteralPath $excludeFile -Force -ErrorAction SilentlyContinue
    } catch {
      Remove-Item -LiteralPath $excludeFile -Force -ErrorAction SilentlyContinue
    }
  }

  # -- mouse passthrough command (WS_EX_TRANSPARENT = 0x20; content "hwnd 0|1") --
  if (Test-Path -LiteralPath $ptFile) {
    try {
      $content = (Get-Content -LiteralPath $ptFile -Raw).Trim()
      $parts = $content.Split(' ')
      if ($parts.Length -ge 2) {
        $hwnd = [intptr][int64]$parts[0]
        $on = ($parts[1] -eq '1')
        $cur = [Probe]::GetWindowLongPtr($hwnd, -20).ToInt64()
        $new = 0
        if ($on) { $new = $cur -bor 0x20 } else { $new = $cur -band (-bnot 0x20) }
        if ($new -ne $cur) {
          [void][Probe]::SetWindowLongPtr($hwnd, -20, [intptr]$new)
        }
      }
      Remove-Item -LiteralPath $ptFile -Force -ErrorAction SilentlyContinue
    } catch {
      Remove-Item -LiteralPath $ptFile -Force -ErrorAction SilentlyContinue
    }
  }

  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq 'quit') { break }
  if ($line -ne 'probe') { continue }

  $fg = [Probe]::GetForegroundWindow()
  $r = [Probe+RECT]::new()
  $ok = [Probe]::GetWindowRect($fg, [ref]$r)
  $vis = [Probe]::IsWindowVisible($fg)
  $procId = 0
  [Probe]::GetWindowThreadProcessId($fg, [ref]$procId) | Out-Null
  $p = [Probe+POINT]::new()
  [Probe]::GetCursorPos([ref]$p) | Out-Null
  $li = [Probe+LASTINPUTINFO]::new()
  $li.cbSize = 8
  $gotLi = [Probe]::GetLastInputInfo([ref]$li)
  if ($gotLi) { $liVal = $li.dwTime } else { $liVal = 0 }

  # -- toast check: shell toasts every 5 probes (~1.75s), generic bubbles every probe --
  $script:toastCounter += 1
  if ($script:toastCounter -ge 5) {
    $script:toastCounter = 0
    $script:toasts = Get-Toasts
  }
  $script:toasts += Get-GenericNotifs

  $rect = $null
  if ($ok) {
    $rect = @{ l = $r.Left; t = $r.Top; r = $r.Right; b = $r.Bottom }
  }
  $o = [ordered]@{
    fg     = $fg.ToInt64()
    vis    = [bool]$vis
    pid    = $procId
    rect   = $rect
    cx     = $p.X
    cy     = $p.Y
    li     = $liVal
    tick   = [Environment]::TickCount
    toasts = $script:toasts
  }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
